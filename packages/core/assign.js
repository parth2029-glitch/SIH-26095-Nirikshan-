/**
 * Verifiable random assignment engine (§4, PRD F1).
 *
 * Constrained randomised greedy, deliberately not a solver: the constraint set
 * is satisfiable greedily, and a short function in plain JavaScript is one a
 * team can debug the night before a demo. An OR-Tools model is not.
 *
 * Pure and platform-neutral, because the point of F1 is that a stranger can
 * replay it. The same function runs on the server to produce the draw and in a
 * visitor's browser to check it, so it takes plain arrays and a seed string and
 * touches no clock, no database and no crypto. Everything the draw depends on
 * must arrive through these arguments — anything read from ambient state is a
 * value the public verifier cannot reproduce, which silently breaks F1.
 */
import seedrandom from 'seedrandom';
import { ASSIGN_DEFAULTS } from './constants.js';

export { ASSIGN_DEFAULTS };

const EARTH_RADIUS_KM = 6371;
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two GeoJSON coordinate pairs.
 *
 * @param {[number, number]} a `[lng, lat]` — GeoJSON order, as stored.
 * @param {[number, number]} b
 * @returns {number} kilometres
 */
export function haversineKm([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // Clamped: floating point pushes `a` a hair above 1 for near-antipodal
  // points, and asin() of anything over 1 is NaN.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

/** Fisher–Yates over a copy, drawing from the seeded PRNG. */
function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const coordsOf = (institute) => {
  const coords = institute.location?.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) {
    throw new RangeError(`institute ${institute.id} has no location.coordinates for C4`);
  }
  return coords;
};

/**
 * Draw inspector–institute pairings for one cycle.
 *
 * @param {{ id: string, district: string, riskScore?: number,
 *           location?: { coordinates: [number, number] } }[]} institutes
 *   Every institute due this cycle. Each gets an assignment or a deferral.
 * @param {{ id: string, homeDistrict: string, workloadCount?: number }[]} inspectors
 * @param {{ cycleId: string, instituteId: string, inspectorId: string }[]} history
 *   Past pairings, **newest cycle first** — C1's window is the first
 *   `noRepeatCycles` distinct `cycleId`s in this array, so the order is part of
 *   the input a verifier replays, not a caller's convenience.
 * @param {string} seed Hex seed revealed at the end of the cycle (PRD F1).
 * @param {Partial<typeof ASSIGN_DEFAULTS>} [config]
 * @returns {{ assignments: { instituteId: string, inspectorId: string,
 *             allocationType: 'RANDOM' | 'TARGETED' }[],
 *            deferred: { instituteId: string, reason: string }[],
 *            constraintRelaxations: { constraint: string, steps: number,
 *                                     affectedInstitutes: number }[] }}
 */
export function assign(institutes, inspectors, history = [], seed, config = {}) {
  const { noRepeatCycles, workloadTolerance, maxTravelKmPerDay, targetedShare } = {
    ...ASSIGN_DEFAULTS,
    ...config,
  };

  if (typeof seed !== 'string' || !seed) throw new TypeError('assign() needs the cycle seed');
  if (!inspectors?.length) throw new RangeError('assign() needs at least one inspector');
  for (const row of [...institutes, ...inspectors]) {
    // A missing id makes the output unmatchable against the stored assignments,
    // which reads as tampering on the public verification page.
    if (!row.id) throw new TypeError('every institute and inspector needs an `id`');
  }

  const rng = seedrandom(seed);
  const pool = shuffle(institutes, rng);

  // ── C1: pairings inside the no-repeat window ───────────────────────────────
  const recentCycles = new Set(
    [...new Set(history.map((h) => h.cycleId))].slice(0, noRepeatCycles),
  );
  const pairKey = (instituteId, inspectorId) => `${instituteId}|${inspectorId}`;
  const blocked = new Set(
    history
      .filter((h) => recentCycles.has(h.cycleId))
      .map((h) => pairKey(h.instituteId, h.inspectorId)),
  );

  // ── C5: the risk model may spend only the targeted share ───────────────────
  // Sorting the *shuffled* pool matters: sort is stable, so institutes on equal
  // risk keep their drawn order. Breaking ties by id would hand a permanent
  // advantage to whichever institute happened to be inserted first.
  const targeted = new Set(
    [...pool]
      .sort((a, b) => (b.riskScore ?? 0) - (a.riskScore ?? 0))
      .slice(0, Math.round(pool.length * targetedShare))
      .map((i) => i.id),
  );

  // ── C3: a cap, not a target. Filtering out the overloaded keeps the draw
  // uniform among whoever is left; picking the least-loaded would make the
  // schedule predictable, which is the one thing F1 exists to prevent.
  const load = new Map(inspectors.map((i) => [i.id, i.workloadCount ?? 0]));
  const carried = inspectors.reduce((total, i) => total + (i.workloadCount ?? 0), 0);
  const perCycle = pool.length / inspectors.length;
  const mean = (carried + pool.length) / inspectors.length;
  // The allowance is a share of *one cycle's* caseload, not of the running
  // total. Scaling it to the cumulative mean looks equivalent and is not: the
  // allowance then grows every cycle, so by cycle 12 the cap sits a dozen
  // assignments above the mean and stops binding at all. Measured over the
  // §4 simulation that drifts the pool to ±16%; anchored per cycle it holds
  // ±4%, at the cost of roughly one deferral per forty institutes.
  const cap = Math.max(1, Math.floor(mean + perCycle * workloadTolerance));

  // ── C4: institutes already drawn per inspector, for the cluster check ──────
  const placed = new Map(inspectors.map((i) => [i.id, []]));

  // ponytail: cluster diameter as a proxy for a routed schedule — a new
  // institute must sit within `maxTravelKmPerDay` of every one already drawn
  // for that inspector. It needs no dates and no road network, and it rules out
  // the failure that matters (one inspector holding institutes at opposite ends
  // of the state). Swap in per-day routing when §7 gives assignments real dates.
  const feasible = (inspector, institute) =>
    maxTravelKmPerDay == null ||
    placed
      .get(inspector.id)
      .every((other) => haversineKm(coordsOf(other), coordsOf(institute)) <= maxTravelKmPerDay);

  /** Inspectors passing every constraint, optionally ignoring one of them. */
  const survivors = (institute, capacity, skip) =>
    inspectors.filter(
      (ins) =>
        (skip === 'C1' || !blocked.has(pairKey(institute.id, ins.id))) &&
        (skip === 'C2' || ins.homeDistrict !== institute.district) &&
        (skip === 'C3' || load.get(ins.id) < capacity) &&
        (skip === 'C4' || feasible(ins, institute)),
    );

  const assignments = [];
  const deferred = [];
  let relaxedCount = 0;

  for (const institute of pool) {
    let candidates = survivors(institute, cap);

    // Relaxation, one step and one step only (PRD F1). Widening further would
    // trade away the workload guarantee without anyone deciding to.
    if (!candidates.length) {
      candidates = survivors(institute, cap + 1);
      if (candidates.length) relaxedCount++;
    }

    if (!candidates.length) {
      // Rare path, so the diagnosis can afford to be expensive: name the
      // constraints that would each have produced a candidate on their own.
      // That is what an officer needs to choose between an override and a
      // reschedule; "no candidate found" tells them nothing.
      const binding = ['C1', 'C2', 'C3', 'C4'].filter(
        (c) => survivors(institute, cap + 1, c).length > 0,
      );
      deferred.push({
        instituteId: institute.id,
        reason: binding.length
          ? `No inspector satisfied ${binding.join(' and ')} after relaxing C3 by one step.`
          : 'No inspector satisfied C1–C4 after relaxing C3 by one step.',
      });
      continue;
    }

    const pick = candidates[Math.floor(rng() * candidates.length)];
    load.set(pick.id, load.get(pick.id) + 1);
    if (maxTravelKmPerDay != null) placed.get(pick.id).push(institute);

    assignments.push({
      instituteId: institute.id,
      inspectorId: pick.id,
      allocationType: targeted.has(institute.id) ? 'TARGETED' : 'RANDOM',
    });
  }

  return {
    assignments,
    deferred,
    constraintRelaxations: relaxedCount
      ? [{ constraint: 'C3', steps: 1, affectedInstitutes: relaxedCount }]
      : [],
  };
}
