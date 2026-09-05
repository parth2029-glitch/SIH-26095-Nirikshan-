/**
 * §5 acceptance: commit–reveal, idempotent assignment, and public verification.
 *
 * The last two tests are the ones that matter. They do exactly what the
 * verification page does — replay `assign()` over the published `/verify`
 * payload — first on an untouched cycle, then after editing one stored row.
 * If the honest cycle ever stops replaying, F1 is broken whether or not the
 * page still renders.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { assign } from '@nirikshan/core/assign';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import { Assignment, InspectionCycle, Inspector, Institute, User } from '../apps/api/models.js';

const PASSWORD = 'correct-horse-battery-staple';
const DISTRICTS = ['Pune', 'Nagpur', 'Nashik', 'Thane', 'Amravati'];

let memoryServer;
let server;
let base;
let divisionToken;
let inspectorToken;

const call = (path, { token, method = 'GET', body } = {}) =>
  fetch(base + path, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });

const json = async (res) => ({ status: res.status, body: await res.json() });

/** A cycle whose period is already over, so it is revealable. */
const closedPeriod = { periodStart: '2026-01-01', periodEnd: '2026-02-01' };

async function newCycle(body = closedPeriod) {
  const { status, body: cycle } = await json(
    await call('/api/cycles', { token: divisionToken, method: 'POST', body }),
  );
  assert.equal(status, 201);
  return cycle;
}

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4';

  memoryServer = await MongoMemoryServer.create();
  await mongoose.connect(memoryServer.getUri('nirikshan-cycles-test'));

  // 40 institutes across 5 districts, 10 inspectors. Enough that C1–C4 bind
  // and the draw is not trivially the identity.
  await Institute.create(
    Array.from({ length: 40 }, (_, i) => ({
      name: `Institute ${i}`,
      schemeType: 'HOSTEL',
      district: DISTRICTS[i % DISTRICTS.length],
      state: 'Maharashtra',
      location: { type: 'Point', coordinates: [73 + (i % 5) * 0.4, 18 + (i % 7) * 0.2] },
      riskScore: (i * 37) % 100,
    })),
  );
  await Inspector.create(
    Array.from({ length: 10 }, (_, i) => ({
      name: `Inspector ${i}`,
      homeDistrict: DISTRICTS[i % DISTRICTS.length],
    })),
  );

  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    { email: 'division@pmu.gov.in', name: 'V. Rao', role: 'DIVISION', passwordHash },
    { email: 'inspector@pmu.gov.in', name: 'A. Sharma', role: 'INSPECTOR', passwordHash },
  ]);

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;

  const token = async (email) =>
    (
      await json(
        await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } }),
      )
    ).body.token;
  divisionToken = await token('division@pmu.gov.in');
  inspectorToken = await token('inspector@pmu.gov.in');
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await memoryServer?.stop();
});

test('creating a cycle publishes a commitment and never returns the seed', async () => {
  const cycle = await newCycle();

  assert.match(cycle.commitmentHash, /^[0-9a-f]{64}$/);
  assert.equal(cycle.status, 'OPEN');
  assert.equal(cycle.seedRevealed, false);
  // Not merely absent from a nested object — absent from the whole payload.
  assert.ok(!JSON.stringify(cycle).includes('seed"'), 'no seed field in the create response');

  // The commitment row exists and no Assignment for it does. This is the
  // ordering the whole scheme rests on: commit first, draw second.
  assert.equal(await Assignment.countDocuments({ cycleId: cycle.id }), 0);

  const stored = await InspectionCycle.findById(cycle.id).select('+seed');
  assert.match(stored.seed, /^[0-9a-f]{64}$/, '32 bytes of randomness, hex');
  assert.equal(
    stored.commitmentHash,
    createHash('sha256').update(`${stored.seed}${cycle.id}`).digest('hex'),
    'commitmentHash = SHA-256(seed || cycleId)',
  );
});

test('cycle writes are DIVISION-only', async () => {
  const res = await call('/api/cycles', {
    token: inspectorToken,
    method: 'POST',
    body: closedPeriod,
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'FORBIDDEN_ROLE');
});

test('a malformed period is rejected before a seed is minted', async () => {
  const before = await InspectionCycle.countDocuments();
  const { status, body } = await json(
    await call('/api/cycles', {
      token: divisionToken,
      method: 'POST',
      body: { periodStart: '2026-03-01', periodEnd: '2026-02-01' },
    }),
  );
  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.equal(await InspectionCycle.countDocuments(), before);
});

test('assigning is idempotent — a second call writes nothing', async () => {
  const cycle = await newCycle();

  const first = await json(
    await call(`/api/cycles/${cycle.id}/assign`, { token: divisionToken, method: 'POST' }),
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.created, true);
  assert.ok(first.body.assignmentCount > 0);
  assert.equal(
    first.body.byAllocationType.RANDOM + first.body.byAllocationType.TARGETED,
    first.body.assignmentCount,
  );

  const second = await json(
    await call(`/api/cycles/${cycle.id}/assign`, { token: divisionToken, method: 'POST' }),
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.equal(second.body.assignmentCount, first.body.assignmentCount);
  assert.deepEqual(second.body.byAllocationType, first.body.byAllocationType);

  // The database, not just the response.
  assert.equal(await Assignment.countDocuments({ cycleId: cycle.id }), first.body.assignmentCount);

  // Concurrent callers collide on the unique index rather than duplicating.
  const racing = await newCycle();
  const results = await Promise.all(
    [0, 1, 2].map(() =>
      call(`/api/cycles/${racing.id}/assign`, { token: divisionToken, method: 'POST' }),
    ),
  );
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200, 200],
  );
  const created = await Promise.all(results.map(async (r) => (await r.json()).created));
  assert.equal(created.filter(Boolean).length, 1, 'exactly one caller created the draw');
});

test('reveal refuses while the cycle is still open, twice over', async () => {
  const undrawn = await newCycle();
  const noDraw = await json(
    await call(`/api/cycles/${undrawn.id}/reveal`, {
      token: divisionToken,
      method: 'POST',
      body: { confirm: true },
    }),
  );
  assert.equal(noDraw.status, 400);
  assert.equal(noDraw.body.error.code, 'CYCLE_STILL_OPEN');
  assert.ok(noDraw.body.error.details.closesAt);

  // Drawn, but the inspection period has not ended: revealing now hands every
  // institute the inspector it is about to receive.
  const future = await newCycle({ periodStart: '2099-01-01', periodEnd: '2099-02-01' });
  await call(`/api/cycles/${future.id}/assign`, { token: divisionToken, method: 'POST' });
  const early = await json(
    await call(`/api/cycles/${future.id}/reveal`, {
      token: divisionToken,
      method: 'POST',
      body: { confirm: true },
    }),
  );
  assert.equal(early.status, 400);
  assert.equal(early.body.error.code, 'CYCLE_STILL_OPEN');

  const stored = await InspectionCycle.findById(future.id);
  assert.equal(stored.seedRevealed, false);
});

test('verify is public, hides the seed until reveal, and returns no verdict', async () => {
  const cycle = await newCycle();
  await call(`/api/cycles/${cycle.id}/assign`, { token: divisionToken, method: 'POST' });

  // No Authorization header at all.
  const sealed = await json(await call(`/api/cycles/${cycle.id}/verify`));
  assert.equal(sealed.status, 200);
  assert.equal(sealed.body.cycle.seed, null);
  assert.equal(sealed.body.cycle.seedRevealed, false);
  assert.deepEqual(sealed.body.assignments, [], 'pairings stay sealed before reveal');
  assert.match(sealed.body.cycle.commitmentHash, /^[0-9a-f]{64}$/);

  const revealed = await json(
    await call(`/api/cycles/${cycle.id}/reveal`, {
      token: divisionToken,
      method: 'POST',
      body: { confirm: true },
    }),
  );
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.status, 'REVEALED');

  const open = await json(await call(`/api/cycles/${cycle.id}/verify`));
  assert.equal(open.body.cycle.seed, revealed.body.seed);
  assert.ok(open.body.assignments.length > 0);

  // The server publishes and does not judge. A verdict field here would be a
  // verdict from the party under audit.
  const keys = Object.keys(open.body).concat(Object.keys(open.body.cycle));
  for (const forbidden of ['verified', 'valid', 'match', 'ok', 'verdict']) {
    assert.ok(!keys.includes(forbidden), `/verify must not return "${forbidden}"`);
  }

  // A second reveal is refused rather than silently repeated.
  const again = await json(
    await call(`/api/cycles/${cycle.id}/reveal`, {
      token: divisionToken,
      method: 'POST',
      body: { confirm: true },
    }),
  );
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'SEED_ALREADY_REVEALED');
});

test('an honest cycle replays to MATCH from the public payload alone', async () => {
  const cycle = await newCycle();
  await call(`/api/cycles/${cycle.id}/assign`, { token: divisionToken, method: 'POST' });
  await call(`/api/cycles/${cycle.id}/reveal`, {
    token: divisionToken,
    method: 'POST',
    body: { confirm: true },
  });

  const { body } = await json(await call(`/api/cycles/${cycle.id}/verify`));

  // Check 1 — the commitment binds this seed to this cycle.
  assert.equal(
    createHash('sha256').update(`${body.cycle.seed}${body.cycle.id}`).digest('hex'),
    body.cycle.commitmentHash,
  );

  // Check 2 — the draw. Exactly what verify.js runs in the browser.
  const replay = assign(
    body.inputs.institutes,
    body.inputs.inspectors,
    body.inputs.history,
    body.cycle.seed,
    body.cycle.config,
  );
  const canonical = (rows) =>
    rows.map((r) => `${r.instituteId} ${r.inspectorId} ${r.allocationType}`).sort();

  assert.deepEqual(canonical(replay.assignments), canonical(body.assignments));
  assert.deepEqual(replay.deferred, body.deferred);

  // The inputs are a snapshot, not a live read. Move the values the engine
  // reads and the replay must still match — otherwise the nightly risk job
  // would report every past cycle as tampered.
  await Institute.updateMany({}, { $set: { riskScore: 99 } });
  await Inspector.updateMany({}, { $set: { workloadCount: 500 } });

  const later = await json(await call(`/api/cycles/${cycle.id}/verify`));
  assert.deepEqual(later.body.inputs, body.inputs, 'published inputs are frozen at draw time');
  const replayLater = assign(
    later.body.inputs.institutes,
    later.body.inputs.inspectors,
    later.body.inputs.history,
    later.body.cycle.seed,
    later.body.cycle.config,
  );
  assert.deepEqual(canonical(replayLater.assignments), canonical(later.body.assignments));

  await Institute.updateMany({}, { $set: { riskScore: 0 } });
  await Inspector.updateMany({}, { $set: { workloadCount: 0 } });
});

test('tampering with one stored assignment replays to MISMATCH', async () => {
  const cycle = await newCycle();
  await call(`/api/cycles/${cycle.id}/assign`, { token: divisionToken, method: 'POST' });
  await call(`/api/cycles/${cycle.id}/reveal`, {
    token: divisionToken,
    method: 'POST',
    body: { confirm: true },
  });

  // Straight at the collection, past the application — the retroactive edit
  // §6's ledger is built to catch, done here to prove the replay catches it too.
  const row = await Assignment.findOne({ cycleId: cycle.id });
  const other = await Inspector.findOne({ _id: { $ne: row.inspectorId } });
  await mongoose.connection
    .collection('assignments')
    .updateOne({ _id: row._id }, { $set: { inspectorId: other._id } });

  const { body } = await json(await call(`/api/cycles/${cycle.id}/verify`));
  const replay = assign(
    body.inputs.institutes,
    body.inputs.inspectors,
    body.inputs.history,
    body.cycle.seed,
    body.cycle.config,
  );
  const canonical = (rows) =>
    rows.map((r) => `${r.instituteId} ${r.inspectorId} ${r.allocationType}`).sort();

  assert.notDeepEqual(canonical(replay.assignments), canonical(body.assignments));

  // And it is the edited row that differs — one substitution, not a reordering.
  const mine = new Map(replay.assignments.map((a) => [a.instituteId, a.inspectorId]));
  const differing = body.assignments.filter((a) => mine.get(a.instituteId) !== a.inspectorId);
  assert.equal(differing.length, 1);
  assert.equal(differing[0].instituteId, String(row.instituteId));
});
