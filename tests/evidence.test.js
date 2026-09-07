/**
 * §10/§11 acceptance: an upload round-trips with the original bytes intact, the
 * server's own hashes are the ones that count, and a recycled photograph is
 * flagged with a citation to the report it came from.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import {
  Assignment,
  EvidenceItem,
  InspectionCycle,
  Inspector,
  Institute,
  User,
} from '../apps/api/models.js';

const PASSWORD = 'test-only-password';
const DEVICE_ID = 'handset-under-test';
const UPLOADS = fileURLToPath(new URL('../fixtures/uploads/', import.meta.url));

let memoryServer;
let server;
let base;
let token;
let officerToken;
let key;
let assignments;
let institutes;
let firstUpload;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * A real JPEG, generated rather than committed — §12 owns the fixture corpus.
 *
 * Structure, not noise. A perceptual hash of gaussian noise moves by twenty-odd
 * bits under an ordinary re-encode, so a noise fixture would make L1 look flaky
 * when what is actually unrepresentative is the picture: a photograph of a
 * corridor has edges, and edges are what dHash survives on.
 */
function jpeg(seed) {
  const [width, height] = [96, 72];
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const v = 128 + 100 * Math.sin(x / 9 + seed * 3) * Math.cos(y / 7 + seed);
      raw[i] = v;
      raw[i + 1] = 255 - v;
      raw[i + 2] = (v + seed * 80) % 256;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function login(email) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, deviceId: DEVICE_ID }),
  });
  return res.json();
}

/** A signed report for one assignment, submitted through §9's real intake. */
async function submitReport(assignmentId, overrides = {}) {
  const report = {
    clientId: randomUUID(),
    assignmentId,
    submittedAt: '2026-10-08T11:24:00.000Z',
    capturedOffline: true,
    answers: [{ questionId: 'hostel.occupancy.headcount', value: 41 }],
    deviceSignals: { deviceId: DEVICE_ID, platform: 'android', rooted: false, emulator: false },
    gpsSeries: [
      { at: '2026-10-08T11:14:02.000Z', lat: 18.52, lng: 73.85, accuracyM: 8, mocked: false },
    ],
    ...overrides,
  };
  const signature = createHmac('sha256', key)
    .update(canonicalJSON(reportSignaturePayload(report)), 'utf8')
    .digest('hex');

  const res = await fetch(base + '/api/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ reports: [{ ...report, signature }] }),
  });
  const { results } = await res.json();
  assert.equal(results[0].status, 'ACCEPTED', JSON.stringify(results[0]));
  return results[0].reportId;
}

function upload(reportId, bytes, fields = {}) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/jpeg' }), 'shot.jpg');
  form.set('clientId', fields.clientId ?? randomUUID());
  form.set('sha256', fields.sha256 ?? sha256(bytes));
  form.set('capturedAt', fields.capturedAt ?? '2026-10-08T11:20:00.000Z');
  if (fields.deviceDHash) form.set('deviceDHash', fields.deviceDHash);
  if (fields.location) form.set('location', JSON.stringify(fields.location));

  return fetch(`${base}/api/reports/${reportId}/evidence`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

const trust = (reportId) =>
  fetch(`${base}/api/reports/${reportId}/trust`, {
    headers: { authorization: `Bearer ${officerToken}` },
  }).then((res) => res.json());

const factor = (body, id) => body.factors.find((f) => f.id === id);

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4';
  // No B2 credentials: the local backend is what this suite exercises.
  delete process.env.B2_KEY_ID;

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('nirikshan-evidence-test'));

  institutes = await Institute.create(
    [
      ['Original', [73.8567, 18.5204]],
      ['Reuse', [73.8571, 18.521]],
      ['Faraway', [77.209, 28.6139]], // Delhi — ~1150 km from Pune
      ['Spare', [73.86, 18.52]],
    ].map(([name, coordinates]) => ({
      name,
      schemeType: 'HOSTEL',
      district: 'Pune',
      state: 'Maharashtra',
      location: { type: 'Point', coordinates },
    })),
  );

  const inspector = await Inspector.create({ name: 'A. Sharma', homeDistrict: 'Pune' });
  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    {
      email: 'inspector@example.test',
      name: 'A. Sharma',
      role: 'INSPECTOR',
      passwordHash,
      inspectorId: inspector._id,
    },
    { email: 'officer@example.test', name: 'D. Officer', role: 'DISTRICT', passwordHash },
  ]);

  const cycle = await InspectionCycle.create({
    periodStart: new Date('2026-10-01'),
    periodEnd: new Date('2026-10-31'),
    commitmentHash: 'a'.repeat(64),
    seed: 'b'.repeat(64),
  });

  assignments = await Assignment.create(
    institutes.map((institute) => ({
      cycleId: cycle._id,
      instituteId: institute._id,
      inspectorId: inspector._id,
      allocationType: 'RANDOM',
      dueDate: new Date('2026-10-14'),
    })),
  );

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const auth = await login('inspector@example.test');
  token = auth.token;
  key = auth.deviceHmacKey;
  officerToken = (await login('officer@example.test')).token;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
  await rm(UPLOADS, { recursive: true, force: true });
});

test('§10 stores the original bytes unmodified and hashes them itself', async () => {
  const bytes = await jpeg(0);
  const reportId = await submitReport(assignments[0].id);

  const res = await upload(reportId, bytes, {
    deviceDHash: 'ffffffffffffffff',
    location: { coordinates: [73.8567, 18.5204], accuracyM: 8, mocked: false },
  });
  assert.equal(res.status, 201);
  const item = await res.json();
  firstUpload = item; // the photograph the reuse test recycles

  assert.equal(item.sha256, sha256(bytes), 'server hashes the bytes it received');
  assert.equal(item.deviceSha256Match, true);
  assert.match(item.dHash, /^[0-9a-f]{16}$/);
  // The device's claim is kept beside the server's value, never merged into it.
  assert.equal(item.deviceDHash, 'ffffffffffffffff');
  assert.notEqual(item.dHash, item.deviceDHash);

  const stored = await readFile(new URL(item.storageKey, `file://${UPLOADS}`));
  assert.deepEqual(stored, bytes, 'the original is stored byte for byte');

  const thumb = await fetch(base + item.thumbnailUrl, {
    headers: { authorization: `Bearer ${officerToken}` },
  });
  assert.equal(thumb.status, 200);
  const { width } = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(width, 96, 'a small original is not enlarged into a thumbnail');

  // A retried upload collides on (reportId, clientId) rather than storing twice.
  const clientId = randomUUID();
  await upload(reportId, bytes, { clientId });
  await upload(reportId, bytes, { clientId });
  assert.equal(await EvidenceItem.countDocuments({ reportId, clientId }), 1);
});

test('§10 flags a device hash that disagrees, and never rejects for it', async () => {
  const reportId = await submitReport(assignments[3].id);
  const res = await upload(reportId, await jpeg(0.9), { sha256: 'e3b0c442'.repeat(8) });

  assert.equal(res.status, 201, 'a mismatched claim is a flag, not a rejection');
  const item = await res.json();
  assert.equal(item.deviceSha256Match, false);
  assert.deepEqual(item.flags, ['DEVICE_SHA256_MISMATCH']);
});

test('§11 flags a recycled photograph and names the report it came from', async () => {
  const original = await readFile(new URL(firstUpload.storageKey, `file://${UPLOADS}`));
  // Re-encoded, so the bytes differ and only the perceptual hash can catch it —
  // the same trick §12 plants on institute #088.
  const recycled = await sharp(original).jpeg({ quality: 85 }).toBuffer();
  assert.notEqual(sha256(recycled), sha256(original), 're-encoding must change the bytes');

  const reportId = await submitReport(assignments[1].id);
  const uploaded = await upload(reportId, recycled, {
    location: { coordinates: [73.8571, 18.521], accuracyM: 9, mocked: false },
  });
  assert.equal(uploaded.status, 201, 'a reused photo still uploads — the score never blocks');

  const body = await trust(reportId);
  const l1 = factor(body, 'L1');
  assert.equal(l1.fired, true);
  assert.ok(l1.evidence.hammingDistance <= 6);
  assert.ok(
    l1.evidence.matchedReportIds.includes(firstUpload.reportId),
    'the deduction cites the earlier report',
  );
  assert.match(l1.reason, /already on file/);
  assert.ok(body.score < 100);

  // Every layer that was checked is reported, passed or not — L2 is the control:
  // a re-encode is not a byte duplicate.
  assert.equal(factor(body, 'L2').fired, false);
  assert.equal(factor(body, 'L2').deduction, 0);
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
    assert.ok(factor(body, id).reason, `${id} carries a plain-language reason`);
  }
});

test('§11 scores the layers a faked inspection trips', async () => {
  const bytes = await jpeg(0.35);
  const reportId = await submitReport(assignments[2].id, {
    // 22:30 IST, outside L7's window, and 5h 36m after this inspector's
    // previous submission 1150 km away in Pune.
    submittedAt: '2026-10-08T17:00:00.000Z',
    deviceSignals: { deviceId: DEVICE_ID, platform: 'android', rooted: true, emulator: false },
    gpsSeries: [
      { at: '2026-10-08T16:50:00.000Z', lat: 28.61, lng: 77.2, accuracyM: 8, mocked: true },
    ],
  });
  // Captured in Pune, but the institute is in Delhi.
  await upload(reportId, bytes, {
    location: { coordinates: [73.8567, 18.5204], accuracyM: 8, mocked: false },
  });

  const body = await trust(reportId);
  const fired = body.factors.filter((f) => f.fired).map((f) => f.id);

  assert.deepEqual(fired.slice(0, 2), ['L3', 'L4'], 'mock location and a rooted device');
  assert.ok(fired.includes('L5'), 'Pune to Delhi in under six hours is not a drive');
  assert.ok(fired.includes('L6'), 'the photograph was taken 1000 km from the institute');
  assert.ok(fired.includes('L7'), '22:30 IST is outside the working window');
  // Five layers at once, not a threshold on any one of them. Bounded rather
  // than exact so retuning TRUST_WEIGHTS in core does not break this test.
  assert.ok(body.score < 20, `five fired layers should gut the score, got ${body.score}`);
  assert.equal(body.signatureValid, true);

  // The point of the whole section: none of that blocked anything.
  const report = await mongoose.model('InspectionReport').findById(reportId);
  assert.equal(report.status, 'SUBMITTED');
});
