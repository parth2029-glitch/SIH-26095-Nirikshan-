/**
 * §13 acceptance: role scoping is enforced by the API, not by the UI.
 *
 * The dashboard hides a district officer's out-of-district rows by not asking
 * for them. This suite asks anyway, with a real DISTRICT token, and checks the
 * server refuses — because "the screen does not show it" is not a control, and
 * a UI is one `curl` away from being bypassed.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import {
  Assignment,
  Finding,
  InspectionCycle,
  InspectionReport,
  Inspector,
  Institute,
  User,
} from '../apps/api/models.js';

const PASSWORD = 'test-only-password';

let memoryServer;
let server;
let base;
let pune;
let nagpur;
let puneReport;
let nagpurReport;
// Minted up front so the findings can name their owner at creation: §6's plugin
// refuses a later updateMany, which is the whole point of it.
const districtOfficerId = new mongoose.Types.ObjectId();

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
  await mongoose.connect(memoryServer.getUri('nirikshan-dashboard-test'));

  [pune, nagpur] = await Institute.create([
    {
      name: 'Pune Hostel',
      schemeType: 'HOSTEL',
      district: 'Pune',
      state: 'Maharashtra',
      location: { type: 'Point', coordinates: [73.8567, 18.5204] },
    },
    {
      name: 'Nagpur Hostel',
      schemeType: 'HOSTEL',
      district: 'Nagpur',
      state: 'Maharashtra',
      location: { type: 'Point', coordinates: [79.0882, 21.1458] },
    },
  ]);

  const inspector = await Inspector.create({ name: 'A. Sharma', homeDistrict: 'Thane' });
  const cycle = await InspectionCycle.create({
    periodStart: new Date('2026-01-01'),
    periodEnd: new Date('2026-02-01'),
    commitmentHash: 'a'.repeat(64),
    seed: 'b'.repeat(64),
    status: 'ASSIGNED',
    // One deferral per district, so the log has something to leak if scoping
    // is applied to the response rather than to the read.
    deferred: [
      { instituteId: String(pune._id), reason: 'No inspector satisfied C2 and C4.' },
      { instituteId: String(nagpur._id), reason: 'No inspector satisfied C1.' },
    ],
  });

  const [puneAssignment, nagpurAssignment] = await Assignment.create([
    {
      cycleId: cycle._id,
      instituteId: pune._id,
      inspectorId: inspector._id,
      allocationType: 'RANDOM',
      dueDate: new Date('2026-02-01'),
    },
    {
      cycleId: cycle._id,
      instituteId: nagpur._id,
      inspectorId: inspector._id,
      allocationType: 'RANDOM',
      dueDate: new Date('2026-02-01'),
    },
  ]);

  [puneReport, nagpurReport] = await InspectionReport.create([
    {
      assignmentId: puneAssignment._id,
      clientId: 'pune-1',
      submittedAt: new Date('2026-01-10'),
      answers: [],
    },
    {
      assignmentId: nagpurAssignment._id,
      clientId: 'nagpur-1',
      submittedAt: new Date('2026-01-11'),
      answers: [],
    },
  ]);

  await Finding.create([
    {
      reportId: puneReport._id,
      severity: 'HIGH',
      category: 'sanitation',
      slaDueAt: new Date('2026-02-15'),
      ownerId: districtOfficerId,
    },
    {
      reportId: nagpurReport._id,
      severity: 'HIGH',
      category: 'sanitation',
      slaDueAt: new Date('2026-02-15'),
      ownerId: districtOfficerId,
    },
  ]);

  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    {
      _id: districtOfficerId,
      email: 'district@example.test',
      name: 'D. Patil',
      role: 'DISTRICT',
      homeDistrict: 'Pune',
      passwordHash,
    },
    { email: 'division@example.test', name: 'V. Rao', role: 'DIVISION', passwordHash },
    {
      email: 'institute@example.test',
      name: 'Pune Hostel Admin',
      role: 'INSTITUTE',
      instituteId: pune._id,
      passwordHash,
    },
    {
      email: 'inspector@example.test',
      name: 'A. Sharma',
      role: 'INSPECTOR',
      inspectorId: inspector._id,
      passwordHash,
    },
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

test('a DISTRICT token sees only its own district, whatever it asks for', async () => {
  const token = await login('district@example.test');

  const institutes = await (await call('/api/dashboard/institutes', token)).json();
  assert.deepEqual(
    institutes.institutes.map((i) => i.district),
    ['Pune'],
  );

  // The queue joins two collections before it can know the district — the
  // filter has to survive both hops.
  const findings = await (await call('/api/dashboard/findings?status=ALL', token)).json();
  assert.equal(findings.findings.length, 1);
  assert.equal(findings.findings[0].institute.district, 'Pune');

  // Counts are scoped too: an officer must not learn the size of another
  // district's caseload from a summary panel.
  const cycles = await (await call('/api/dashboard/cycles', token)).json();
  assert.equal(cycles.cycles[0].issued, 1);
});

test('a DISTRICT token is refused a report from another district', async () => {
  const token = await login('district@example.test');

  const mine = await call(`/api/reports/${puneReport.id}`, token);
  assert.equal(mine.status, 200);

  const theirs = await call(`/api/reports/${nagpurReport.id}`, token);
  assert.equal(theirs.status, 403);
  assert.equal((await theirs.json()).error.code, 'OUT_OF_SCOPE');
});

test('an INSTITUTE token is narrowed to its own record', async () => {
  const token = await login('institute@example.test');

  const institutes = await (await call('/api/dashboard/institutes', token)).json();
  assert.deepEqual(
    institutes.institutes.map((i) => i.name),
    ['Pune Hostel'],
  );
  assert.equal((await call(`/api/reports/${nagpurReport.id}`, token)).status, 403);
});

test('a DIVISION token sees the whole portfolio', async () => {
  const token = await login('division@example.test');

  const institutes = await (await call('/api/dashboard/institutes', token)).json();
  assert.equal(institutes.institutes.length, 2);
  assert.equal((await (await call('/api/dashboard/cycles', token)).json()).cycles[0].issued, 2);
  assert.equal((await call(`/api/reports/${nagpurReport.id}`, token)).status, 200);
});

test('an INSPECTOR token reaches no dashboard route at all', async () => {
  const token = await login('inspector@example.test');
  for (const path of [
    '/api/dashboard/cycles',
    '/api/dashboard/findings',
    '/api/dashboard/institutes',
    `/api/reports/${puneReport.id}`,
  ]) {
    const res = await call(path, token);
    assert.equal(res.status, 403, `${path} should be forbidden to an inspector`);
  }
});

test('unactioned flags are grouped and counted by the server, not by a capped page', async () => {
  // Both findings are owned by the Pune officer and their 2026-02-15 SLA date
  // is long past.
  const division = await (
    await call('/api/dashboard/unactioned', await login('division@example.test'))
  ).json();
  assert.equal(division.total, 2);
  assert.deepEqual(
    division.officers.map((o) => [o.name, o.breached, o.severe]),
    [['D. Patil', 2, 2]],
  );

  // Scope narrows the count, not just the list: the Nagpur finding is the same
  // officer's row on the division's screen and absent from the district's.
  const district = await (
    await call('/api/dashboard/unactioned', await login('district@example.test'))
  ).json();
  assert.equal(district.total, 1);
  assert.equal(district.officers[0].breached, 1);
});

test('the deferral log is scoped, not just its count', async () => {
  const district = await (
    await call('/api/dashboard/cycles', await login('district@example.test'))
  ).json();
  assert.equal(district.cycles[0].deferred, 1);
  assert.deepEqual(
    district.cycles[0].deferrals.map((d) => d.name),
    ['Pune Hostel'],
  );

  const division = await (
    await call('/api/dashboard/cycles', await login('division@example.test'))
  ).json();
  assert.equal(division.cycles[0].deferred, 2);
  assert.deepEqual(
    division.cycles[0].deferrals.map((d) => d.reason),
    ['No inspector satisfied C2 and C4.', 'No inspector satisfied C1.'],
  );
});

test('overdue is derived from the clock, not from a stored status', async () => {
  const token = await login('division@example.test');
  const { cycles } = await (await call('/api/dashboard/cycles', token)).json();
  // Both assignments are PENDING with a 2026-02-01 due date, now long past.
  assert.equal(cycles[0].overdue, 2);
  assert.equal(cycles[0].completed, 0);
  const stored = await Assignment.find({ status: 'OVERDUE' });
  assert.equal(stored.length, 0, 'nothing wrote OVERDUE into the database');
});
