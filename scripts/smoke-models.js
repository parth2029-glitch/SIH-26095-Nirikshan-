/**
 * §1 verification: insert and read back one doc of every model, then print the
 * indexes Mongo actually built.
 *
 *   npm run smoke:models                 # spins up an ephemeral Mongo
 *   MONGODB_URI=... npm run smoke:models # or point at a real one
 *
 * Throwaway per the plan — delete it once §15's real suites exist.
 */
import mongoose from 'mongoose';
import { connect, disconnect } from '../apps/api/db.js';
import { models } from '../apps/api/models.js';

const REQUIRED_INDEXES = {
  users: ['email_1'],
  institutes: ['location_2dsphere'],
  evidenceitems: ['sha256_1', 'dHashBands_1'],
  overrideevents: ['seq_1', 'actorId_1_at_1'],
  assignments: ['cycleId_1_instituteId_1'],
};

const oid = () => new mongoose.Types.ObjectId();
const now = new Date();

// One doc per model. Every required field is present, so a schema change that
// adds a required field fails here rather than in the seed script.
function fixtures() {
  return {
    User: {
      email: 'smoke@pmu.gov.in',
      // A real bcrypt hash shape; nothing here ever verifies it.
      passwordHash: '$2b$10$' + 'x'.repeat(53),
      name: 'Smoke User',
      role: 'DIVISION',
    },
    Institute: {
      name: 'Sunrise Boys Hostel',
      schemeType: 'HOSTEL',
      district: 'Pune',
      state: 'Maharashtra',
      location: { type: 'Point', coordinates: [73.8567, 18.5204] },
      reportedCapacity: 120,
      reportedOccupancy: 98,
    },
    Inspector: { name: 'A. Sharma', homeDistrict: 'Nagpur' },
    InspectionCycle: {
      periodStart: now,
      periodEnd: now,
      commitmentHash: 'a'.repeat(64),
      seed: 'b'.repeat(64),
    },
    Assignment: {
      cycleId: oid(),
      instituteId: oid(),
      inspectorId: oid(),
      allocationType: 'RANDOM',
      dueDate: now,
    },
    InspectionReport: {
      assignmentId: oid(),
      clientId: 'client-1',
      submittedAt: now,
      deviceSignals: { deviceId: 'dev-1', platform: 'android', rooted: false },
      gpsSeries: [{ at: now, lat: 18.5205, lng: 73.8566, accuracyM: 8, mocked: false }],
      answers: [{ questionId: 'hostel.hygiene.toilets', value: 'PARTIAL' }],
    },
    EvidenceItem: {
      reportId: oid(),
      storageKey: 'evidence/2026/10/x.jpg',
      sha256: 'c'.repeat(64),
      dHash: 'f0e1d2c3b4a59687',
      deviceDHash: 'f0e1d2c3b4a59687',
      dHashBands: ['0:f0', '1:e1', '2:d2', '3:c3', '4:b4', '5:a5', '6:96', '7:87'],
      capturedAt: now,
      location: { type: 'Point', coordinates: [73.8566, 18.5205], accuracyM: 8, mocked: false },
    },
    Finding: { reportId: oid(), severity: 'HIGH', category: 'HYGIENE', slaDueAt: now },
    OverrideEvent: {
      seq: 1,
      actorId: oid(),
      actorRole: 'DISTRICT',
      targetType: 'Assignment',
      targetId: oid(),
      eventType: 'ASSIGNMENT_CANCELLED',
      reasonCode: 'INSPECTOR_UNAVAILABLE',
      justification: 'Inspector hospitalised; institute rescheduled to the next cycle.',
      prevHash: '0'.repeat(64),
      entryHash: 'd'.repeat(64),
    },
    OccupancySnapshot: { instituteId: oid(), source: 'CCTV', count: 41, confidence: 0.92 },
  };
}

let memoryServer;

async function uri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create();
  console.log('No MONGODB_URI — using an ephemeral in-memory Mongo.\n');
  return memoryServer.getUri('nirikshan-smoke');
}

async function main() {
  await connect(await uri());
  await mongoose.connection.dropDatabase();

  const docs = fixtures();
  let failures = 0;

  for (const [name, Model] of Object.entries(models)) {
    const saved = await Model.create(docs[name]);
    // InspectionCycle.seed is select:false, so read it back explicitly.
    const found = await Model.findById(saved._id).select('+seed');
    if (!found) throw new Error(`${name}: saved but did not read back`);
    console.log(`ok  ${name.padEnd(18)} _id=${found._id}`);
  }

  console.log('\nIndexes:');
  for (const Model of Object.values(models)) {
    await Model.syncIndexes();
    const collection = Model.collection.collectionName;
    const built = (await Model.collection.indexes()).map((i) => i.name);
    console.log(`  ${collection.padEnd(20)} ${built.join(', ')}`);

    for (const required of REQUIRED_INDEXES[collection] ?? []) {
      if (!built.includes(required)) {
        console.error(`  MISSING: ${collection}.${required}`);
        failures++;
      }
    }
  }

  // seq and (cycleId, instituteId) must be unique, not merely indexed —
  // §5's idempotent assign and §6's ledger both rest on that.
  for (const [Model, doc, label] of [
    [models.OverrideEvent, docs.OverrideEvent, 'OverrideEvent.seq'],
    [models.Assignment, docs.Assignment, 'Assignment.cycleId+instituteId'],
  ]) {
    const rejected = await Model.create(doc).then(
      () => false,
      (err) => err.code === 11000,
    );
    console.log(`${rejected ? 'ok ' : 'FAIL'} duplicate ${label} rejected`);
    if (!rejected) failures++;
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  return failures;
}

let code = 1;
try {
  code = (await main()) ? 1 : 0;
} catch (err) {
  console.error(err);
} finally {
  await disconnect();
  await memoryServer?.stop();
}
process.exit(code);
