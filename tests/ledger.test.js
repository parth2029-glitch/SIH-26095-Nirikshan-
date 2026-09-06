/**
 * §6 acceptance: no application code path weakens the system without leaving a
 * chained record, and a record altered afterwards is detectable.
 *
 * A replica set, not a standalone Mongo: the ledger write and the target
 * mutation share a transaction, and Mongo only offers transactions on a replica
 * set. `infra/docker-compose.yml` runs a single-node rs0 for the same reason.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createApp } from '../apps/api/app.js';
import { hashPassword } from '../apps/api/auth.js';
import {
  Assignment,
  Finding,
  InspectionCycle,
  InspectionReport,
  Inspector,
  Institute,
  OverrideEvent,
  User,
} from '../apps/api/models.js';
import {
  GENESIS_HASH,
  canonicalJSON,
  checkChain,
  merkleRoot,
  publishMerkleRoot,
} from '../apps/api/overrides.js';

const PASSWORD = 'test-only-password';
const JUSTIFICATION = 'Inspector hospitalised on 07 Oct; institute rescheduled to the next cycle.';

let replSet;
let server;
let base;
let tokens;
let ids;

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

/** Two σ is the PRD threshold; the test only needs the outlier to clear it. */
const SIGMA_FLAG = 2;

/** One override, as DISTRICT unless told otherwise. */
async function post(body, token = tokens.district) {
  const res = await call('/api/overrides', { token, method: 'POST', body });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  process.env.JWT_SECRET = 'test-secret-not-used-outside-this-suite';
  process.env.DEVICE_HMAC_SECRET = 'test-device-secret';
  process.env.BCRYPT_ROUNDS = '4';

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replSet.getUri('nirikshan-ledger-test'));

  const institute = await Institute.create({
    name: 'Ledger Hostel',
    schemeType: 'HOSTEL',
    district: 'Pune',
    state: 'Maharashtra',
    location: { type: 'Point', coordinates: [73.8567, 18.5204] },
  });
  const [inspector, other] = await Inspector.create([
    { name: 'A. Sharma', homeDistrict: 'Nagpur' },
    { name: 'B. Iyer', homeDistrict: 'Nashik' },
  ]);
  const cycle = await InspectionCycle.create({
    periodStart: new Date('2026-01-01'),
    periodEnd: new Date('2026-02-01'),
    commitmentHash: 'f'.repeat(64),
    seed: 'a'.repeat(64),
    seedRevealed: true,
    revealedAt: new Date('2026-02-02'),
    status: 'REVEALED',
  });
  const assignment = await Assignment.create({
    cycleId: cycle._id,
    instituteId: institute._id,
    inspectorId: inspector._id,
    allocationType: 'RANDOM',
    dueDate: new Date('2026-02-01'),
  });
  const report = await InspectionReport.create({
    assignmentId: assignment._id,
    clientId: 'client-1',
    submittedAt: new Date('2026-01-20'),
  });
  const finding = await Finding.create({
    reportId: report._id,
    severity: 'CRITICAL',
    category: 'FIRE_SAFETY',
    slaDueAt: new Date('2026-03-01'),
  });

  ids = {
    institute: String(institute._id),
    inspector: String(inspector._id),
    other: String(other._id),
    cycle: String(cycle._id),
    assignment: String(assignment._id),
    report: String(report._id),
    finding: String(finding._id),
  };

  const passwordHash = await hashPassword(PASSWORD);
  await User.create([
    {
      email: 'district@example.test',
      name: 'D. Patil',
      role: 'DISTRICT',
      homeDistrict: 'Pune',
      passwordHash,
    },
    {
      email: 'district2@example.test',
      name: 'S. Kale',
      role: 'DISTRICT',
      homeDistrict: 'Pune',
      passwordHash,
    },
    // A peer group of three cannot produce a 2σ outlier — the largest z-score
    // possible over n points is bounded by n. Eight peers is the smallest group
    // where the PRD's threshold can actually fire.
    ...Array.from({ length: 6 }, (_, i) => ({
      email: `district${i + 3}@example.test`,
      name: `Peer Officer ${i + 3}`,
      role: 'DISTRICT',
      homeDistrict: 'Pune',
      passwordHash,
    })),
    { email: 'auditor@example.test', name: 'CAG Observer', role: 'AUDITOR', passwordHash },
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

  const token = async (email) =>
    (
      await json(
        await call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } }),
      )
    ).body.token;
  tokens = {
    district: await token('district@example.test'),
    district2: await token('district2@example.test'),
    auditor: await token('auditor@example.test'),
    inspector: await token('inspector@example.test'),
  };
});

after(async () => {
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

test('canonicalJSON is order-independent and hashes ids and dates one way', () => {
  assert.equal(canonicalJSON({ b: 1, a: 2 }), canonicalJSON({ a: 2, b: 1 }));
  assert.equal(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJSON([{ z: 1, a: [3, 2] }]), '[{"a":[3,2],"z":1}]');
  assert.equal(canonicalJSON(undefined), 'null');

  // The one that matters: an ObjectId and its hex string must canonicalise
  // identically, or an entry would hash differently on read-back from Mongo.
  const id = new mongoose.Types.ObjectId();
  assert.equal(canonicalJSON({ id }), canonicalJSON({ id: String(id) }));
  const at = new Date('2026-10-07T15:02:11.000Z');
  assert.equal(canonicalJSON({ at }), canonicalJSON({ at: at.toISOString() }));
});

test('direct model writes are refused on all three monitored models', async () => {
  const targets = [
    [Assignment, ids.assignment, { status: 'CANCELLED' }],
    [Finding, ids.finding, { severity: 'LOW' }],
    [InspectionReport, ids.report, { status: 'REOPENED' }],
  ];

  for (const [Model, id, update] of targets) {
    for (const op of [
      'updateOne',
      'updateMany',
      'findOneAndUpdate',
      'replaceOne',
      'findOneAndReplace',
    ]) {
      await assert.rejects(
        () => Model[op]({ _id: id }, update),
        /recordOverride/,
        `${Model.modelName}.${op}() must be refused`,
      );
    }
    for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
      await assert.rejects(() => Model[op]({ _id: id }), /recordOverride/);
    }

    // The `findById*` aliases build the same queries under different names, and
    // the document-level methods build queries too — all of them land on the
    // hooks above. Asserted rather than assumed: these are the names a
    // developer actually reaches for.
    await assert.rejects(() => Model.findByIdAndUpdate(id, update), /recordOverride/);
    await assert.rejects(() => Model.findByIdAndDelete(id), /recordOverride/);
    const loaded = await Model.findById(id);
    await assert.rejects(() => loaded.updateOne(update), /recordOverride/);
    await assert.rejects(() => loaded.deleteOne(), /recordOverride/);
  }

  // The document path too: loading a row and saving an edit is the same
  // weakening by another route.
  const doc = await Assignment.findById(ids.assignment);
  doc.status = 'CANCELLED';
  await assert.rejects(() => doc.save(), /recordOverride/);

  // …but creating one is not a weakening, so it still works.
  const created = await Assignment.create({
    cycleId: ids.cycle,
    instituteId: new mongoose.Types.ObjectId(), // (cycle, institute) is unique
    inspectorId: ids.other,
    allocationType: 'TARGETED',
    dueDate: new Date('2026-02-01'),
  });
  assert.equal(created.status, 'PENDING');
  await mongoose.connection.collection('assignments').deleteOne({ _id: created._id });

  // Nothing above leaked through.
  assert.equal((await Assignment.findById(ids.assignment)).status, 'PENDING');
});

test('the ledger is INSPECTOR-forbidden and the chain reads AUDITOR-visible', async () => {
  const forbidden = await post(
    {
      eventType: 'ASSIGNMENT_CANCELLED',
      targetId: ids.assignment,
      reasonCode: 'INSPECTOR_UNAVAILABLE',
      justification: JUSTIFICATION,
    },
    tokens.inspector,
  );
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'FORBIDDEN_ROLE');

  const chain = await json(await call('/api/overrides/verify-chain', { token: tokens.auditor }));
  assert.equal(chain.status, 200);
  assert.equal(chain.body.ok, true);

  // An auditor reads the chain and cannot add to it.
  const write = await post(
    {
      eventType: 'ASSIGNMENT_CANCELLED',
      targetId: ids.assignment,
      reasonCode: 'INSPECTOR_UNAVAILABLE',
      justification: JUSTIFICATION,
    },
    tokens.auditor,
  );
  assert.equal(write.status, 403);
});

test('an override writes a genesis-linked entry and mutates the target, atomically', async () => {
  assert.equal(await OverrideEvent.countDocuments(), 0);

  const { status, body } = await post({
    eventType: 'ASSIGNMENT_CANCELLED',
    targetId: ids.assignment,
    reasonCode: 'INSPECTOR_UNAVAILABLE',
    justification: JUSTIFICATION,
  });

  assert.equal(status, 201);
  assert.equal(body.seq, 1);
  assert.equal(body.prevHash, GENESIS_HASH, 'an empty ledger links entry 1 to genesis');
  assert.match(body.entryHash, /^[0-9a-f]{64}$/);
  assert.equal(body.actorRole, 'DISTRICT');
  assert.equal(body.targetType, 'Assignment');
  assert.deepEqual(body.previousValue, { status: 'PENDING' }, 'the previous value is captured');

  // Both halves of the transaction landed.
  assert.equal((await Assignment.findById(ids.assignment)).status, 'CANCELLED');
  assert.equal(await OverrideEvent.countDocuments(), 1);
});

test('a rejected mutation rolls the ledger entry back with it', async () => {
  const before = await OverrideEvent.countDocuments();

  // CRITICAL is the top of the scale; "downgrading" to it is not a downgrade.
  const bad = await post({
    eventType: 'FINDING_DOWNGRADED',
    targetId: ids.finding,
    reasonCode: 'EVIDENCE_INSUFFICIENT',
    justification: 'The photographs do not establish the blocked exit as recorded.',
    payload: { severity: 'CRITICAL' },
  });
  assert.equal(bad.status, 400);
  assert.equal(await OverrideEvent.countDocuments(), before, 'no entry for a refused action');
  assert.equal((await Finding.findById(ids.finding)).severity, 'CRITICAL');

  // A short justification never reaches the target at all.
  const thin = await post({
    eventType: 'FINDING_DISMISSED',
    targetId: ids.finding,
    reasonCode: 'DUPLICATE_FINDING',
    justification: 'dupe',
  });
  assert.equal(thin.status, 400);
  assert.equal((await Finding.findById(ids.finding)).status, 'OPEN');
  assert.equal(await OverrideEvent.countDocuments(), before);
});

test('every one of the 8 F4 event types is recordable and chains', async () => {
  const cases = [
    {
      eventType: 'ASSIGNMENT_REASSIGNED',
      targetId: ids.assignment,
      reasonCode: 'WORKLOAD_REBALANCE',
      justification: 'Reassigned to balance the Nashik caseload for this cycle.',
      payload: { inspectorId: ids.other },
    },
    {
      eventType: 'INSTITUTE_EXEMPTED',
      targetId: ids.assignment,
      reasonCode: 'INSTITUTE_CLOSED',
      justification: 'Institute closed for the whole of the inspection window.',
    },
    {
      eventType: 'FINDING_DOWNGRADED',
      targetId: ids.finding,
      reasonCode: 'EVIDENCE_INSUFFICIENT',
      justification: 'The photographs do not establish the blocked exit as recorded.',
      payload: { severity: 'MEDIUM' },
    },
    {
      eventType: 'SLA_EXTENDED',
      targetId: ids.finding,
      reasonCode: 'PROCUREMENT_DELAY',
      justification: 'Fire-door procurement tender closes after the current deadline.',
      payload: { slaDueAt: '2026-05-01T00:00:00.000Z' },
    },
    {
      eventType: 'FINDING_DISMISSED',
      targetId: ids.finding,
      reasonCode: 'REMEDIED_ON_SITE',
      justification: 'Corrected in the presence of the inspecting officer that afternoon.',
    },
    {
      eventType: 'REPORT_REOPENED',
      targetId: ids.report,
      reasonCode: 'NEW_EVIDENCE',
      justification: 'A beneficiary submitted photographs after the report was closed.',
    },
    {
      eventType: 'RECORDING_ENABLED',
      targetId: ids.report, // §23 gives this a VCSession; the entry is the point
      reasonCode: 'BENEFICIARY_CONSENT',
      justification: 'Both beneficiaries gave recorded consent before the session began.',
    },
  ];

  let previous = await OverrideEvent.findOne().sort({ seq: -1 }).lean();
  for (const body of cases) {
    const { status, body: entry } = await post(body);
    assert.equal(status, 201, `${body.eventType}: ${JSON.stringify(entry)}`);
    assert.equal(entry.seq, previous.seq + 1);
    assert.equal(entry.prevHash, previous.entryHash, `${body.eventType} links to its predecessor`);
    previous = { seq: entry.seq, entryHash: entry.entryHash };
  }

  // ASSIGNMENT_CANCELLED was recorded in an earlier test — all 8, together.
  const recorded = await OverrideEvent.distinct('eventType');
  assert.equal(recorded.length, 8, `all 8 F4 event types recorded, got ${recorded.join(', ')}`);

  // The mutations actually happened.
  const [assignment, finding, report] = await Promise.all([
    Assignment.findById(ids.assignment),
    Finding.findById(ids.finding),
    InspectionReport.findById(ids.report),
  ]);
  assert.equal(String(assignment.inspectorId), ids.other);
  assert.equal(assignment.status, 'DEFERRED');
  assert.equal(finding.severity, 'MEDIUM');
  assert.equal(finding.status, 'CLOSED');
  assert.equal(+finding.slaDueAt, +new Date('2026-05-01T00:00:00.000Z'));
  assert.equal(report.status, 'REOPENED');

  assert.equal((await checkChain()).ok, true);
});

test('concurrent overrides serialise instead of forking the chain', async () => {
  const body = (n) => ({
    eventType: 'REPORT_REOPENED',
    targetId: ids.report,
    reasonCode: 'COMPLAINT_RECEIVED',
    justification: `Reopened on a beneficiary complaint received in week ${n} of the cycle.`,
  });

  const results = await Promise.all([1, 2, 3].map((n) => post(body(n))));
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 201, 201],
  );

  const seqs = results.map((r) => r.body.seq).sort((a, b) => a - b);
  assert.equal(new Set(seqs).size, 3, 'three distinct sequence numbers');
  assert.deepEqual(seqs, [seqs[0], seqs[0] + 1, seqs[0] + 2], 'contiguous, no fork');

  const chain = await checkChain();
  assert.equal(chain.ok, true, JSON.stringify(chain.break ?? {}));
});

test('a raw-driver retroactive edit is caught by verify-chain', async () => {
  const intact = await json(await call('/api/overrides/verify-chain', { token: tokens.auditor }));
  assert.equal(intact.body.ok, true);
  assert.ok(intact.body.entriesChecked > 1);
  assert.equal(intact.body.headHash, (await OverrideEvent.findOne().sort({ seq: -1 })).entryHash);

  // Straight at the collection, past Mongoose and past the plugin — the one
  // attack the hooks cannot stop. Softening a justification after the fact is
  // exactly the edit an officer under review would want to make.
  const target = await OverrideEvent.findOne({ seq: 2 }).lean();
  await mongoose.connection
    .collection('overrideevents')
    .updateOne(
      { _id: target._id },
      { $set: { justification: 'Routine administrative correction, no further action needed.' } },
    );

  const broken = await json(await call('/api/overrides/verify-chain', { token: tokens.auditor }));
  assert.equal(broken.status, 200, 'a tampered ledger is a finding, not a server error');
  assert.equal(broken.body.ok, false);
  assert.equal(broken.body.break.seq, 2, 'and it names the entry that was altered');
  assert.equal(broken.body.break.storedEntryHash, target.entryHash);
  assert.notEqual(broken.body.break.expectedEntryHash, target.entryHash);
  assert.equal(broken.body.entriesChecked, 1);

  // Put it back, so the tests after this one see an intact chain.
  await mongoose.connection
    .collection('overrideevents')
    .updateOne({ _id: target._id }, { $set: { justification: target.justification } });
  assert.equal((await checkChain()).ok, true);

  // A deleted entry breaks it too — the seq gap gives it away.
  const removed = await OverrideEvent.findOne({ seq: 3 }).lean();
  await mongoose.connection.collection('overrideevents').deleteOne({ _id: removed._id });
  const gapped = await checkChain();
  assert.equal(gapped.ok, false);
  assert.equal(gapped.break.seq, 4, 'the entry that should have been 3');

  await mongoose.connection.collection('overrideevents').insertOne(removed);
  assert.equal((await checkChain()).ok, true);
});

test('the nightly Merkle root anchors the ledger in its own collection', async () => {
  assert.equal(merkleRoot(['aa', 'bb']), merkleRoot(['aa', 'bb']));
  assert.notEqual(merkleRoot(['aa', 'bb']), merkleRoot(['bb', 'aa']), 'order-sensitive');
  assert.equal(merkleRoot(['aa']), 'aa');

  const anchor = await publishMerkleRoot();
  assert.match(anchor.root, /^[0-9a-f]{64}$/);
  assert.equal(anchor.fromSeq, 1);
  assert.equal(anchor.entryCount, await OverrideEvent.countDocuments());
  assert.equal(anchor.headHash, (await OverrideEvent.findOne().sort({ seq: -1 })).entryHash);

  // The anchor is what makes a rewrite contradict something already published:
  // change one entry and the root over the same range no longer matches.
  const entries = await OverrideEvent.find().sort({ seq: 1 }).select('entryHash').lean();
  const hashes = entries.map((e) => e.entryHash);
  assert.equal(merkleRoot(hashes), anchor.root);
  assert.notEqual(merkleRoot(['0'.repeat(64), ...hashes.slice(1)]), anchor.root);
});

test('officer rates flag an outlier and surface the three F4 patterns', async () => {
  // A second cycle for the same institute, so "exempted in consecutive cycles"
  // has two cycles to be consecutive across.
  const cycle2 = await InspectionCycle.create({
    periodStart: new Date('2026-02-01'),
    periodEnd: new Date('2026-03-01'),
    commitmentHash: 'e'.repeat(64),
    seed: 'b'.repeat(64),
    seedRevealed: true,
    revealedAt: new Date('2026-03-02'),
    status: 'REVEALED',
  });
  const assignment2 = await Assignment.create({
    cycleId: cycle2._id,
    instituteId: ids.institute,
    inspectorId: ids.other,
    allocationType: 'RANDOM',
    dueDate: new Date('2026-03-01'),
  });
  await post({
    eventType: 'INSTITUTE_EXEMPTED',
    targetId: String(assignment2._id),
    reasonCode: 'AUDIT_IN_PROGRESS',
    justification: 'A separate CAG audit of this institute is already under way.',
  });

  // Three downgrades from one institute by one officer — the concentration
  // metric. Each needs its own finding on this institute's report.
  const findings = await Finding.create(
    [1, 2, 3].map((n) => ({
      reportId: ids.report,
      severity: 'HIGH',
      category: `HYGIENE_${n}`,
    })),
  );
  for (const finding of findings) {
    const { status } = await post({
      eventType: 'FINDING_DOWNGRADED',
      targetId: String(finding._id),
      reasonCode: 'ASSESSMENT_ERROR',
      justification: `Recorded in error by the inspecting officer during visit ${finding.category}.`,
      payload: { severity: 'LOW' },
    });
    assert.equal(status, 201);
  }

  // DISTRICT is not on the allowlist for this panel — DIVISION owns it.
  const denied = await call('/api/overrides/officer-rates', { token: tokens.district });
  assert.equal(denied.status, 403);

  await User.create({
    email: 'division@example.test',
    name: 'V. Rao',
    role: 'DIVISION',
    passwordHash: await hashPassword(PASSWORD),
  });
  const divisionToken = (
    await json(
      await call('/api/auth/login', {
        method: 'POST',
        body: { email: 'division@example.test', password: PASSWORD },
      }),
    )
  ).body.token;

  const rates = await json(await call('/api/overrides/officer-rates', { token: divisionToken }));
  assert.equal(rates.status, 200);

  const busy = rates.body.officers.find((o) => o.name === 'D. Patil');
  const quiet = rates.body.officers.find((o) => o.name === 'S. Kale');
  assert.ok(busy.overrideCount > 0);
  assert.equal(quiet.overrideCount, 0);
  assert.ok(busy.decisionCount > 0, 'a Pune officer is measured against Pune inspections');
  assert.ok(busy.rate > quiet.rate);
  assert.ok(busy.sigmasFromMean > SIGMA_FLAG, `expected an outlier, got ${busy.sigmasFromMean}`);
  assert.equal(busy.flagged, true, 'the officer above 2σ is flagged');
  assert.equal(quiet.flagged, false);
  assert.equal(rates.body.peer.flagThreshold, rates.body.peer.mean + 2 * rates.body.peer.stdDev);
  assert.ok(busy.byEventType.FINDING_DOWNGRADED >= 3);

  const types = rates.body.patterns.map((p) => p.type);
  assert.ok(types.includes('CONSECUTIVE_EXEMPTION'), JSON.stringify(rates.body.patterns));
  assert.ok(types.includes('REPEAT_DOWNGRADE'));
  assert.ok(types.includes('LATE_REASSIGNMENT'));

  const exemption = rates.body.patterns.find((p) => p.type === 'CONSECUTIVE_EXEMPTION');
  assert.equal(exemption.instituteId, ids.institute);
  assert.deepEqual(exemption.cycles, [1, 2]);

  const downgrade = rates.body.patterns.find((p) => p.type === 'REPEAT_DOWNGRADE');
  assert.ok(downgrade.count >= 3);
  assert.equal(downgrade.instituteId, ids.institute);

  // The reassignment in the earlier test happened after this cycle's reveal.
  const late = rates.body.patterns.find((p) => p.type === 'LATE_REASSIGNMENT');
  assert.equal(late.assignmentId, ids.assignment);
  assert.ok(late.hoursAfterReveal > 0);
});
