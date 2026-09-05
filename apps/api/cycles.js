/**
 * Commit–reveal cycle endpoints (§5, PRD F1).
 *
 * The property this file has to preserve: a stranger, holding nothing but the
 * public `/verify` response and the published `assign()` source, reaches the
 * same assignment the server did. Everything here follows from that.
 *
 *  - The seed is minted server-side and never leaves until reveal.
 *  - The commitment binds the seed to the cycle id, published before the draw.
 *  - The engine's inputs are **snapshotted** at draw time (see `buildInputs`).
 *  - `/verify` publishes and does not judge. A server-computed "MATCH" from the
 *    same server that could have rigged the draw proves nothing, so the verdict
 *    is the browser's to compute.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ASSIGN_DEFAULTS, assign } from '@nirikshan/core/assign';
import { fail } from './auth.js';
import { Assignment, InspectionCycle, Inspector, Institute } from './models.js';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * `commitmentHash = SHA-256(seed || cycleId)` (PRD F1).
 *
 * `||` is UTF-8 concatenation of the 64-char hex seed and the 24-char ObjectId
 * string. The browser recomputes this byte-for-byte with `crypto.subtle`, so
 * the encoding is part of the published contract, not an internal detail.
 */
export const commitmentOf = (seed, cycleId) => sha256(`${seed}${cycleId}`);

/** Never spread a cycle document into a response — `seed` would ride along. */
const publicCycle = (cycle) => ({
  id: cycle.id,
  periodStart: cycle.periodStart,
  periodEnd: cycle.periodEnd,
  commitmentHash: cycle.commitmentHash,
  commitmentPublishedAt: cycle.commitmentPublishedAt,
  randomShare: cycle.randomShare,
  targetedShare: cycle.targetedShare,
  status: cycle.status,
  seedRevealed: cycle.seedRevealed,
});

/**
 * The engine knobs, validated. A cycle is replayed against its own stored
 * config, so a nonsense value here is not merely a bad draw — it is a cycle
 * nobody can verify. `noRepeatCycles` also reaches a query `.limit()`.
 */
function readConfig(input = {}, targetedShare) {
  const config = { ...ASSIGN_DEFAULTS, ...input, targetedShare };
  const finite = (key, min, max) =>
    Number.isFinite(config[key]) && config[key] >= min && config[key] <= max;

  if (!Number.isInteger(config.noRepeatCycles) || config.noRepeatCycles < 0)
    return 'config.noRepeatCycles must be a non-negative integer.';
  if (!finite('workloadTolerance', 0, 10)) return 'config.workloadTolerance must be 0–10.';
  if (config.maxTravelKmPerDay !== null && !finite('maxTravelKmPerDay', 0, 20_037))
    return 'config.maxTravelKmPerDay must be 0–20037, or null to disable C4.';
  return config;
}

/**
 * Build the arguments for one call to `assign()`.
 *
 * Called **once per cycle**, at draw time, and the result is stored on the
 * cycle. Rebuilding it at verify time would read today's `riskScore` and
 * `workloadCount` — values the risk model and the next draw both move — and
 * report an honest cycle as tampered.
 */
async function buildInputs(cycle) {
  const [institutes, inspectors] = await Promise.all([
    Institute.find().select('district riskScore location').sort({ _id: 1 }).lean(),
    Inspector.find().select('homeDistrict workloadCount').sort({ _id: 1 }).lean(),
  ]);

  // Prior cycles newest-first by `_id`, not by `periodStart`: ObjectId order is
  // immutable and is the order the draws actually happened in. Ordering on a
  // mutable date would let a backdated cycle silently rewrite a past cycle's C1
  // window, and with it that cycle's replay.
  const prior = await InspectionCycle.find({ _id: { $lt: cycle._id } })
    .sort({ _id: -1 })
    .limit(cycle.config.noRepeatCycles)
    .select('_id')
    .lean();

  // Only the C1 window is fetched. The engine reads no further back, and an
  // unbounded history would grow the public /verify payload without limit.
  const rank = new Map(prior.map((c, i) => [String(c._id), i]));
  const history = (
    await Assignment.find({ cycleId: { $in: prior.map((c) => c._id) } })
      .select('cycleId instituteId inspectorId')
      .lean()
  )
    .map((a) => ({
      cycleId: String(a.cycleId),
      instituteId: String(a.instituteId),
      inspectorId: String(a.inspectorId),
    }))
    // Newest cycle first, as assign() documents. Tie-broken on instituteId so
    // the snapshot does not depend on Mongo's natural order.
    .sort(
      (a, b) =>
        rank.get(a.cycleId) - rank.get(b.cycleId) || a.instituteId.localeCompare(b.instituteId),
    );

  return {
    institutes: institutes.map((i) => ({
      id: String(i._id),
      district: i.district,
      riskScore: i.riskScore ?? 0,
      location: { coordinates: i.location.coordinates },
    })),
    inspectors: inspectors.map((i) => ({
      id: String(i._id),
      homeDistrict: i.homeDistrict,
      workloadCount: i.workloadCount ?? 0,
    })),
    history,
  };
}

/** Counts read back from the stored rows, so a replayed call reports the truth. */
async function storedSummary(cycle, created) {
  const rows = await Assignment.find({ cycleId: cycle._id }).select('allocationType').lean();
  const byAllocationType = { RANDOM: 0, TARGETED: 0 };
  for (const row of rows) byAllocationType[row.allocationType]++;
  return {
    cycleId: cycle.id,
    created,
    assignmentCount: rows.length,
    byAllocationType,
    deferred: cycle.deferred,
    constraintRelaxations: cycle.constraintRelaxations,
  };
}

/** `POST /api/cycles` — DIVISION. Mints the seed and publishes the commitment. */
export async function createCycle(req, res) {
  const { periodStart, periodEnd, randomShare, targetedShare, config } = req.body ?? {};

  const start = new Date(periodStart ?? NaN);
  const end = new Date(periodEnd ?? NaN);
  if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) {
    return fail(
      res,
      400,
      'VALIDATION_FAILED',
      'periodStart and periodEnd must be dates, with periodEnd after periodStart.',
    );
  }

  // One number, two fields: the shares are stored separately for display but
  // derived from a single value so a cycle cannot exist whose shares miss 1.
  const targeted = targetedShare ?? (randomShare != null ? 1 - randomShare : undefined);
  if (targeted !== undefined && !(Number.isFinite(targeted) && targeted >= 0 && targeted <= 1)) {
    return fail(res, 400, 'VALIDATION_FAILED', 'targetedShare must be a number between 0 and 1.');
  }
  if (
    randomShare != null &&
    targetedShare != null &&
    Math.abs(randomShare + targetedShare - 1) > 1e-9
  ) {
    return fail(res, 400, 'VALIDATION_FAILED', 'randomShare and targetedShare must sum to 1.');
  }

  // The share is accepted at either level — top-level wins — because a request
  // that sets only `config.targetedShare` otherwise looks accepted and draws a
  // different split than it asked for.
  const resolved = readConfig(
    config,
    targeted ?? config?.targetedShare ?? ASSIGN_DEFAULTS.targetedShare,
  );
  if (typeof resolved === 'string') return fail(res, 400, 'VALIDATION_FAILED', resolved);

  // Mongoose mints the `_id` client-side, so the commitment can bind to the
  // cycle id before the row exists — and this row is the first thing written
  // for the cycle, necessarily ahead of any Assignment (§5).
  const cycle = new InspectionCycle({
    periodStart: start,
    periodEnd: end,
    randomShare: 1 - resolved.targetedShare,
    targetedShare: resolved.targetedShare,
    config: resolved,
  });
  const seed = randomBytes(32).toString('hex');
  cycle.seed = seed;
  cycle.commitmentHash = commitmentOf(seed, cycle.id);
  await cycle.save();

  return res.status(201).json(publicCycle(cycle));
}

/** `POST /api/cycles/:id/assign` — DIVISION. Runs the engine. Idempotent. */
export async function assignCycle(req, res) {
  const cycle = await InspectionCycle.findById(req.params.id).select('+seed');
  if (!cycle) return fail(res, 404, 'NOT_FOUND', `No cycle with id ${req.params.id}.`);
  if (cycle.inputs) return res.json(await storedSummary(cycle, false));

  const inputs = await buildInputs(cycle);
  const result = assign(inputs.institutes, inputs.inspectors, inputs.history, cycle.seed, {
    ...cycle.config,
  });

  if (!result.assignments.length) {
    return fail(
      res,
      422,
      'CONSTRAINTS_UNSATISFIABLE',
      'No institute could be assigned under C1–C4 — widen the inspector pool or the config.',
      { deferred: result.deferred },
    );
  }

  const summary = {
    cycleId: cycle.id,
    created: true,
    assignmentCount: result.assignments.length,
    byAllocationType: result.assignments.reduce(
      (counts, a) => ({ ...counts, [a.allocationType]: counts[a.allocationType] + 1 }),
      { RANDOM: 0, TARGETED: 0 },
    ),
    deferred: result.deferred,
    constraintRelaxations: result.constraintRelaxations,
  };

  if (req.body?.dryRun) return res.json({ ...summary, created: false, dryRun: true });

  try {
    // The unique (cycleId, instituteId) index is the concurrency guard: two
    // simultaneous calls race here, and the loser gets E11000 rather than a
    // second set of assignments.
    // ponytail: no transaction, so a crash between these two writes leaves
    // rows without their snapshot and /verify with nothing to publish. Wrap
    // both in the session §6 introduces for the ledger, once a replica set is
    // a hard requirement anyway.
    await Assignment.insertMany(
      result.assignments.map((a) => ({
        cycleId: cycle._id,
        instituteId: a.instituteId,
        inspectorId: a.inspectorId,
        allocationType: a.allocationType,
        dueDate: cycle.periodEnd,
      })),
    );
  } catch (err) {
    if (err.code !== 11000 && err.cause?.code !== 11000) throw err;
    return res.json(await storedSummary(cycle, false));
  }

  cycle.inputs = inputs;
  cycle.deferred = result.deferred;
  cycle.constraintRelaxations = result.constraintRelaxations;
  cycle.status = 'ASSIGNED';
  await cycle.save();

  return res.json(summary);
}

/** `POST /api/cycles/:id/reveal` — DIVISION. Opens the seed, closes the cycle. */
export async function revealCycle(req, res) {
  if (req.body?.confirm !== true) {
    return fail(res, 400, 'VALIDATION_FAILED', 'confirm: true is required to reveal a seed.');
  }

  const cycle = await InspectionCycle.findById(req.params.id).select('+seed');
  if (!cycle) return fail(res, 404, 'NOT_FOUND', `No cycle with id ${req.params.id}.`);
  if (cycle.seedRevealed) {
    return fail(res, 400, 'SEED_ALREADY_REVEALED', 'This cycle’s seed is already public.');
  }

  // Two ways to be "still open", one error. Revealing before the draw publishes
  // a seed for assignments that do not exist; revealing before the period ends
  // hands every institute the date and the inspector it was about to receive —
  // which is the surprise F1 exists to protect.
  const stillOpen =
    cycle.status === 'OPEN'
      ? 'No draw has been run for this cycle yet.'
      : Date.now() < cycle.periodEnd.getTime()
        ? 'The inspection period has not closed yet.'
        : null;
  if (stillOpen) {
    return fail(res, 400, 'CYCLE_STILL_OPEN', stillOpen, {
      closesAt: cycle.periodEnd.toISOString(),
    });
  }

  cycle.seedRevealed = true;
  cycle.revealedAt = new Date();
  cycle.status = 'REVEALED';
  await cycle.save();

  return res.json({
    cycleId: cycle.id,
    status: cycle.status,
    seed: cycle.seed,
    commitmentHash: cycle.commitmentHash,
    revealedAt: cycle.revealedAt,
  });
}

/**
 * `GET /api/cycles/:id/verify` — **public**. Everything, and no verdict.
 *
 * Deliberately never calls `assign()`. The server that could have rigged the
 * draw is the last party whose "MATCH" is worth anything; the replay belongs to
 * the reader's browser (apps/dashboard/public/verify.html).
 */
export async function verifyCycle(req, res) {
  const cycle = await InspectionCycle.findById(req.params.id).select('+seed');
  if (!cycle) return fail(res, 404, 'NOT_FOUND', `No cycle with id ${req.params.id}.`);

  // Before reveal the pairings stay sealed — publishing them early is exactly
  // the forewarning the commitment exists to prevent. The commitment itself is
  // already public, so its timestamp remains checkable against the draw date.
  const assignments = cycle.seedRevealed
    ? await Assignment.find({ cycleId: cycle._id })
        .select('instituteId inspectorId allocationType dueDate')
        .sort({ _id: 1 })
        .lean()
    : [];

  return res.json({
    cycle: {
      ...publicCycle(cycle),
      seed: cycle.seedRevealed ? cycle.seed : null,
      revealedAt: cycle.revealedAt ?? null,
      config: cycle.config,
    },
    inputs: cycle.inputs ?? null,
    assignments: assignments.map((a) => ({
      instituteId: String(a.instituteId),
      inspectorId: String(a.inspectorId),
      allocationType: a.allocationType,
      dueDate: a.dueDate,
    })),
    deferred: cycle.deferred,
    constraintRelaxations: cycle.constraintRelaxations,
  });
}
