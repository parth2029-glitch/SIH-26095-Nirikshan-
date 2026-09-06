/**
 * §9 acceptance: the offline outbox drains in batches, a retry never
 * double-submits, and an unsigned report has no author.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import {
  Assignment,
  InspectionCycle,
  InspectionReport,
  Inspector,
  Institute,
  User,
} from '../apps/api/models.js';

const PASSWORD = 'test-only-password';
const DEVICE_ID = 'handset-under-test';

let memoryServer;
let server;
let base;
let token;
let key;
let assignments;

/** Exactly what apps/mobile/lib/sign.js does — the hex key used as material. */
const sign = (report) =>
  createHmac('sha256', key)
    .update(canonicalJSON(reportSignaturePayload(report)), 'utf8')
    .digest('hex');

const draft = (assignmentId, overrides = {}) => ({
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
});

const signed = (report) => ({ ...report, signature: sign(report) });

const post = (reports, { idempotencyKey = randomUUID(), bearer = token } = {}) =>
  fetch(base + '/api/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey && { 'idempotency-key': idempotencyKey }),
      ...(bearer && { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ reports }),
  });

async function login(email) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, deviceId: DEVICE_ID }),
  });
  return res.json();
}

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4';

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('nirikshan-reports-test'));

  const place = (name) => ({
    name,
    schemeType: 'HOSTEL',
    district: 'Pune',
    state: 'Maharashtra',
    location: { type: 'Point', coordinates: [73.8567, 18.5204] },
  });
  // Six, because a report closes its assignment: every test that submits for
  // real needs an assignment nothing has submitted for yet.
  const institutes = await Institute.create(
    ['One', 'Two', 'Theirs', 'Replay', 'Tamper', 'Evidence'].map(place),
  );

  const [mine, theirs] = await Inspector.create([
    { name: 'A. Sharma', homeDistrict: 'Pune' },
    { name: 'B. Rao', homeDistrict: 'Pune' },
  ]);

  const passwordHash = await hashPassword(PASSWORD);
  await User.create({
    email: 'inspector@example.test',
    name: 'A. Sharma',
    role: 'INSPECTOR',
    passwordHash,
    inspectorId: mine._id,
  });

  const cycle = await InspectionCycle.create({
    periodStart: new Date('2026-10-01'),
    periodEnd: new Date('2026-10-31'),
    commitmentHash: 'a'.repeat(64),
    seed: 'b'.repeat(64),
  });

  assignments = await Assignment.create(
    institutes.map((institute, index) => ({
      cycleId: cycle._id,
      instituteId: institute._id,
      inspectorId: index === 2 ? theirs._id : mine._id,
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
  assert.ok(key, 'login must issue a device HMAC key when a deviceId is sent');
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
});

test('a batch is accepted whole and the assignments move to SUBMITTED', async () => {
  const batch = [signed(draft(assignments[0].id)), signed(draft(assignments[1].id))];
  const res = await post(batch);
  assert.equal(res.status, 201);

  const { results } = await res.json();
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.status === 'ACCEPTED' && !result.duplicate));

  const reloaded = await Assignment.find({ _id: { $in: [assignments[0].id, assignments[1].id] } });
  assert.deepEqual(
    reloaded.map((row) => row.status),
    ['SUBMITTED', 'SUBMITTED'],
  );
});

test('replaying a report returns the original id and writes nothing', async () => {
  const report = signed(draft(assignments[3].id));
  const [a] = (await (await post([report])).json()).results;
  // The replay lands after the assignment is already SUBMITTED, which is the
  // real case: a phone that lost the first response retries a closed
  // assignment. Dedupe therefore has to run before any state check.
  const [b] = (await (await post([report])).json()).results;

  assert.equal(a.status, 'ACCEPTED');
  assert.equal(a.duplicate, false);
  assert.equal(b.status, 'ACCEPTED');
  assert.equal(b.duplicate, true);
  assert.equal(b.reportId, a.reportId);
  assert.equal(await InspectionReport.countDocuments({ clientId: report.clientId }), 1);
});

test('a second, different report for a submitted assignment is refused', async () => {
  const res = await post([signed(draft(assignments[3].id))]);
  const [result] = (await res.json()).results;
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.error.code, 'ASSIGNMENT_CLOSED');
});

test('a tampered report is rejected and does not sink the batch', async () => {
  const good = signed(draft(assignments[4].id));
  const tampered = signed(draft(assignments[4].id));
  // Signed honestly, then edited — exactly what the signature exists to catch.
  tampered.answers = [{ questionId: 'hostel.occupancy.headcount', value: 120 }];

  const res = await post([tampered, good]);
  assert.equal(res.status, 201);
  const { results } = await res.json();

  assert.equal(results[0].status, 'REJECTED');
  assert.equal(results[0].error.code, 'BAD_SIGNATURE');
  // The honest one still lands: one bad report must not reject the others.
  assert.equal(results[1].status, 'ACCEPTED');
  assert.equal(await InspectionReport.countDocuments({ clientId: tampered.clientId }), 0);
});

test('another inspector’s assignment is rejected, not accepted quietly', async () => {
  const res = await post([signed(draft(assignments[2].id))]);
  const [result] = (await res.json()).results;
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.error.code, 'OUT_OF_SCOPE');
});

test('the Idempotency-Key header is required and the body must be an array', async () => {
  const noKey = await post([signed(draft(assignments[0].id))], { idempotencyKey: null });
  assert.equal(noKey.status, 400);

  const notArray = await fetch(base + '/api/reports', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ reports: {} }),
  });
  assert.equal(notArray.status, 400);
});

test('accepted reports carry an evidence upload url per client id', async () => {
  const evidenceClientId = randomUUID();
  const res = await post([
    signed(draft(assignments[5].id, { evidenceClientIds: [evidenceClientId] })),
  ]);
  const [result] = (await res.json()).results;

  assert.equal(
    result.evidenceUploadUrls[evidenceClientId],
    `/api/reports/${result.reportId}/evidence`,
  );
});
