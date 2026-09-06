/**
 * `POST /api/reports` — the offline outbox drains here (§9, PRD F2).
 *
 * Three properties the field demands, in order of how badly they bite:
 *
 *  - **Idempotent per report, not per batch.** A phone that loses the response
 *    retries; `clientId` carries a unique index, so the second attempt collides
 *    in the database rather than duplicating an inspection. That is stronger
 *    than keying on the `Idempotency-Key` header, which cannot survive a batch
 *    the client re-cuts after a partial failure.
 *  - **Per-item results.** One bad report must not reject nine good ones, so
 *    every item gets its own `status` and the batch still returns 201.
 *  - **Signature checked, not flagged.** The evidence hashes of §10 are flags —
 *    a score routes review, it does not block. This one is different: the HMAC
 *    is what says the report came from the handset that logged in, and an
 *    unsigned report has no author.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { deviceHmacKey, fail } from './auth.js';
import { Assignment, InspectionReport } from './models.js';

/** One field round of a cycle is tens of reports; a batch larger than this is a bug. */
const MAX_BATCH = 50;

class Rejected extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const reject = (code, message) => {
  throw new Rejected(code, message);
};

/**
 * The signature the device should have produced.
 *
 * The key is the hex string issued at login, used as key *material* rather than
 * decoded to bytes, because that is what a phone can do without a byte-level
 * HMAC API. `apps/mobile/lib/sign.js` does the same thing the same way; the two
 * only agree because they agree about this.
 */
const expectedSignature = (key, report) =>
  createHmac('sha256', key).update(canonicalJSON(reportSignaturePayload(report)), 'utf8').digest('hex');

/** Constant-time hex compare — a signature check that leaks timing is not one. */
function signatureMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

async function intake(report, user) {
  const { clientId, assignmentId, signature } = report ?? {};
  if (!clientId) reject('VALIDATION_FAILED', 'clientId is required.');
  if (!assignmentId) reject('VALIDATION_FAILED', 'assignmentId is required.');
  if (!report.submittedAt) reject('VALIDATION_FAILED', 'submittedAt is required.');
  if (!Array.isArray(report.answers)) reject('VALIDATION_FAILED', 'answers must be an array.');

  const deviceId = report.deviceSignals?.deviceId;
  if (!deviceId) reject('VALIDATION_FAILED', 'deviceSignals.deviceId is required.');

  // Before any lookup: a replay must cost nothing and change nothing.
  const existing = await InspectionReport.findOne({ clientId });
  if (existing) return { reportId: existing.id, duplicate: true };

  // The key is re-derived from (token user, reported device), so a report
  // signed on one handset and replayed from another account fails here too.
  const key = deviceHmacKey(user.userId, deviceId);
  if (!signatureMatches(expectedSignature(key, report), signature)) {
    reject('BAD_SIGNATURE', 'Report signature does not verify for this device.');
  }

  const assignment = await Assignment.findById(assignmentId).catch(() =>
    reject('VALIDATION_FAILED', `Malformed assignmentId: ${assignmentId}`),
  );
  if (!assignment) reject('NOT_FOUND', `No assignment with id ${assignmentId}.`);
  // Scoped to the token's inspector, never to the body: the app that posts this
  // runs on a device its holder controls.
  if (assignment.inspectorId.toString() !== user.inspectorId) {
    reject('OUT_OF_SCOPE', 'That assignment belongs to another inspector.');
  }
  if (!['PENDING', 'OVERDUE'].includes(assignment.status)) {
    reject('ASSIGNMENT_CLOSED', `Assignment is ${assignment.status} and accepts no report.`);
  }

  const created = await InspectionReport.create({
    assignmentId: assignment._id,
    clientId,
    submittedAt: report.submittedAt,
    capturedOffline: Boolean(report.capturedOffline),
    deviceSignals: report.deviceSignals,
    gpsSeries: report.gpsSeries ?? [],
    answers: report.answers,
    signature,
  }).catch((err) => {
    // Two devices draining the same outbox row at once land here rather than
    // writing a second inspection — the unique index is the arbiter.
    if (err.code === 11000) return null;
    throw err;
  });
  if (!created) {
    const winner = await InspectionReport.findOne({ clientId });
    return { reportId: winner.id, duplicate: true };
  }

  assignment.status = 'SUBMITTED';
  // The precondition the ledger cares about is checked above: this is a PENDING
  // assignment moving forward, not an officer weakening a record (models.js).
  assignment.$locals.inspectionSubmitted = true;
  await assignment.save();

  return { reportId: created.id, duplicate: false };
}

export async function postReports(req, res) {
  if (!req.user.inspectorId) {
    return fail(res, 403, 'NO_INSPECTOR_PROFILE', 'This account has no inspector record.');
  }
  if (!req.get('idempotency-key')) {
    return fail(res, 400, 'VALIDATION_FAILED', 'An Idempotency-Key header is required.');
  }

  const reports = req.body?.reports;
  if (!Array.isArray(reports) || reports.length === 0) {
    return fail(res, 400, 'VALIDATION_FAILED', 'reports must be a non-empty array.');
  }
  if (reports.length > MAX_BATCH) {
    return fail(res, 400, 'VALIDATION_FAILED', `A batch may carry at most ${MAX_BATCH} reports.`);
  }

  const results = [];
  for (const report of reports) {
    try {
      const { reportId, duplicate } = await intake(report, req.user);
      results.push({
        clientId: report.clientId,
        reportId,
        status: 'ACCEPTED',
        duplicate,
        evidenceUploadUrls: Object.fromEntries(
          (report.evidenceClientIds ?? []).map((id) => [id, `/api/reports/${reportId}/evidence`]),
        ),
      });
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      results.push({
        clientId: report?.clientId ?? null,
        status: 'REJECTED',
        error: { code: err.code, message: err.message },
      });
    }
  }

  // 201 even when every item was rejected: the batch was received and the
  // client's retry decision is per item, which is what `results` tells it.
  return res.status(201).json({ results });
}
