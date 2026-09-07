/**
 * §12 — the demo database. One command, no fixtures to hunt for.
 *
 *   npm run seed -- --reset          # ephemeral in-memory Mongo, nothing persists
 *   npm run seed -- --reset --serve  # …and keep the API up so you can open it
 *   MONGODB_URI=... npm run seed -- --reset
 *
 * 200 institutes, 30 inspectors, 12 cycles of history, and six planted fraud
 * signatures the detectors already in the tree have to find on their own.
 *
 * Three rules this file keeps:
 *
 *  - **Nothing is faked past the real code path.** Cycles are drawn by
 *    `POST /api/cycles/:id/assign` — the same transaction, the same input
 *    snapshot, the same engine — and every photograph is uploaded through
 *    `POST /api/reports/:id/evidence`, so `sharp` computes the dHash and the L1
 *    corpus fills the way it does in the field. A seed that wrote assignment
 *    rows directly would produce a database no verifier could replay.
 *  - **Deterministic.** Every id is minted from a counter and every choice from
 *    one seeded PRNG, so two runs produce the same institutes, the same draws,
 *    the same reports. The run prints a fingerprint over the draw; run it twice
 *    and compare the line.
 *  - **It checks its own plants.** The run ends by scoring the planted reports
 *    through `trustFor()` and reading the officer rates back through
 *    `computeOfficerRates()`. If a plant is not detectable the seed exits 1 —
 *    a demo database whose patterns nothing finds is worse than no database.
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import seedrandom from 'seedrandom';
import sharp from 'sharp';
import { ASSIGN_DEFAULTS, SEVERITIES } from '@nirikshan/core/constants';
import { canonicalJSON, reportSignaturePayload } from '@nirikshan/core/canonical';
import { fromHex } from '@nirikshan/core/dhash';
import { distance as hamming } from '@nirikshan/core/hamming';
import { createApp } from '../apps/api/app.js';
import { deviceHmacKey, hashPassword } from '../apps/api/auth.js';
import { commitmentOf } from '../apps/api/cycles.js';
import { computeOfficerRates, recordOverride } from '../apps/api/overrides.js';
import { trustFor } from '../apps/api/trust.js';
import {
  Assignment,
  EvidenceItem,
  Finding,
  InspectionCycle,
  InspectionReport,
  Inspector,
  Institute,
  User,
} from '../apps/api/models.js';

const RESET = process.argv.includes('--reset');
/**
 * Keep the API listening after the seed finishes.
 *
 * Without a `MONGODB_URI` the database is in-process and dies with this script,
 * so there would otherwise be no way to look at what was just built. With it,
 * one command gives a working stack: `npm run seed -- --reset --serve`.
 */
const SERVE = process.argv.includes('--serve');
const PORT = Number(process.env.SEED_PORT) || 4321;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURES = fileURLToPath(new URL('../fixtures/evidence/', import.meta.url));

const INSTITUTES = 200;
const INSPECTORS = 30;
const CYCLES = 12;
const FIXTURE_COUNT = 25;

/** Institute index → the signature the detectors are supposed to find (§12). */
const PLANTS = {
  17: 'GHOST_INTAKE',
  42: 'THRESHOLD_GAMING',
  88: 'EVIDENCE_REUSE',
  103: 'PREPARED_VISIT',
  156: 'INSPECTOR_CAPTURE',
  191: 'CLEAN',
};
/** #088's photograph comes back in these cycles, re-encoded so only L1 can see it. */
const REUSE_CYCLES = [4, 7, 11];
/** The captured inspector behind #156 — index into the roster. */
const CAPTURED_INSPECTOR = 7;
/** #103 is warned before every visit except these two. */
const SURPRISE_CYCLES = [6, 10];
/**
 * The hard negative: two genuinely different photographs of the same corridor,
 * four cycles apart. L1 must stay silent. Without this the seed proves only that
 * the detector fires, never that it discriminates.
 */
const HARD_NEGATIVE = { institute: 60, cycles: [5, 9], fixtures: [3, 17] };
/** #088's reused photograph. Reserved, like the hard negative's two. */
const REUSE_FIXTURE = 9;

/** The funding cut-off #042 games: occupancy as a share of sanctioned capacity. */
const FUNDING_CUTOFF = 0.75;

const DISTRICTS = [
  ['Pune', 73.8567, 18.5204],
  ['Mumbai Suburban', 72.8777, 19.076],
  ['Thane', 72.9781, 19.2183],
  ['Nashik', 73.7898, 19.9975],
  ['Nagpur', 79.0882, 21.1458],
  ['Chhatrapati Sambhajinagar', 75.3433, 19.8762],
  ['Amravati', 77.7796, 20.9374],
  ['Kolhapur', 74.2433, 16.705],
  ['Solapur', 75.9064, 17.6599],
  ['Latur', 76.5604, 18.4088],
  ['Nanded', 77.321, 19.1383],
  ['Satara', 74.0183, 17.6805],
];

const SCHEMES = [
  ['HOSTEL', 'Boys Hostel', 'hostel.v1'],
  ['SENIOR_HOME', 'Senior Citizens Home', 'senior-home.v1'],
  ['DEADDICTION_CENTRE', 'De-addiction Centre', 'deaddiction-centre.v1'],
];

const HOUSE_NAMES = [
  'Shivneri',
  'Ekvira',
  'Godavari',
  'Sahyadri',
  'Panchgani',
  'Vaitarna',
  'Krishna',
  'Bhima',
  'Wardha',
  'Purna',
  'Tapi',
  'Koyna',
  'Indrayani',
  'Mula',
  'Pavana',
  'Gomati',
  'Manjra',
  'Painganga',
  'Sina',
  'Girna',
];

const SURNAMES = [
  'Patil',
  'Deshmukh',
  'Kulkarni',
  'Jadhav',
  'Shinde',
  'Gaikwad',
  'More',
  'Pawar',
  'Bhosale',
  'Chavan',
  'Salunkhe',
  'Kadam',
  'Thorat',
  'Nikam',
  'Sawant',
];
const GIVEN = ['A.', 'B.', 'C.', 'D.', 'K.', 'M.', 'N.', 'P.', 'R.', 'S.', 'T.', 'V.'];

// ── Determinism ──────────────────────────────────────────────────────────────

const rng = seedrandom('nirikshan-2026-seed-v1');
const pick = (list) => list[Math.floor(rng() * list.length)];
const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (p) => rng() < p;

/**
 * Ids from a counter, not from a clock.
 *
 * Two runs have to produce the same database, and a real ObjectId carries the
 * moment it was minted. A counter is also monotonic in byte order, which the
 * engine depends on: `buildInputs` finds a cycle's C1 window with `_id: {$lt}`,
 * so an out-of-order cycle id would silently replay against the wrong history.
 */
let idCounter = 0;
const oid = () => new mongoose.Types.ObjectId((++idCounter).toString(16).padStart(24, '0'));

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cycleSeed = (index) => sha256Hex(`nirikshan-cycle-seed-v1:${index}`);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Read `fixtures/evidence/`, generating stand-ins when it is empty.
 *
 * The generated images are textured blocks, not gradients, so their dHashes
 * spread the way photographs do and L1 has something real to discriminate
 * between. They are still synthetic: §12's first two boxes stay open until
 * licence-clear photographs replace them, and §11's L9 threshold cannot be
 * measured off these — a device-vs-server distance taken from files this
 * process encoded itself would measure nothing but its own pipeline.
 */
async function fixtures() {
  await mkdir(FIXTURES, { recursive: true });
  const names = (await readdir(FIXTURES)).filter((n) => n.endsWith('.jpg')).sort();

  if (!names.length) {
    console.warn(
      `! fixtures/evidence/ is empty — generating ${FIXTURE_COUNT} synthetic stand-ins.\n` +
        '  Replace them with licence-clear photographs before the demo (§12).\n',
    );
    const paint = seedrandom('nirikshan-fixture-v1');
    const [w, h] = [800, 600];
    for (let i = 0; i < FIXTURE_COUNT; i++) {
      const cell = 20 + Math.floor(paint() * 60);
      const tint = [paint(), paint(), paint()];
      const raw = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // One tone per cell plus per-pixel grain: blocky and locally noisy, so
          // neighbouring fixtures land far apart in Hamming distance.
          const block = Math.sin((Math.floor(x / cell) * 7 + Math.floor(y / cell) * 13) * (i + 2));
          for (let c = 0; c < 3; c++) {
            const v = 128 + block * 90 * tint[c] + (paint() - 0.5) * 40;
            raw[(y * w + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
          }
        }
      }
      const name = `fixture-${String(i).padStart(2, '0')}.jpg`;
      const jpeg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
        .jpeg({ quality: 92 })
        .toBuffer();
      await writeFile(join(FIXTURES, name), jpeg);
      names.push(name);
    }
    names.sort();
  }

  const bytes = await Promise.all(names.map((n) => readFile(join(FIXTURES, n))));
  console.log(`fixtures  ${bytes.length} images from fixtures/evidence/`);
  return bytes;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function api(path, { token, method = 'POST', body, headers = {} } = {}) {
  const form = body instanceof FormData;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token && { authorization: `Bearer ${token}` }),
      ...(form ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: form ? body : body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const login = (email, password, deviceId) =>
  api('/api/auth/login', { body: { email, password, deviceId } });

// ── Content ──────────────────────────────────────────────────────────────────

const checklists = new Map();
async function checklist(file) {
  if (!checklists.has(file)) {
    checklists.set(
      file,
      JSON.parse(await readFile(new URL(`../apps/api/checklists/${file}.json`, import.meta.url))),
    );
  }
  return checklists.get(file);
}

const SLA_DAYS = { CRITICAL: 7, HIGH: 15, MEDIUM: 30, LOW: 60 };

/**
 * Fill one checklist. `quality` is the probability an item comes back compliant
 * — the single dial every planted signature turns.
 *
 * A failed item carries `failed` alongside its answer so the caller can raise a
 * Finding at the item's own severity. It is stripped before the report is
 * signed: the payload has to be exactly what a handset would have sent.
 */
function fillAnswers(spec, { quality, headcount, capacity }) {
  const answers = [];
  let photoSlots = 0;
  for (const section of spec.sections) {
    for (const item of section.items) {
      const ok = chance(quality);
      if (item.id === 'headcount') {
        answers.push({
          questionId: item.id,
          value: headcount,
          note: `Sanctioned capacity ${capacity}.`,
        });
        continue;
      }
      if (item.type === 'photo') {
        photoSlots++;
        answers.push({ questionId: item.id, value: null, note: '' });
        continue;
      }
      if (item.type === 'number') {
        answers.push({
          questionId: item.id,
          value: ok ? int(4, 12) : int(0, 2),
          note: ok ? '' : 'Below the sanctioned figure.',
        });
      } else if (item.type === 'bool') {
        answers.push({
          questionId: item.id,
          value: ok,
          note: ok ? '' : 'Not available on the day.',
        });
      } else if (item.type === 'choice') {
        const options = item.options.map((o) => o.value);
        answers.push({ questionId: item.id, value: ok ? options[0] : options.at(-1), note: '' });
      } else {
        answers.push({
          questionId: item.id,
          value: ok ? 'No adverse observation.' : 'Observed and recorded on site.',
          note: '',
        });
      }
      if (!ok)
        answers.at(-1).failed = { severity: item.severity, category: section.id, label: item.id };
    }
  }
  return { answers, photoSlots };
}

// ── Build ────────────────────────────────────────────────────────────────────

async function buildRoster(password) {
  // One bcrypt call for the whole roster: 45 accounts share a demo password, and
  // hashing it 45 times is 45× the cost for none of the benefit.
  const passwordHash = await hashPassword(password);

  const institutes = [];
  for (let i = 0; i < INSTITUTES; i++) {
    const [district, lng, lat] = DISTRICTS[i % DISTRICTS.length];
    const [schemeType, label, checklistFile] = SCHEMES[i % SCHEMES.length];
    const capacity = int(40, 160);
    const signature = PLANTS[i] ?? 'CLEAN';
    institutes.push({
      _id: oid(),
      name: `${HOUSE_NAMES[i % HOUSE_NAMES.length]} ${label}`,
      schemeType,
      checklistFile,
      ngoDarpanId: `MH/2026/${String(i).padStart(4, '0')}`,
      district,
      state: 'Maharashtra',
      // Jittered inside roughly 30 km of the district seat, so C4's 250 km
      // cluster check has real geography to bind against.
      location: {
        type: 'Point',
        coordinates: [lng + (rng() - 0.5) * 0.5, lat + (rng() - 0.5) * 0.5],
      },
      reportedCapacity: capacity,
      reportedOccupancy: Math.round(capacity * (0.6 + rng() * 0.3)),
      riskSignature: signature,
      riskScore: signature === 'CLEAN' ? int(0, 45) : int(55, 95),
      index: i,
    });
  }
  // The two plants that live in the institute record rather than in a report.
  institutes[17].reportedOccupancy = Math.round(institutes[17].reportedCapacity * 0.95);
  institutes[42].reportedOccupancy = Math.round(
    institutes[42].reportedCapacity * (FUNDING_CUTOFF + 0.01 + rng() * 0.02),
  );
  institutes[191].riskScore = int(0, 12);

  const inspectors = Array.from({ length: INSPECTORS }, (_, i) => ({
    _id: oid(),
    name: `${GIVEN[i % GIVEN.length]} ${SURNAMES[i % SURNAMES.length]}`,
    // Round-robin, so every district has inspectors from elsewhere: C2 forbids
    // inspecting your own district, and a clustered roster makes it unsatisfiable.
    homeDistrict: DISTRICTS[i % DISTRICTS.length][0],
    deviceId: `seed-device-${String(i).padStart(2, '0')}`,
    index: i,
  }));

  const users = [
    ...inspectors.map((ins, i) => ({
      _id: oid(),
      email: `inspector${String(i + 1).padStart(2, '0')}@example.test`,
      name: ins.name,
      role: 'INSPECTOR',
      inspectorId: ins._id,
      homeDistrict: ins.homeDistrict,
      passwordHash,
    })),
    ...DISTRICTS.map(([district]) => ({
      _id: oid(),
      email: `district.${district.toLowerCase().replace(/[^a-z]+/g, '-')}@example.test`,
      name: `${pick(GIVEN)} ${pick(SURNAMES)}`,
      role: 'DISTRICT',
      homeDistrict: district,
      passwordHash,
    })),
    { _id: oid(), email: 'division@example.test', name: 'V. Rao', role: 'DIVISION', passwordHash },
    {
      _id: oid(),
      email: 'auditor@example.test',
      name: 'CAG Observer',
      role: 'AUDITOR',
      passwordHash,
    },
    {
      _id: oid(),
      email: 'institute@example.test',
      name: `${institutes[17].name} Admin`,
      role: 'INSTITUTE',
      instituteId: institutes[17]._id,
      passwordHash,
    },
    {
      _id: oid(),
      email: 'beneficiary@example.test',
      name: 'R. Kumar',
      role: 'BENEFICIARY',
      passwordHash,
    },
  ];

  // `index` and `checklistFile` are the seed's own bookkeeping, not schema.
  await Institute.insertMany(institutes.map(({ index: _i, checklistFile: _c, ...doc }) => doc));
  await Inspector.insertMany(inspectors.map(({ index: _i, ...doc }) => doc));
  await User.insertMany(users);
  return { institutes, inspectors, users };
}

/** Twelve monthly periods, the last still open so §13 has live work to show. */
function periods() {
  const monthStart = (back) => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  };
  return Array.from({ length: CYCLES }, (_, i) => ({
    // The last period is the current month, so it is genuinely still running:
    // its seed cannot be revealed and its assignments are not yet overdue.
    periodStart: monthStart(CYCLES - 1 - i),
    periodEnd: monthStart(CYCLES - 2 - i),
    // The last period has not closed: its seed cannot be revealed and some of
    // its assignments are still out in the field.
    open: i === CYCLES - 1,
  }));
}

/** How compliant one report comes back — the dial every plant turns. */
function qualityFor(institute, inspector, cycleIndex) {
  if (inspector.index === CAPTURED_INSPECTOR) return 0.99; // #156's signature
  if (institute.index === 191) return 0.97; // the control
  if (institute.index === 103) return SURPRISE_CYCLES.includes(cycleIndex) ? 0.45 : 0.97;
  if (institute.index === 42) return 0.93; // gaming the metric, not the checklist
  if (institute.index === 17) return 0.8;
  return 0.72 + rng() * 0.22;
}

/** Successive quality-85 round trips of #088's photograph, one per reuse cycle. */
const reencoded = new Map();
/**
 * Which photographs one report carries.
 *
 * #088 sends the same picture in cycles 4, 7 and 11 — re-encoded at quality 85
 * for the later two, so the SHA-256 differs and L1 has to catch what L2 cannot.
 *
 * **Every other photograph is used exactly once, ever.** Handing two unrelated
 * inspections the same file is the precise thing L1 exists to catch, so a seed
 * that spread 25 fixtures over 2,000 reports would not be generating evidence —
 * it would be generating two thousand false positives and a trust score nobody
 * could read. Coverage is therefore bounded by the size of the image pool: drop
 * more licence-clear photographs into `fixtures/evidence/` and more reports get
 * evidence, one report per photograph.
 */
function shotsFor(institute, cycleIndex, images, pool) {
  if (institute.index === 88 && REUSE_CYCLES.includes(cycleIndex)) {
    const source = images[REUSE_FIXTURE % images.length];
    if (cycleIndex === REUSE_CYCLES[0]) return [source];
    // Each reuse is a further round trip, not the same re-encode twice: two
    // identical copies would be caught by L2's exact hash, and the point of the
    // plant is a reuse only L1's perceptual hash can see.
    if (!reencoded.has(cycleIndex)) {
      const previous = reencoded.get(REUSE_CYCLES[REUSE_CYCLES.indexOf(cycleIndex) - 1]) ?? source;
      reencoded.set(
        cycleIndex,
        Promise.resolve(previous).then((bytes) => sharp(bytes).jpeg({ quality: 85 }).toBuffer()),
      );
    }
    return [reencoded.get(cycleIndex)];
  }
  if (institute.index === HARD_NEGATIVE.institute && HARD_NEGATIVE.cycles.includes(cycleIndex)) {
    return [
      images[HARD_NEGATIVE.fixtures[HARD_NEGATIVE.cycles.indexOf(cycleIndex)] % images.length],
    ];
  }
  // Spread thinly rather than spent on the first cycle: `perCycle` leaves every
  // cycle, and so every screen of §13, something to look at.
  return pool.take(cycleIndex) ?? [];
}

/**
 * The unreserved fixtures, dealt out once each and spread across the cycles.
 */
function imagePool(images) {
  const reserved = new Set(
    [REUSE_FIXTURE, ...HARD_NEGATIVE.fixtures].map((i) => i % images.length),
  );
  const free = images.map((bytes, i) => ({ bytes, i })).filter(({ i }) => !reserved.has(i));
  const perCycle = Math.ceil(free.length / CYCLES);
  let dealt = 0;
  const spent = new Map();
  return {
    size: free.length,
    take(cycleIndex) {
      if (dealt >= free.length) return null;
      if ((spent.get(cycleIndex) ?? 0) >= perCycle) return null;
      spent.set(cycleIndex, (spent.get(cycleIndex) ?? 0) + 1);
      return [free[dealt++].bytes];
    },
  };
}

async function upload({ token, reportId, clientId, bytes, capturedAt, institute }) {
  const body = await bytes; // the re-encoded copy arrives as a promise
  const form = new FormData();
  form.set('file', new Blob([body], { type: 'image/jpeg' }), `${clientId}.jpg`);
  form.set('clientId', clientId);
  form.set('sha256', sha256Hex(body));
  form.set('capturedAt', capturedAt.toISOString());
  form.set(
    'location',
    JSON.stringify({
      // Well inside the geofence: L6 has to fire on a real deviation, not on
      // seed noise.
      coordinates: institute.location.coordinates.map((c) => c + (rng() - 0.5) * 0.0008),
      accuracyM: 12,
      mocked: false,
    }),
  );
  await api(`/api/reports/${reportId}/evidence`, { token, body: form });
}

async function main() {
  const started = Date.now();
  const password = passwordFromEnv();
  const images = await fixtures();

  if (RESET) {
    await mongoose.connection.dropDatabase();
    console.log('reset     database dropped');
  } else if (await Institute.exists({})) {
    // Without this the second run dies on a duplicate email, forty seconds in.
    throw new Error('This database already holds a roster — re-run with --reset to replace it.');
  }

  const { institutes, inspectors, users } = await buildRoster(password);
  const byInstituteId = new Map(institutes.map((i) => [String(i._id), i]));
  const byInspectorId = new Map(inspectors.map((i) => [String(i._id), i]));
  // The device key is derived from (user, device), so signing a report needs the
  // inspector's *account* id, not their roster id.
  const accountOf = new Map(
    users.filter((u) => u.inspectorId).map((u) => [String(u.inspectorId), String(u._id)]),
  );
  // Every finding lands on the district officer who has to answer for it —
  // §13's action queue is unusable without an owner column.
  const officerOf = new Map(
    users.filter((u) => u.role === 'DISTRICT').map((u) => [u.homeDistrict, u._id]),
  );
  console.log(`roster    ${institutes.length} institutes · ${inspectors.length} inspectors`);

  const server = createApp().listen(PORT);
  await new Promise((resolve) => server.once('listening', resolve));

  const division = await login('division@example.test', password);
  const tokens = new Map();
  for (const [i, ins] of inspectors.entries()) {
    const who = await login(
      `inspector${String(i + 1).padStart(2, '0')}@example.test`,
      password,
      ins.deviceId,
    );
    tokens.set(String(ins._id), who.token);
  }

  const draws = [];
  const pool = imagePool(images);
  const plants = { reuse: {}, hardNegative: {} };
  let reports = 0;
  let evidence = 0;
  let findings = 0;
  const now = new Date();

  for (const [index, period] of periods().entries()) {
    // Built here rather than through `POST /api/cycles` for one reason: the
    // endpoint mints `randomBytes(32)`, which is correct there and fatal to a
    // reproducible seed. Everything downstream — the draw, the snapshot, the
    // commitment — is the endpoint's own work, unchanged.
    const cycle = new InspectionCycle({
      _id: oid(),
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      randomShare: 1 - ASSIGN_DEFAULTS.targetedShare,
      targetedShare: ASSIGN_DEFAULTS.targetedShare,
      config: { ...ASSIGN_DEFAULTS },
    });
    cycle.seed = cycleSeed(index);
    cycle.commitmentHash = commitmentOf(cycle.seed, cycle.id);
    await cycle.save();

    const summary = await api(`/api/cycles/${cycle.id}/assign`, { token: division.token });
    const rows = await Assignment.find({ cycleId: cycle._id });

    const dayOf = new Map();
    const docs = [];
    const findingDocs = [];
    const uploads = [];

    for (const row of rows) {
      const institute = byInstituteId.get(String(row.instituteId));
      const inspector = byInspectorId.get(String(row.inspectorId));
      draws.push(`${index}|${institute.ngoDarpanId}|${inspector.name}|${row.allocationType}`);

      // A cycle is never fully returned: the stragglers are §13's overdue queue.
      // A planted institute always files — a plant nobody can look at is not one.
      const planted = institute.index in PLANTS || institute.index === HARD_NEGATIVE.institute;
      if (!planted && !chance(period.open ? 0.45 : 0.92)) continue;

      // One institute per inspector per day, so L5's implied speed stays inside
      // a day's driving — a whole cycle submitted at noon would flag everyone.
      // The open cycle wraps inside the days that have actually elapsed.
      const elapsed = Math.floor((now - period.periodStart) / 86_400_000);
      if (elapsed < 1) continue;
      const nth = (dayOf.get(inspector.index) ?? 0) + 1;
      dayOf.set(inspector.index, nth);
      const day = period.open ? ((nth - 1) % elapsed) + 1 : nth;
      const submittedAt = new Date(period.periodStart.getTime() + day * 86_400_000 + 5 * 3_600_000);
      if (submittedAt > now) continue;
      const capturedAt = new Date(submittedAt.getTime() - 2 * 3_600_000);

      const spec = await checklist(institute.checklistFile);
      const headcount =
        institute.index === 17
          ? Math.round(institute.reportedOccupancy / 2.4) // #017's ghost intake
          : Math.round(institute.reportedOccupancy * (0.92 + rng() * 0.12));
      const { answers } = fillAnswers(spec, {
        quality: qualityFor(institute, inspector, index),
        headcount,
        capacity: institute.reportedCapacity,
      });

      const reportId = oid();
      const body = {
        assignmentId: String(row._id),
        clientId: `seed-${index}-${institute.ngoDarpanId.replace(/\//g, '-')}`,
        submittedAt: submittedAt.toISOString(),
        capturedOffline: chance(0.35),
        deviceSignals: {
          deviceId: inspector.deviceId,
          platform: 'android',
          osVersion: '14',
          rooted: false,
          emulator: false,
          devModeEnabled: false,
          appVersion: '1.0.0',
        },
        gpsSeries: [
          {
            at: capturedAt,
            lat: institute.location.coordinates[1],
            lng: institute.location.coordinates[0],
            accuracyM: int(5, 18),
            mocked: false,
          },
        ],
        answers: answers.map(({ failed: _f, ...a }) => a),
      };
      // Signed with the key that device was issued at login, so every stored
      // signature verifies against `reports.js` exactly as a real one would.
      const signature = createHmac(
        'sha256',
        deviceHmacKey(accountOf.get(String(inspector._id)), inspector.deviceId),
      )
        .update(canonicalJSON(reportSignaturePayload(body)), 'utf8')
        .digest('hex');

      docs.push({
        _id: reportId,
        ...body,
        signature,
        status: period.open ? 'SUBMITTED' : 'ACCEPTED',
      });
      row.status = 'SUBMITTED';
      // The precondition the ledger cares about holds: an inspector finishing
      // their work, not an officer weakening a record (models.js).
      row.$locals.inspectionSubmitted = true;

      for (const answer of answers) {
        if (!answer.failed) continue;
        findingDocs.push({
          _id: oid(),
          reportId,
          severity: answer.failed.severity,
          category: answer.failed.category,
          description: `${answer.failed.label}: ${answer.note || 'recorded as non-compliant'}`,
          slaDueAt: new Date(submittedAt.getTime() + SLA_DAYS[answer.failed.severity] * 86_400_000),
          ownerId: officerOf.get(institute.district) ?? null,
          // Old findings mostly close; recent ones are §13's action queue.
          status:
            index < CYCLES - 3
              ? chance(0.85)
                ? 'CLOSED'
                : 'OPEN'
              : chance(0.45)
                ? 'ACTIONED'
                : 'OPEN',
        });
      }

      for (const [n, bytes] of shotsFor(institute, index, images, pool).entries()) {
        uploads.push({
          token: tokens.get(String(inspector._id)),
          reportId: String(reportId),
          clientId: `${body.clientId}-p${n}`,
          bytes,
          capturedAt,
          institute,
        });
      }
      if (institute.index === 88 && REUSE_CYCLES.includes(index)) {
        plants.reuse[index] = String(reportId);
      }
      if (institute.index === HARD_NEGATIVE.institute && HARD_NEGATIVE.cycles.includes(index)) {
        plants.hardNegative[index] = String(reportId);
      }
    }

    await InspectionReport.insertMany(docs);
    await Finding.insertMany(findingDocs);
    await Promise.all(rows.filter((r) => r.status === 'SUBMITTED').map((r) => r.save()));
    // Serial: every upload decodes and re-encodes with sharp, and firing 200 of
    // those at once buys nothing but memory.
    for (const item of uploads) await upload(item);

    reports += docs.length;
    findings += findingDocs.length;
    evidence += uploads.length;

    if (!period.open) {
      await api(`/api/cycles/${cycle.id}/reveal`, {
        token: division.token,
        body: { confirm: true },
      });
    }
    console.log(
      `cycle ${String(index + 1).padStart(2)}  ${summary.assignmentCount} assigned · ` +
        `${docs.length} reports · ${uploads.length} photos · ${summary.deferred.length} deferred`,
    );
  }

  const overrides = await plantOverrides();
  const failures = await verifyPlants(plants, overrides);

  if (!SERVE) server.close();
  console.log(
    `\ntotals    ${reports} reports · ${evidence} photographs · ${findings} findings · ` +
      `${overrides.total} override events`,
  );
  console.log(`draw      fingerprint ${sha256Hex(draws.sort().join('\n')).slice(0, 32)}`);
  console.log(`elapsed   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`\nlogin     division@example.test / ${password}`);
  console.log('          inspector01…30@, district.<name>@, auditor@, institute@ — same password');
  console.log('\nplants    open these — every §13 screen has something to show');
  for (const [cycleIndex, reportId] of Object.entries(plants.reuse)) {
    console.log(`          #088 EVIDENCE_REUSE, cycle ${cycleIndex}   /reports/${reportId}`);
  }
  for (const [cycleIndex, reportId] of Object.entries(plants.hardNegative)) {
    console.log(`          #060 hard negative, cycle ${cycleIndex}    /reports/${reportId}`);
  }

  if (SERVE) {
    console.log(`\nAPI       ${BASE}   ·   verification page ${BASE}/verify.html`);
    console.log(`dashboard API_URL=${BASE} npm run dash:dev`);
    console.log('\nCtrl+C to stop.');
  }
  return failures;
}

/**
 * Historical override events, with one district officer deliberately past 2σ.
 *
 * `recordOverride()` stamps its own `at`, so these land now rather than spread
 * through the year. That is the correct behaviour, not a limitation: the ledger
 * is the authority on when it was written, and a seed that backdated entries
 * would be forging exactly the record F4 exists to make unforgeable.
 */
async function plantOverrides() {
  const officers = await User.find({ role: 'DISTRICT' }).sort({ _id: 1 }).lean();
  const heavy = officers[0];
  const pending = await Assignment.find({ status: 'PENDING' }).select('_id instituteId').lean();
  const open = await Finding.find({ status: 'OPEN' })
    .select('_id severity slaDueAt')
    .limit(400)
    .lean();

  const districtOf = new Map(
    (await Institute.find().select('district').lean()).map((i) => [String(i._id), i.district]),
  );

  let total = 0;
  const record = async (actor, spec) => {
    await recordOverride({
      actor: { id: actor._id, role: actor.role, inspectorId: null },
      ...spec,
    });
    total++;
  };

  // The outlier: cancellations concentrated in one district, against peers who
  // only ever soften a finding here and there.
  const theirs = pending.filter(
    (a) => districtOf.get(String(a.instituteId)) === heavy.homeDistrict,
  );
  for (const assignment of theirs.slice(0, 12)) {
    await record(heavy, {
      eventType: 'ASSIGNMENT_CANCELLED',
      targetId: assignment._id,
      reasonCode: 'INSPECTOR_UNAVAILABLE',
      justification: 'Inspector withdrawn for district revenue duty; visit deferred to next cycle.',
    });
  }

  // The peers: a couple of softenings each. The event type follows what the
  // finding actually permits — a LOW finding cannot be downgraded further, and
  // `recordOverride()` is right to refuse rather than record a no-op.
  for (const [n, officer] of officers.slice(1).entries()) {
    for (const finding of open.slice(n * 2, n * 2 + 2)) {
      const lower = SEVERITIES[SEVERITIES.indexOf(finding.severity) - 1];
      await record(officer, {
        eventType: lower ? 'FINDING_DOWNGRADED' : 'SLA_EXTENDED',
        targetId: finding._id,
        reasonCode: lower ? 'REMEDIED_ON_SITE' : 'PROCUREMENT_DELAY',
        justification:
          'Remedial action verified in part; residual work scheduled with the institute.',
        payload: lower
          ? { severity: lower }
          : { slaDueAt: new Date(finding.slaDueAt.getTime() + 30 * 86_400_000) },
      });
    }
  }

  return { total, heavyId: String(heavy._id), heavyName: heavy.name };
}

// ── Self-check ───────────────────────────────────────────────────────────────

/** A planted pattern nothing can find is not a plant. Every one is read back. */
async function verifyPlants(plants, overrides) {
  const failures = [];
  const ok = (label, condition, detail = '') => {
    console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!condition) failures.push(label);
  };

  console.log('\nchecks');

  // #088 — L1 fires on the re-encoded copies and cites the original; L2 cannot,
  // which is the whole point of re-encoding them.
  const source = plants.reuse[REUSE_CYCLES[0]];
  for (const cycleIndex of REUSE_CYCLES.slice(1)) {
    const id = plants.reuse[cycleIndex];
    const trust = id && (await trustFor(await InspectionReport.findById(id)));
    const l1 = trust?.factors.find((f) => f.id === 'L1');
    const l2 = trust?.factors.find((f) => f.id === 'L2');
    ok(
      `#088 cycle ${cycleIndex} — L1 fires and cites the original, L2 stays silent`,
      Boolean(l1?.fired && l1.evidence?.matchedReportIds?.includes(source) && !l2?.fired),
      l1?.fired ? `hamming ${l1.evidence.hammingDistance}` : 'no L1 factor',
    );
  }

  // The hard negative — two different photographs of one corridor, no flag.
  const negatives = Object.values(plants.hardNegative);
  for (const id of negatives) {
    const trust = await trustFor(await InspectionReport.findById(id));
    ok('#060 hard negative — L1 stays silent', !trust.factors.find((f) => f.id === 'L1')?.fired);
  }
  if (negatives.length === 2) {
    const [a, b] = await Promise.all(
      negatives.map((id) => EvidenceItem.findOne({ reportId: id }).lean()),
    );
    const apart = a && b ? hamming(fromHex(a.dHash), fromHex(b.dHash)) : 0;
    ok(
      '#060 hard negative — the two photographs really are different',
      apart > 6,
      `hamming ${apart}`,
    );
  }

  const ghost = await occupancyRatio(17);
  ok(
    '#017 GHOST_INTAKE — reported ≈ 2.4× observed',
    ghost > 2.2 && ghost < 2.6,
    `ratio ${ghost.toFixed(2)}`,
  );

  const gamed = await Institute.findOne({ ngoDarpanId: 'MH/2026/0042' }).lean();
  const share = gamed.reportedOccupancy / gamed.reportedCapacity;
  ok(
    '#042 THRESHOLD_GAMING — 1–3% above the funding cut-off',
    share > FUNDING_CUTOFF && share < FUNDING_CUTOFF + 0.035,
    `${(share * 100).toFixed(1)}% against a ${FUNDING_CUTOFF * 100}% cut-off`,
  );

  const prepared = await findingRates(103);
  ok(
    '#103 PREPARED_VISIT — the two surprise visits fail far more',
    prepared.surprise > prepared.scheduled * 2,
    `${prepared.surprise.toFixed(2)} vs ${prepared.scheduled.toFixed(2)} findings/report`,
  );

  const capture = await inspectorFindingRate();
  ok(
    `#156 INSPECTOR_CAPTURE — inspector ${CAPTURED_INSPECTOR + 1} is anomalously clean`,
    capture.captured < capture.peerMean * 0.35,
    `${capture.captured.toFixed(2)} vs a peer mean of ${capture.peerMean.toFixed(2)}`,
  );

  const control = await Institute.findOne({ ngoDarpanId: 'MH/2026/0191' }).lean();
  ok(
    '#191 CLEAN — the control carries no signature',
    control.riskSignature === 'CLEAN' && control.riskScore < 20,
  );

  // Read back through the same code §14's override monitor calls.
  const rates = await computeOfficerRates({
    from: new Date(Date.now() - 365 * 86_400_000),
    to: new Date(),
  });
  const flagged = rates.officers.filter((o) => o.flagged);
  ok(
    'override monitor — exactly one officer above 2σ',
    flagged.length === 1 && flagged[0].actorId === overrides.heavyId,
    flagged.length
      ? `${flagged[0].name} at ${flagged[0].sigmasFromMean.toFixed(1)}σ`
      : 'nobody flagged',
  );

  return failures;
}

async function reportsFor(instituteIndex) {
  const institute = await Institute.findOne({
    ngoDarpanId: `MH/2026/${String(instituteIndex).padStart(4, '0')}`,
  }).lean();
  const rows = await Assignment.find({ instituteId: institute._id }).select('_id cycleId').lean();
  const reports = await InspectionReport.find({
    assignmentId: { $in: rows.map((r) => r._id) },
  }).lean();
  return { institute, rows, reports };
}

async function occupancyRatio(instituteIndex) {
  const { institute, reports } = await reportsFor(instituteIndex);
  const counts = reports
    .map((r) => r.answers.find((a) => a.questionId === 'headcount')?.value)
    .filter((v) => typeof v === 'number');
  const observed = counts.reduce((a, b) => a + b, 0) / (counts.length || 1);
  return institute.reportedOccupancy / (observed || 1);
}

/** Findings per report at one institute, split by whether the visit was a surprise. */
async function findingRates(instituteIndex) {
  const { rows, reports } = await reportsFor(instituteIndex);
  const cycles = await InspectionCycle.find().sort({ _id: 1 }).select('_id').lean();
  const indexOfCycle = new Map(cycles.map((c, i) => [String(c._id), i]));
  const cycleOfAssignment = new Map(
    rows.map((r) => [String(r._id), indexOfCycle.get(String(r.cycleId))]),
  );
  const counts = await Finding.aggregate([
    { $match: { reportId: { $in: reports.map((r) => r._id) } } },
    { $group: { _id: '$reportId', n: { $sum: 1 } } },
  ]);
  const byReport = new Map(counts.map((c) => [String(c._id), c.n]));

  const bucket = { surprise: [], scheduled: [] };
  for (const report of reports) {
    const index = cycleOfAssignment.get(String(report.assignmentId));
    const where = SURPRISE_CYCLES.includes(index) ? 'surprise' : 'scheduled';
    bucket[where].push(byReport.get(String(report._id)) ?? 0);
  }
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  return { surprise: mean(bucket.surprise), scheduled: mean(bucket.scheduled) };
}

/** Findings per report for the captured inspector against everyone else. */
async function inspectorFindingRate() {
  const inspectors = await Inspector.find().sort({ _id: 1 }).select('_id').lean();
  const inspectorOf = new Map(
    (await Assignment.find().select('_id inspectorId').lean()).map((a) => [
      String(a._id),
      String(a.inspectorId),
    ]),
  );
  const reports = await InspectionReport.find().select('_id assignmentId').lean();
  const byReport = new Map(
    (await Finding.aggregate([{ $group: { _id: '$reportId', n: { $sum: 1 } } }])).map((c) => [
      String(c._id),
      c.n,
    ]),
  );

  const totals = new Map();
  for (const report of reports) {
    const who = inspectorOf.get(String(report.assignmentId));
    const entry = totals.get(who) ?? { findings: 0, reports: 0 };
    entry.findings += byReport.get(String(report._id)) ?? 0;
    entry.reports++;
    totals.set(who, entry);
  }
  const rate = (id) => {
    const t = totals.get(String(id));
    return t?.reports ? t.findings / t.reports : 0;
  };
  const captured = inspectors[CAPTURED_INSPECTOR]._id;
  const peers = inspectors
    .filter((i) => String(i._id) !== String(captured))
    .map((i) => rate(i._id));
  return { captured: rate(captured), peerMean: peers.reduce((a, b) => a + b, 0) / peers.length };
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/** Same rule as `seed-users.js`: a real database demands an explicit password. */
function passwordFromEnv() {
  if (process.env.SEED_USER_PASSWORD) return process.env.SEED_USER_PASSWORD;
  if (process.env.MONGODB_URI) {
    throw new Error(
      'SEED_USER_PASSWORD is required when MONGODB_URI is set — copy .env.example to .env',
    );
  }
  return 'nirikshan-dev';
}

process.env.JWT_SECRET ??= 'seed-secret-not-for-any-real-deployment';
process.env.DEVICE_HMAC_SECRET ??= 'seed-device-secret';

let memoryServer;
async function uri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;
  // A replica set, not a standalone: the assign endpoint and the override ledger
  // both run in transactions, and Mongo only offers those on one.
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  console.log('No MONGODB_URI — using an ephemeral in-memory Mongo (nothing persists).\n');
  return memoryServer.getUri('nirikshan');
}

let code = 1;
try {
  await mongoose.connect(await uri());
  const failures = await main();
  code = failures.length ? 1 : 0;
  if (failures.length) console.error(`\n${failures.length} planted pattern(s) not detectable.`);
  // `--serve` holds the process open, and with it the in-memory database.
  if (SERVE && !failures.length) await new Promise(() => {});
} catch (err) {
  console.error(err);
} finally {
  await mongoose.disconnect();
  await memoryServer?.stop();
}
process.exit(code);
