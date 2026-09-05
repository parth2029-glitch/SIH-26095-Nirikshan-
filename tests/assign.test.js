/**
 * §4 acceptance: the assignment engine is deterministic and satisfies C1–C4.
 *
 * The last test is the one the plan actually asks for — 12 cycles, 200
 * institutes, 30 inspectors, zero violations. The short tests above it exist so
 * that when the simulation goes red, it says which constraint broke.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSIGN_DEFAULTS, assign, haversineKm } from '@nirikshan/core/assign';

const at = (lng, lat) => ({ coordinates: [lng, lat] });

/** Deterministic 0–1 source for fixtures. Not the engine's PRNG. */
const lcg = (state) => () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;

test('haversine: known distances, and antipodes do not go NaN', () => {
  // Pune → Nagpur, 620 km great-circle (the 700 km figure people quote is the
  // road). C4 is a hard constraint, so a 10% error here is a silently
  // mis-scheduled inspector, not a rounding nit.
  assert.ok(Math.abs(haversineKm([73.86, 18.52], [79.09, 21.15]) - 620) < 15);
  assert.equal(haversineKm([73.86, 18.52], [73.86, 18.52]), 0);
  assert.ok(Number.isFinite(haversineKm([0, 90], [180, -90])));
});

test('same seed and inputs produce identical output; a new seed does not', () => {
  const institutes = Array.from({ length: 40 }, (_, i) => ({
    id: `i${i}`,
    district: `D${i % 5}`,
    riskScore: (i * 37) % 100,
    location: at(73 + (i % 5) * 0.4, 18 + (i % 7) * 0.2),
  }));
  const inspectors = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`,
    homeDistrict: `D${i % 5}`,
  }));

  const run = (seed) => assign(institutes, inspectors, [], seed);
  assert.deepEqual(run('a1b2'), run('a1b2'));
  assert.notDeepEqual(run('a1b2').assignments, run('c3d4').assignments);
  // Every institute placed, and the output order is the seeded draw order —
  // a verifier compares this array, so its order is part of the result.
  assert.equal(run('a1b2').assignments.length, 40);
});

test('C1: a pairing inside the no-repeat window is excluded, outside it is not', () => {
  const institutes = [{ id: 'inst', district: 'Pune', location: at(73.8, 18.5) }];
  const inspectors = [
    { id: 'recent', homeDistrict: 'Nagpur' },
    { id: 'stale', homeDistrict: 'Nashik' },
  ];
  // History is newest-cycle-first; with N=2 the window is c9 and c8 only.
  const history = [
    { cycleId: 'c9', instituteId: 'inst', inspectorId: 'recent' },
    { cycleId: 'c8', instituteId: 'other', inspectorId: 'stale' },
    { cycleId: 'c7', instituteId: 'inst', inspectorId: 'stale' },
  ];
  const config = { noRepeatCycles: 2, targetedShare: 0 };

  const { assignments } = assign(institutes, inspectors, history, 'seed', config);
  assert.equal(assignments[0].inspectorId, 'stale'); // 'recent' blocked by C1

  // Widen the window past c7 and the only remaining candidate is blocked too.
  const widened = assign(institutes, inspectors, history, 'seed', {
    ...config,
    noRepeatCycles: 3,
  });
  assert.equal(widened.assignments.length, 0);
  assert.match(widened.deferred[0].reason, /^No inspector satisfied C1 /);
});

test('C2: an inspector is never drawn for their own home district', () => {
  const institutes = [{ id: 'inst', district: 'Pune', location: at(73.8, 18.5) }];
  const inspectors = [{ id: 'local', homeDistrict: 'Pune' }];

  const { assignments, deferred } = assign(institutes, inspectors, [], 'seed');
  assert.deepEqual(assignments, []);
  assert.deepEqual(deferred, [
    { instituteId: 'inst', reason: 'No inspector satisfied C2 after relaxing C3 by one step.' },
  ]);
});

test('C3: the cap relaxes by exactly one step, and the relaxation is reported', () => {
  const institutes = Array.from({ length: 3 }, (_, i) => ({
    id: `i${i}`,
    district: 'Pune',
    location: at(73.8, 18.5),
  }));
  const inspectors = [
    { id: 'p0', homeDistrict: 'Nagpur' },
    { id: 'p1', homeDistrict: 'Nashik' },
  ];
  // mean 1.5, tolerance 0 → cap 1. The third institute needs the relaxed cap.
  const config = { workloadTolerance: 0, targetedShare: 0 };
  const { assignments, deferred, constraintRelaxations } = assign(
    institutes,
    inspectors,
    [],
    'seed',
    config,
  );

  assert.equal(assignments.length, 3);
  assert.deepEqual(deferred, []);
  assert.deepEqual(constraintRelaxations, [{ constraint: 'C3', steps: 1, affectedInstitutes: 1 }]);
  // Loads are 2 and 1 — the relaxed cap, never two steps past it.
  const loads = inspectors.map((p) => assignments.filter((a) => a.inspectorId === p.id).length);
  assert.deepEqual([...loads].sort(), [1, 2]);

  // One step and no more: with C2 locking p0 out of every institute, p1 fills
  // to the relaxed cap and the third institute defers rather than take a second
  // relaxation. Both binding constraints are named.
  const locked = assign(
    institutes,
    [{ id: 'p0', homeDistrict: 'Pune' }, inspectors[1]],
    [],
    'seed',
    config,
  );
  assert.equal(locked.assignments.length, 2);
  // Which institute loses out is the shuffle's business; that exactly one does,
  // and that the log names both binding constraints, is the engine's.
  assert.equal(locked.deferred.length, 1);
  assert.equal(
    locked.deferred[0].reason,
    'No inspector satisfied C2 and C3 after relaxing C3 by one step.',
  );
});

test('C4: an inspector never holds two institutes further apart than the cap', () => {
  // Two clusters 600 km apart, one inspector, cap 250 km: whichever cluster the
  // draw anchors on, the other one must defer rather than be flown to.
  const institutes = [
    { id: 'west1', district: 'Pune', location: at(73.86, 18.52) },
    { id: 'west2', district: 'Pune', location: at(73.9, 18.6) },
    { id: 'east1', district: 'Nagpur', location: at(79.09, 21.15) },
  ];
  const inspectors = [{ id: 'p0', homeDistrict: 'Nashik' }];
  const { assignments, deferred } = assign(institutes, inspectors, [], 'seed', {
    targetedShare: 0,
  });

  const districts = new Set(
    assignments.map((a) => institutes.find((i) => i.id === a.instituteId).district),
  );
  assert.equal(districts.size, 1);
  assert.ok(deferred.length >= 1);
  assert.match(deferred[0].reason, /C4/);
});

test('C5: the targeted share goes to the highest-risk institutes only', () => {
  const institutes = Array.from({ length: 100 }, (_, i) => ({
    id: `i${i}`,
    district: `D${i % 4}`,
    riskScore: i, // i99 is the riskiest
    location: at(73 + (i % 4) * 0.3, 18),
  }));
  const inspectors = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    homeDistrict: `D${i % 4}`,
  }));

  const { assignments } = assign(institutes, inspectors, [], 'seed', { maxTravelKmPerDay: null });
  const targeted = assignments.filter((a) => a.allocationType === 'TARGETED');
  assert.equal(targeted.length, 30); // the default 30% share
  assert.equal(assignments.length - targeted.length, 70);
  // The 30 riskiest, no one else — a risk score must never buy its way into the
  // random sample, nor a low score out of it (PRD F1 C5).
  assert.deepEqual(
    targeted.map((a) => Number(a.instituteId.slice(1))).sort((a, b) => a - b),
    Array.from({ length: 30 }, (_, k) => 70 + k),
  );

  const half = assign(institutes, inspectors, [], 'seed', {
    maxTravelKmPerDay: null,
    targetedShare: 0.5,
  });
  assert.equal(half.assignments.filter((a) => a.allocationType === 'TARGETED').length, 50);
});

test('12 cycles x 200 institutes x 30 inspectors: zero C1-C4 violations', () => {
  // Twelve districts on a 2-degree grid, ~220 km apart, so an inspector's
  // 250 km cluster covers a district and its immediate neighbours — the same
  // shape as a real division, which is what makes C4 a meaningful test here.
  const districts = Array.from({ length: 12 }, (_, i) => ({
    name: `D${i}`,
    lng: 73 + (i % 4) * 2,
    lat: 17 + Math.floor(i / 4) * 2,
  }));

  const rand = lcg(20260905);
  const institutes = Array.from({ length: 200 }, (_, i) => {
    const d = districts[i % 12];
    return {
      id: `inst-${i}`,
      district: d.name,
      riskScore: rand(),
      location: at(d.lng + (rand() - 0.5) * 0.3, d.lat + (rand() - 0.5) * 0.3),
    };
  });
  const byId = new Map(institutes.map((i) => [i.id, i]));

  const inspectors = Array.from({ length: 30 }, (_, i) => ({
    id: `insp-${i}`,
    homeDistrict: districts[i % 12].name,
    workloadCount: 0,
  }));

  const { noRepeatCycles, workloadTolerance, maxTravelKmPerDay } = ASSIGN_DEFAULTS;
  let history = [];
  let deferredTotal = 0;

  for (let cycle = 0; cycle < 12; cycle++) {
    const carried = inspectors.reduce((t, p) => t + p.workloadCount, 0);
    const cap = Math.floor(((carried + 200) / 30) * (1 + workloadTolerance));

    const { assignments, deferred } = assign(
      institutes,
      inspectors,
      history,
      `cycle-seed-${cycle}`,
      {},
    );
    deferredTotal += deferred.length;

    const window = new Set([...new Set(history.map((h) => h.cycleId))].slice(0, noRepeatCycles));
    const recent = new Set(
      history.filter((h) => window.has(h.cycleId)).map((h) => `${h.instituteId}|${h.inspectorId}`),
    );
    const drawn = new Map(inspectors.map((p) => [p.id, []]));

    for (const a of assignments) {
      const institute = byId.get(a.instituteId);
      const inspector = inspectors.find((p) => p.id === a.inspectorId);
      assert.ok(!recent.has(`${a.instituteId}|${a.inspectorId}`), `C1 cycle ${cycle}`);
      assert.notEqual(inspector.homeDistrict, institute.district, `C2 cycle ${cycle}`);
      drawn.get(a.inspectorId).push(institute);
    }

    for (const [inspectorId, list] of drawn) {
      const inspector = inspectors.find((p) => p.id === inspectorId);
      // C3 — the relaxed cap is the hard ceiling; one step is all the engine gets.
      assert.ok(
        inspector.workloadCount + list.length <= cap + 1,
        `C3 cycle ${cycle}: ${inspectorId} at ${inspector.workloadCount + list.length} over ${cap + 1}`,
      );
      // C4 — every pair in the cluster, not just consecutive ones.
      for (const a of list) {
        for (const b of list) {
          assert.ok(
            haversineKm(a.location.coordinates, b.location.coordinates) <= maxTravelKmPerDay,
            `C4 cycle ${cycle}: ${inspectorId}`,
          );
        }
      }
      inspector.workloadCount += list.length;
    }

    history = [...assignments.map((a) => ({ cycleId: `c${cycle}`, ...a })), ...history];
  }

  // C3 is only worth anything if the pool ends up balanced, not merely capped.
  const loads = inspectors.map((p) => p.workloadCount);
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  assert.ok(Math.max(...loads) <= mean * (1 + workloadTolerance), `max load ${Math.max(...loads)}`);
  assert.ok(Math.min(...loads) >= mean * (1 - workloadTolerance), `min load ${Math.min(...loads)}`);

  // Deferrals are logged, not violations — but an engine that gives up on a
  // tenth of the state is useless even with a clean constraint report.
  assert.ok(deferredTotal < 200 * 12 * 0.03, `deferred ${deferredTotal} of 2400`);
});
