/**
 * `POST /api/reports/:id/evidence` — one photograph, original bytes (§10, F3).
 *
 * Three rules the rest of F3 rests on:
 *
 *  - **The device's numbers are claims, the server's are facts.** The handset
 *    sends its own SHA-256 and dHash; both are stored, neither is trusted. The
 *    server recomputes from the bytes that actually arrived, and only the
 *    server's dHash ever enters the L1 corpus. A phone that lies about its hash
 *    changes nothing except its own trust score.
 *  - **A mismatch is a flag, not a rejection.** The score routes review; it
 *    never blocks a submission (PRD F3). The only check that blocks is §9's
 *    signature, because an unsigned report has no author.
 *  - **Originals are stored unmodified.** The thumbnail is a separate object
 *    under its own key. Re-encoding the original in place would destroy the one
 *    property that makes hashing it worth anything.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { bands, dhash, toHex } from '@nirikshan/core/dhash';
import { fail } from './auth.js';
import { add as addToCorpus } from './corpus.js';
import { Assignment, EvidenceItem, InspectionReport } from './models.js';
import * as storage from './storage.js';

/** A quality-0.8 handset photo is 2–4 MB; past this it is not a photograph. */
const MAX_BYTES = 12 * 1024 * 1024;
const THUMB_WIDTH = 320;

/**
 * Multipart without a dependency: undici parses it and Node ships undici. Any
 * body-parser here would be a second implementation of `Response.formData()`.
 */
function readForm(req) {
  const contentType = req.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) return null;
  return new Response(Readable.toWeb(req), { headers: { 'content-type': contentType } }).formData();
}

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const thumbKey = (storageKey) => storageKey.replace(/^evidence\//, 'thumbnails/');

const keyFor = (id, at) =>
  `evidence/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}/${id}.jpg`;

/**
 * The server pixel adapter. `fit: 'fill'` stretches to exactly 9×8 rather than
 * cropping, which is what the handset's resize does — a cropped server hash
 * would differ from the device's by far more than L9 could ever threshold.
 *
 * ponytail: no `.rotate()`, so an EXIF-rotated original hashes as stored. The
 * mobile adapter does not rotate either, so the two still agree; revisit if
 * §11's fixture measurement shows orientation is where the distance comes from.
 */
async function serverDHash(bytes) {
  const grey = await sharp(bytes).resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer();
  return dhash(grey);
}

const view = (item, deviceSha256) => ({
  id: item.id,
  reportId: item.reportId.toString(),
  storageKey: item.storageKey,
  thumbnailUrl: item.thumbnailUrl,
  sha256: item.sha256,
  // null on a replay: the original claim was scored when it was first stored.
  deviceSha256Match: deviceSha256 ? deviceSha256 === item.sha256 : null,
  dHash: item.dHash,
  deviceDHash: item.deviceDHash ?? null,
  capturedAt: item.capturedAt,
  location: item.location,
  flags: item.flags,
});

export async function postEvidence(req, res) {
  const report = await InspectionReport.findById(req.params.id);
  if (!report) return fail(res, 404, 'NOT_FOUND', `No report with id ${req.params.id}.`);

  // Scoped through the assignment to the token's inspector, never to the body.
  const assignment = await Assignment.findById(report.assignmentId);
  if (assignment?.inspectorId.toString() !== req.user.inspectorId) {
    return fail(res, 403, 'OUT_OF_SCOPE', 'That report belongs to another inspector.');
  }

  if (Number(req.get('content-length')) > MAX_BYTES) {
    return fail(res, 413, 'VALIDATION_FAILED', `Evidence may be at most ${MAX_BYTES} bytes.`);
  }

  const form = await readForm(req);
  if (!form) return fail(res, 400, 'VALIDATION_FAILED', 'multipart/form-data is required.');

  const file = form.get('file');
  if (typeof file?.arrayBuffer !== 'function') {
    return fail(res, 400, 'VALIDATION_FAILED', 'A file part is required.');
  }
  const clientId = form.get('clientId');
  if (!clientId) return fail(res, 400, 'VALIDATION_FAILED', 'clientId is required.');

  // Before decoding anything: a retried upload must cost nothing and store
  // nothing twice. Same rule as §9's report intake, same reason — the handset
  // that lost the response is the one that retries.
  const replay = await EvidenceItem.findOne({ reportId: report._id, clientId });
  if (replay) return res.status(201).json(view(replay, null));

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) return fail(res, 400, 'VALIDATION_FAILED', 'The file part is empty.');
  if (bytes.length > MAX_BYTES) {
    return fail(res, 413, 'VALIDATION_FAILED', `Evidence may be at most ${MAX_BYTES} bytes.`);
  }

  let hash;
  try {
    hash = await serverDHash(bytes);
  } catch {
    return fail(res, 400, 'VALIDATION_FAILED', 'The file is not a decodable image.');
  }

  const deviceSha256 = form.get('sha256');
  const capturedAt = form.get('capturedAt') ? new Date(form.get('capturedAt')) : new Date();

  let location;
  try {
    location = form.get('location') ? JSON.parse(form.get('location')) : null;
  } catch {
    return fail(res, 400, 'VALIDATION_FAILED', 'location must be a JSON object.');
  }

  const sha256 = sha256Hex(bytes);
  const item = new EvidenceItem({
    reportId: report._id,
    clientId,
    // Replaced below — the key carries the id, and the id exists as soon as the
    // document is constructed rather than when it is saved.
    storageKey: 'pending',
    sha256,
    dHash: toHex(hash),
    deviceDHash: form.get('deviceDHash') || null,
    dHashBands: bands(hash),
    capturedAt,
    location: location && { type: 'Point', ...location },
    // Recorded, never enforced: the device claimed a different hash for the
    // bytes it says it sent, which is a fact for a reviewer, not a rejection.
    flags: deviceSha256 && deviceSha256 !== sha256 ? ['DEVICE_SHA256_MISMATCH'] : [],
  });
  item.storageKey = keyFor(item.id, capturedAt);
  item.thumbnailUrl = `/api/evidence/${item.id}/thumbnail`;

  // Bytes first: a row pointing at an object that was never written is worse
  // than an object no row points at.
  await storage.put(item.storageKey, bytes);
  await storage.put(
    thumbKey(item.storageKey),
    await sharp(bytes)
      .resize(THUMB_WIDTH, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer(),
  );

  const saved = await item.save().catch((err) => {
    // Two drains of the same outbox row raced; the unique index arbitrates.
    if (err.code === 11000) return null;
    throw err;
  });
  if (!saved) {
    return res
      .status(201)
      .json(view(await EvidenceItem.findOne({ reportId: report._id, clientId }), null));
  }

  await addToCorpus({ hash, evidenceId: item.id, reportId: report.id });
  return res.status(201).json(view(item, deviceSha256));
}

/** `GET /api/evidence/:id/thumbnail` — the read path §13's dashboard needs. */
export async function getThumbnail(req, res) {
  const item = await EvidenceItem.findById(req.params.id);
  if (!item) return fail(res, 404, 'NOT_FOUND', `No evidence with id ${req.params.id}.`);
  return res.type('image/jpeg').send(await storage.get(thumbKey(item.storageKey)));
}
