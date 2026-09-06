/**
 * Override ledger (§6, PRD F4) — the differentiator, and the only door through
 * which this system can be weakened.
 *
 * The property this file has to preserve: **no application code path can
 * cancel an inspection, downgrade a finding or extend a deadline without
 * leaving an attributed, chained, tamper-evident record.**
 *
 *  - `recordOverride()` is the sole writer of `OverrideEvent`, and the sole
 *    mutator of Assignment / Finding / InspectionReport. Everything else is
 *    refused by the `requireOverride` plugin in models.js.
 *  - The ledger write and the target mutation share one transaction, so a
 *    cancelled inspection with no ledger entry is not a reachable state.
 *  - `entryHash = SHA-256(prevHash || canonicalJSON(payload))`. Editing any
 *    entry after the fact breaks every hash after it.
 *
 * Not a blockchain, deliberately: a hash chain plus a published nightly Merkle
 * root gives tamper-evidence and third-party verifiability at a fraction of
 * the complexity, and the trust assumption ("someone saw yesterday's root") is
 * one an audit office already satisfies.
 */
import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { canonicalJSON } from '@nirikshan/core/canonical';
import { REASON_CODES, SEVERITIES } from '@nirikshan/core/constants';
import { fail } from './auth.js';
import {
  Assignment,
  Finding,
  InspectionCycle,
  InspectionReport,
  Institute,
  MerkleRoot,
  OverrideEvent,
  User,
} from './models.js';

const MS_HOUR = 3_600_000;
const MS_DAY = 24 * MS_HOUR;

/** Same shape as `assign()`'s knobs: a threshold nobody can silently retune. */
const REPEAT_DOWNGRADE_MIN = 3;
const SIGMA_FLAG = 2;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The prevHash of the first entry. A row would be the more literal genesis, but
 * every field on `OverrideEvent` is required — actor, target, reason code, a
 * 20-character justification — and a genesis row can honestly supply none of
 * them. A fixed, published constant binds entry 1 just as tightly.
 */
export const GENESIS_HASH = '0'.repeat(64);

// Re-exported so §6's callers and tests keep one import site; the definition
// lives in core because §8's device signature hashes the same way.
export { canonicalJSON };

/**
 * The hashed material. `prevHash` and `entryHash` are excluded — the first is
 * prefixed separately, the second is the output. Everything else that describes
 * *who did what to whom, when and why* is inside, so altering any of it after
 * the fact is detectable.
 */
const entryPayload = (entry) => ({
  seq: entry.seq,
  actorId: entry.actorId,
  actorRole: entry.actorRole,
  targetType: entry.targetType,
  targetId: entry.targetId,
  eventType: entry.eventType,
  reasonCode: entry.reasonCode,
  justification: entry.justification,
  previousValue: entry.previousValue ?? null,
  at: entry.at,
});

export const hashEntry = (prevHash, entry) => sha256(prevHash + canonicalJSON(entryPayload(entry)));

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new HttpError(400, 'VALIDATION_FAILED', message);

/**
 * The 8 logged event types of PRD F4, each with the mutation it applies.
 *
 * `apply()` returns the patch; the keys it touches are exactly the keys read
 * off the document beforehand and stored as `previousValue`, so "what changed"
 * and "what it was" can never drift apart.
 */
const EVENTS = {
  ASSIGNMENT_CANCELLED: {
    targetType: 'Assignment',
    apply: () => ({ status: 'CANCELLED' }),
  },

  ASSIGNMENT_REASSIGNED: {
    targetType: 'Assignment',
    apply: (doc, payload) => {
      const to = String(payload?.inspectorId ?? '');
      if (!mongoose.isValidObjectId(to)) throw bad('payload.inspectorId must be an inspector id.');
      if (String(doc.inspectorId) === to)
        throw bad('That inspector already holds this assignment.');
      return { inspectorId: new mongoose.Types.ObjectId(to) };
    },
  },

  // Exemption is recorded against the assignment, not the institute: the
  // assignment is the thing removed, and it carries the cycle the exemption
  // applies to — which is what the consecutive-exemption metric counts.
  INSTITUTE_EXEMPTED: {
    targetType: 'Assignment',
    apply: () => ({ status: 'DEFERRED' }),
  },

  FINDING_DOWNGRADED: {
    targetType: 'Finding',
    apply: (doc, payload) => {
      const to = SEVERITIES.indexOf(payload?.severity);
      if (to < 0) throw bad(`payload.severity must be one of ${SEVERITIES.join(', ')}.`);
      if (to >= SEVERITIES.indexOf(doc.severity)) {
        throw bad(`A downgrade must lower the severity — it is already ${doc.severity}.`);
      }
      return { severity: payload.severity };
    },
  },

  FINDING_DISMISSED: {
    targetType: 'Finding',
    apply: () => ({ status: 'CLOSED' }),
  },

  SLA_EXTENDED: {
    targetType: 'Finding',
    apply: (doc, payload) => {
      const at = new Date(payload?.slaDueAt ?? NaN);
      if (Number.isNaN(+at)) throw bad('payload.slaDueAt must be a date.');
      if (doc.slaDueAt && at <= doc.slaDueAt)
        throw bad('An extension must move the deadline later.');
      return { slaDueAt: at };
    },
  },

  REPORT_REOPENED: {
    targetType: 'InspectionReport',
    apply: () => ({ status: 'REOPENED' }),
  },

  // ponytail: ledger-only — VCSession does not exist until §23, so this records
  // the decision without mutating anything. Add the model to TARGET_MODELS when
  // §23 lands and the entry starts flipping a real `recording` flag.
  RECORDING_ENABLED: {
    targetType: 'VCSession',
    apply: () => ({}),
  },
};

const TARGET_MODELS = { Assignment, Finding, InspectionReport };

const isDuplicateSeq = (err) =>
  (err?.code === 11000 || err?.cause?.code === 11000) &&
  JSON.stringify(err?.keyPattern ?? err?.cause?.keyPattern ?? {}).includes('seq');

/**
 * Append one entry to the ledger and apply the mutation it authorises.
 *
 * The **only** function that writes `OverrideEvent`, and the only one that can
 * modify a monitored record — the plugin in models.js rejects every other path.
 *
 * @param {{id: string, role: string, inspectorId?: string|null}} actor
 */
export async function recordOverride(
  { actor, eventType, targetId, reasonCode, justification, payload },
  { attempts = 3 } = {},
) {
  const spec = EVENTS[eventType];
  if (!spec) throw bad(`eventType must be one of ${Object.keys(EVENTS).join(', ')}.`);
  if (!REASON_CODES[reasonCode]) throw bad(`reasonCode must be one of the PRD F4 codes.`);
  if (!mongoose.isValidObjectId(String(targetId ?? ''))) throw bad('targetId must be an id.');

  const reason = String(justification ?? '').trim();
  if (reason.length < 20) throw bad('justification must be at least 20 characters.');

  const Model = TARGET_MODELS[spec.targetType] ?? null;

  for (let attempt = 1; ; attempt++) {
    const session = await mongoose.startSession();
    let event;
    try {
      // One transaction: the entry and the mutation land together or neither
      // does. A cancelled inspection with no ledger row is the exact state F4
      // exists to make unreachable.
      await session.withTransaction(async () => {
        const doc = Model ? await Model.findById(targetId).session(session) : null;
        if (Model && !doc) {
          throw new HttpError(404, 'NOT_FOUND', `No ${spec.targetType} with id ${targetId}.`);
        }

        // PRD §6 — nobody signs off on their own case.
        if (
          doc?.inspectorId &&
          actor.inspectorId &&
          String(doc.inspectorId) === actor.inspectorId
        ) {
          throw new HttpError(
            403,
            'SELF_APPROVAL_BLOCKED',
            'You are the subject of this action — another officer must record it.',
          );
        }

        const patch = spec.apply(doc, payload);
        const previousValue = doc
          ? Object.fromEntries(Object.keys(patch).map((key) => [key, doc[key] ?? null]))
          : null;

        // Read the head inside the transaction so a concurrent writer either
        // serialises behind us or collides on the unique `seq` index below —
        // it can never fork the chain.
        const head = await OverrideEvent.findOne().sort({ seq: -1 }).session(session).lean();
        const body = {
          seq: (head?.seq ?? 0) + 1,
          actorId: actor.id,
          actorRole: actor.role,
          targetType: spec.targetType,
          targetId,
          eventType,
          reasonCode,
          justification: reason,
          previousValue,
          at: new Date(),
        };
        const prevHash = head?.entryHash ?? GENESIS_HASH;
        event = new OverrideEvent({ ...body, prevHash, entryHash: hashEntry(prevHash, body) });

        if (doc) {
          Object.assign(doc, patch);
          doc.$locals.overrideId = event._id; // the plugin's only key past the door
          await doc.save({ session });
        }
        await event.save({ session });
      });
      return event;
    } catch (err) {
      // Two officers overriding in the same instant collide on `seq`. Retry:
      // the loser reads the new head and appends after it.
      if (isDuplicateSeq(err) && attempt < attempts) continue;
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

// ── Merkle anchoring ─────────────────────────────────────────────────────────

/** Pairwise SHA-256, last node duplicated on an odd level. */
export function merkleRoot(hashes) {
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2)
      next.push(sha256(level[i] + (level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0] ?? null;
}

/** Anchor the whole ledger as it stands. Returns null on an empty ledger. */
export async function publishMerkleRoot() {
  const entries = await OverrideEvent.find().sort({ seq: 1 }).select('seq entryHash').lean();
  if (!entries.length) return null;
  return MerkleRoot.create({
    root: merkleRoot(entries.map((e) => e.entryHash)),
    fromSeq: entries[0].seq,
    toSeq: entries.at(-1).seq,
    entryCount: entries.length,
    headHash: entries.at(-1).entryHash,
  });
}

/**
 * Run `publishMerkleRoot` once a night at `MERKLE_ROOT_HOUR_UTC`.
 *
 * A timer rather than `node-cron`: one dependency less, and §18 can adopt this
 * job into its cron schedule when it installs one for SLA escalation.
 */
export function startMerkleJob(hourUTC = Number(process.env.MERKLE_ROOT_HOUR_UTC ?? 20)) {
  const msUntilNextRun = () => {
    const next = new Date();
    next.setUTCHours(hourUTC, 0, 0, 0);
    if (next <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    return next - Date.now();
  };
  const tick = () =>
    setTimeout(async () => {
      try {
        const anchor = await publishMerkleRoot();
        if (anchor) console.log(`merkle: anchored ${anchor.entryCount} entries at ${anchor.root}`);
      } catch (err) {
        console.error('merkle: nightly anchor failed', err);
      }
      tick();
    }, msUntilNextRun()).unref();
  tick();
}

// ── Chain verification ───────────────────────────────────────────────────────

/**
 * Walk the chain from genesis and report the first break.
 *
 * Three ways to be broken, and a retroactive edit made with the raw driver — the
 * one attack the Mongoose plugin cannot stop — trips the first of them.
 */
export async function checkChain() {
  // ponytail: loads the whole ledger. A chain is only verifiable end to end, so
  // there is no partial walk — but at a few hundred thousand entries this wants
  // to resume from the last Merkle anchor and check forward from there.
  const entries = await OverrideEvent.find().sort({ seq: 1 }).lean();
  let prevHash = GENESIS_HASH;

  for (const [index, entry] of entries.entries()) {
    const expectedSeq = index + 1;
    const at = { seq: entry.seq, entryId: String(entry._id) };

    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        entriesChecked: index,
        break: {
          ...at,
          detail: `Expected entry ${expectedSeq} but found ${entry.seq} — an entry was removed or its sequence rewritten.`,
        },
      };
    }
    if (entry.prevHash !== prevHash) {
      return {
        ok: false,
        entriesChecked: index,
        break: {
          ...at,
          expectedPrevHash: prevHash,
          storedPrevHash: entry.prevHash,
          detail: `Entry ${entry.seq} does not link to entry ${entry.seq - 1} — the chain was cut or an entry inserted.`,
        },
      };
    }

    const expected = hashEntry(prevHash, entry);
    if (expected !== entry.entryHash) {
      return {
        ok: false,
        entriesChecked: index,
        break: {
          ...at,
          expectedEntryHash: expected,
          storedEntryHash: entry.entryHash,
          detail: `Entry ${entry.seq} does not hash to its stored value — its payload was altered after it was written.`,
        },
      };
    }
    prevHash = entry.entryHash;
  }

  return {
    ok: true,
    entriesChecked: entries.length,
    genesisAt: entries[0]?.at ?? null,
    headHash: entries.at(-1)?.entryHash ?? GENESIS_HASH,
  };
}

// ── Derived monitoring (PRD F4, "the actual innovation") ─────────────────────

/** Longest run of consecutive integers in a sorted, de-duplicated list. */
function longestRun(sorted) {
  let best = [];
  let run = [];
  for (const value of sorted) {
    run = run.length && value === run.at(-1) + 1 ? [...run, value] : [value];
    if (run.length > best.length) best = run;
  }
  return best;
}

/** The three per-institute / per-officer patterns from the PRD F4 table. */
async function detectPatterns(events) {
  const found = [];
  const ofType = (type) => events.filter((e) => e.eventType === type);

  const cycles = await InspectionCycle.find().sort({ _id: 1 }).select('revealedAt').lean();
  const cycleNumber = new Map(cycles.map((c, i) => [String(c._id), i + 1]));
  const revealedAt = new Map(cycles.map((c) => [String(c._id), c.revealedAt]));

  const assignments = new Map(
    (
      await Assignment.find({
        _id: { $in: events.filter((e) => e.targetType === 'Assignment').map((e) => e.targetId) },
      })
        .select('instituteId cycleId')
        .lean()
    ).map((a) => [String(a._id), a]),
  );

  // 1 — the same institute exempted in consecutive cycles.
  const exemptedCycles = new Map();
  for (const event of ofType('INSTITUTE_EXEMPTED')) {
    const assignment = assignments.get(String(event.targetId));
    if (!assignment) continue;
    const key = String(assignment.instituteId);
    const number = cycleNumber.get(String(assignment.cycleId));
    if (number) exemptedCycles.set(key, [...(exemptedCycles.get(key) ?? []), number]);
  }
  for (const [instituteId, numbers] of exemptedCycles) {
    const run = longestRun([...new Set(numbers)].sort((a, b) => a - b));
    if (run.length >= 2) {
      found.push({
        type: 'CONSECUTIVE_EXEMPTION',
        instituteId,
        cycles: run,
        detail: `Institute exempted in ${run.length} consecutive cycles.`,
      });
    }
  }

  // 2 — one officer repeatedly downgrading findings from one institute. Three
  // hops (Finding → report → assignment) because a finding does not carry the
  // institute it was raised against.
  const downgrades = ofType('FINDING_DOWNGRADED');
  const findings = await Finding.find({ _id: { $in: downgrades.map((e) => e.targetId) } })
    .select('reportId')
    .lean();
  const reports = await InspectionReport.find({ _id: { $in: findings.map((f) => f.reportId) } })
    .select('assignmentId')
    .lean();
  const instituteOfAssignment = new Map(
    (
      await Assignment.find({ _id: { $in: reports.map((r) => r.assignmentId) } })
        .select('instituteId')
        .lean()
    ).map((a) => [String(a._id), String(a.instituteId)]),
  );
  const assignmentOfReport = new Map(reports.map((r) => [String(r._id), String(r.assignmentId)]));
  const reportOfFinding = new Map(findings.map((f) => [String(f._id), String(f.reportId)]));

  const downgradeCounts = new Map();
  for (const event of downgrades) {
    const instituteId = instituteOfAssignment.get(
      assignmentOfReport.get(reportOfFinding.get(String(event.targetId))),
    );
    if (!instituteId) continue;
    const key = `${event.actorId}|${instituteId}`;
    downgradeCounts.set(key, (downgradeCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of downgradeCounts) {
    if (count < REPEAT_DOWNGRADE_MIN) continue;
    const [actorId, instituteId] = key.split('|');
    found.push({
      type: 'REPEAT_DOWNGRADE',
      actorId,
      instituteId,
      count,
      detail: `One officer downgraded ${count} findings from a single institute.`,
    });
  }

  // 3 — reassignment after the institute could have learned the schedule. The
  // reveal is that moment: before it, the pairing is sealed (§5).
  for (const event of ofType('ASSIGNMENT_REASSIGNED')) {
    const assignment = assignments.get(String(event.targetId));
    const revealed = assignment && revealedAt.get(String(assignment.cycleId));
    if (!revealed || event.at <= revealed) continue;
    found.push({
      type: 'LATE_REASSIGNMENT',
      assignmentId: String(event.targetId),
      actorId: String(event.actorId),
      hoursAfterReveal: Math.round((event.at - revealed) / MS_HOUR),
      detail: 'Reassigned after the schedule was knowable by the institute.',
    });
  }

  return found;
}

/**
 * Per-officer override rate against the peer mean, flagging anyone above 2σ.
 *
 * The denominator is the judgement call: an override count alone punishes the
 * busiest office. `decisionCount` is the inspections that passed through the
 * officer's jurisdiction in the window — every district assignment for a
 * DISTRICT officer, every assignment for a DIVISION one — so the rate reads as
 * "of the inspections you could have weakened, how many did you".
 */
export async function computeOfficerRates({ from, to, eventType }) {
  const [events, officers, assignments, institutes] = await Promise.all([
    OverrideEvent.find({ at: { $gte: from, $lte: to }, ...(eventType && { eventType }) }).lean(),
    User.find({ role: { $in: ['DISTRICT', 'DIVISION'] } })
      .select('name role homeDistrict')
      .lean(),
    Assignment.find({ createdAt: { $gte: from, $lte: to } })
      .select('instituteId')
      .lean(),
    Institute.find().select('district').lean(),
  ]);

  const districtOf = new Map(institutes.map((i) => [String(i._id), i.district]));
  const decisionsByDistrict = new Map();
  for (const assignment of assignments) {
    const district = districtOf.get(String(assignment.instituteId));
    decisionsByDistrict.set(district, (decisionsByDistrict.get(district) ?? 0) + 1);
  }

  const byActor = new Map();
  for (const event of events) {
    const key = String(event.actorId);
    const entry = byActor.get(key) ?? { count: 0, byEventType: {} };
    entry.count++;
    entry.byEventType[event.eventType] = (entry.byEventType[event.eventType] ?? 0) + 1;
    byActor.set(key, entry);
  }

  const rows = officers.map((officer) => {
    const stats = byActor.get(String(officer._id)) ?? { count: 0, byEventType: {} };
    const decisionCount =
      officer.role === 'DIVISION'
        ? assignments.length
        : (decisionsByDistrict.get(officer.homeDistrict) ?? 0);
    return {
      actorId: String(officer._id),
      name: officer.name,
      role: officer.role,
      district: officer.homeDistrict ?? null,
      overrideCount: stats.count,
      decisionCount,
      rate: decisionCount ? stats.count / decisionCount : 0,
      byEventType: stats.byEventType,
    };
  });

  // Officers with nothing to decide are excluded from the baseline: a district
  // with no inspections this window would otherwise drag the mean toward zero
  // and flag everyone else.
  const peers = rows.filter((r) => r.decisionCount > 0);
  const mean = peers.length ? peers.reduce((sum, r) => sum + r.rate, 0) / peers.length : 0;
  const variance = peers.length
    ? peers.reduce((sum, r) => sum + (r.rate - mean) ** 2, 0) / peers.length
    : 0;
  const stdDev = Math.sqrt(variance);
  const flagThreshold = mean + SIGMA_FLAG * stdDev;

  return {
    window: { from, to },
    peer: {
      mean,
      stdDev,
      flagThreshold,
      officerCount: peers.length,
    },
    officers: rows
      .map((row) => ({
        ...row,
        sigmasFromMean: stdDev ? (row.rate - mean) / stdDev : 0,
        // `stdDev === 0` means every peer overrides at the same rate — nobody is
        // an outlier, so nobody is flagged.
        flagged: stdDev > 0 && row.decisionCount > 0 && row.rate > flagThreshold,
      }))
      .sort((a, b) => b.rate - a.rate),
    patterns: await detectPatterns(events),
  };
}

// ── Route handlers ───────────────────────────────────────────────────────────

/** `POST /api/overrides` — DISTRICT, DIVISION. */
export async function postOverride(req, res) {
  const { eventType, targetId, reasonCode, justification, payload } = req.body ?? {};
  try {
    const event = await recordOverride({
      actor: { id: req.user.userId, role: req.user.role, inspectorId: req.user.inspectorId },
      eventType,
      targetId,
      reasonCode,
      justification,
      payload,
    });
    return res.status(201).json({
      id: event.id,
      seq: event.seq,
      actorId: String(event.actorId),
      actorRole: event.actorRole,
      eventType: event.eventType,
      targetType: event.targetType,
      targetId: String(event.targetId),
      reasonCode: event.reasonCode,
      justification: event.justification,
      previousValue: event.previousValue,
      prevHash: event.prevHash,
      entryHash: event.entryHash,
      at: event.at,
    });
  } catch (err) {
    if (err instanceof HttpError) return fail(res, err.status, err.code, err.message);
    throw err;
  }
}

/** `GET /api/overrides/verify-chain` — DIVISION, AUDITOR. */
export async function getVerifyChain(req, res) {
  // 200 either way: a tampered ledger is a finding about the data, not a server
  // fault, and a 500 would let a monitoring check mistake it for an outage.
  return res.json({ ...(await checkChain()), checkedAt: new Date() });
}

/** `GET /api/overrides/officer-rates` — DIVISION. */
export async function getOfficerRates(req, res) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 365 * MS_DAY);
  if (Number.isNaN(+from) || Number.isNaN(+to) || to <= from) {
    return fail(res, 400, 'VALIDATION_FAILED', 'from and to must be dates, with to after from.');
  }
  const eventType =
    req.query.eventType && req.query.eventType !== 'ALL' ? req.query.eventType : null;
  if (eventType && !EVENTS[eventType]) {
    return fail(res, 400, 'VALIDATION_FAILED', `Unknown eventType ${eventType}.`);
  }
  return res.json(await computeOfficerRates({ from, to, eventType }));
}
