/**
 * §7 acceptance: the inspector inbox is scoped by the token, filtered by status,
 * and carries the checklist for every scheme it references.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import { Assignment, InspectionCycle, Inspector, Institute, User } from '../apps/api/models.js';

const PASSWORD = 'test-only-password';

let memoryServer;
let server;
let base;
let mine;
let theirs;

const call = (path, token) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function login(email) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return (await res.json()).token;
}

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4';

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('nirikshan-assignments-test'));

  const place = (name, schemeType) => ({
    name,
    schemeType,
    district: 'Pune',
    state: 'Maharashtra',
    location: { type: 'Point', coordinates: [73.8567, 18.5204] },
    reportedCapacity: 120,
    reportedOccupancy: 98,
  });
  const [hostel, home, other] = await Institute.create([
    place('Sunrise Boys Hostel', 'HOSTEL'),
    place('Shanti Senior Home', 'SENIOR_HOME'),
    place('Not Mine Hostel', 'HOSTEL'),
  ]);

  [mine, theirs] = await Inspector.create([
    { name: 'A. Sharma', homeDistrict: 'Pune' },
    { name: 'B. Rao', homeDistrict: 'Pune' },
  ]);

  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    {
      email: 'inspector@example.test',
      name: 'A. Sharma',
      role: 'INSPECTOR',
      passwordHash,
      inspectorId: mine._id,
    },
    // An INSPECTOR account with no inspector record — a seeding mistake that
    // must not silently return somebody else's inbox.
    { email: 'orphan@example.test', name: 'No Profile', role: 'INSPECTOR', passwordHash },
    { email: 'division@example.test', name: 'D. Officer', role: 'DIVISION', passwordHash },
  ]);

  const cycle = await InspectionCycle.create({
    periodStart: new Date('2026-10-01'),
    periodEnd: new Date('2026-10-31'),
    commitmentHash: 'a'.repeat(64),
    seed: 'b'.repeat(64),
  });

  const row = (institute, inspector, status) => ({
    cycleId: cycle._id,
    instituteId: institute._id,
    inspectorId: inspector._id,
    allocationType: 'RANDOM',
    dueDate: new Date('2026-10-14'),
    status,
  });
  await Assignment.create([
    row(hostel, mine, 'PENDING'),
    row(home, mine, 'SUBMITTED'),
    row(other, theirs, 'PENDING'),
  ]);

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
});

test('the inbox is scoped to the calling inspector and defaults to PENDING', async () => {
  const res = await call('/api/assignments/mine', await login('inspector@example.test'));
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.assignments.length, 1);
  assert.equal(body.assignments[0].institute.name, 'Sunrise Boys Hostel');
  assert.equal(body.assignments[0].status, 'PENDING');
  assert.ok(body.serverTime);
});

test('another inspector’s assignment is never returned', async () => {
  const res = await call('/api/assignments/mine?status=ALL', await login('inspector@example.test'));
  const names = (await res.json()).assignments.map((a) => a.institute.name);
  assert.deepEqual(names.sort(), ['Shanti Senior Home', 'Sunrise Boys Hostel']);
  assert.ok(!names.includes('Not Mine Hostel'));
});

test('every referenced checklist ships with the inbox, and only those', async () => {
  const token = await login('inspector@example.test');

  const pending = await (await call('/api/assignments/mine', token)).json();
  assert.deepEqual(Object.keys(pending.checklists), ['hostel.v1']);
  assert.equal(pending.assignments[0].checklistId, 'hostel.v1');
  // The renderer needs sections with items, not just a version stamp.
  assert.ok(pending.checklists['hostel.v1'].sections[0].items.length > 0);

  const all = await (await call('/api/assignments/mine?status=ALL', token)).json();
  assert.deepEqual(Object.keys(all.checklists).sort(), ['hostel.v1', 'senior-home.v1']);
});

test('the inbox refuses a non-inspector role and an inspector with no profile', async () => {
  const division = await call('/api/assignments/mine', await login('division@example.test'));
  assert.equal(division.status, 403);
  assert.equal((await division.json()).error.code, 'FORBIDDEN_ROLE');

  const orphan = await call('/api/assignments/mine', await login('orphan@example.test'));
  assert.equal(orphan.status, 403);
  assert.equal((await orphan.json()).error.code, 'NO_INSPECTOR_PROFILE');
});

test('an unknown status is rejected rather than silently treated as ALL', async () => {
  const res = await call(
    '/api/assignments/mine?status=EVERYTHING',
    await login('inspector@example.test'),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'VALIDATION_FAILED');
});
