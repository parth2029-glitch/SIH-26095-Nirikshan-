/**
 * The three list reads §13's dashboard is built on, plus one report detail.
 *
 * Everything here is derived, never stored:
 *
 *  - **Overdue is computed, not recorded.** An assignment is overdue when it is
 *    still PENDING past its due date — a fact about the clock, not a decision
 *    anyone made. Writing it to `Assignment.status` would mean a nightly job
 *    mutating a monitored record, which §6's ledger would (rightly) refuse.
 *  - **Scope is a query filter, not a response filter.** `scopeOf()` narrows the
 *    `instituteId` set before Mongo is asked, so an out-of-scope row is never
 *    read, never serialised, and never one forgotten `delete` away from leaking.
 *    A DISTRICT token that asks for the whole state gets its own district; the
 *    UI hiding a tab is decoration on top of this, not a substitute for it.
 *  - **Trust scores are not in the list.** They are computed on read (§11) and a
 *    list view that scored 200 reports would run 200 corpus scans. The list
 *    carries what routes attention — severity, SLA state, days open — and the
 *    score is fetched when a report is actually opened.
 */
import mongoose from 'mongoose';
import { fail } from './auth.js';
import {
  Assignment,
  EvidenceItem,
  Finding,
  InspectionCycle,
  InspectionReport,
  Institute,
} from './models.js';

const MS_DAY = 86_400_000;
/** Inside this many days of the SLA date, a finding is worth chasing. */
const DUE_SOON_DAYS = 3;

/**
 * The institute ids this token may see, or `null` for "everything".
 *
 * DIVISION and AUDITOR hold portfolio-wide visibility by role. DISTRICT is
 * narrowed to its own district and INSTITUTE to its own record — both from the
 * token's claims, never from a query parameter the caller controls.
 */
async function scopeOf(user) {
  if (user.role === 'INSTITUTE') return user.instituteId ? [user.instituteId] : [];
  if (user.role !== 'DISTRICT') return null;
  if (!user.homeDistrict) return [];
  const rows = await Institute.find({ district: user.homeDistrict }).select('_id').lean();
  return rows.map((row) => String(row._id));
}

/** A `$match` on institute, or `{}` when the token sees the whole portfolio. */
const instituteMatch = (scope) => (scope ? { instituteId: { $in: scope.map(toId) } } : {});

const toId = (id) => new mongoose.Types.ObjectId(String(id));

/**
 * The two joins any finding read needs before it can be scoped: a finding knows
 * its report, a report knows its assignment, and only the assignment knows the
 * institute. The scope filter sits at the end of them — after the only join
 * that can say which district a finding belongs to, and before anything is
 * returned.
 */
const scopedToInstitute = (scope) => [
  {
    $lookup: {
      from: 'inspectionreports',
      localField: 'reportId',
      foreignField: '_id',
      as: 'report',
      pipeline: [{ $project: { assignmentId: 1, submittedAt: 1 } }],
    },
  },
  { $unwind: '$report' },
  {
    $lookup: {
      from: 'assignments',
      localField: 'report.assignmentId',
      foreignField: '_id',
      as: 'assignment',
      pipeline: [{ $project: { instituteId: 1, cycleId: 1, inspectorId: 1 } }],
    },
  },
  { $unwind: '$assignment' },
  ...(scope ? [{ $match: { 'assignment.instituteId': { $in: scope.map(toId) } } }] : []),
];

const slaState = (finding, now) => {
  if (!finding.slaDueAt) return 'NONE';
  const remaining = new Date(finding.slaDueAt) - now;
  if (remaining < 0) return 'BREACHED';
  return remaining < DUE_SOON_DAYS * MS_DAY ? 'DUE_SOON' : 'ON_TIME';
};

/**
 * `GET /api/dashboard/cycles` — the live cycle panel.
 *
 * Issued / completed / overdue per cycle, with the commitment hash the public
 * verification page checks against, so the number on the officer's screen and
 * the number a stranger can verify are the same string.
 */
export async function getCycles(req, res) {
  const now = new Date();
  const scope = await scopeOf(req.user);
  const cycles = await InspectionCycle.find().sort({ _id: -1 }).limit(12).lean();
  if (!cycles.length) return res.json({ cycles: [] });

  const counts = await Assignment.aggregate([
    { $match: { cycleId: { $in: cycles.map((c) => c._id) }, ...instituteMatch(scope) } },
    {
      $group: {
        _id: '$cycleId',
        issued: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'SUBMITTED'] }, 1, 0] } },
        cancelled: { $sum: { $cond: [{ $in: ['$status', ['CANCELLED', 'DEFERRED']] }, 1, 0] } },
        overdue: {
          $sum: {
            $cond: [{ $and: [{ $eq: ['$status', 'PENDING'] }, { $lt: ['$dueDate', now] }] }, 1, 0],
          },
        },
      },
    },
  ]);
  const byCycle = new Map(counts.map((row) => [String(row._id), row]));

  // §14: the log, not just its size. "3 deferred" tells an officer nothing —
  // choosing between an override and a reschedule needs the institute and the
  // constraint that bound. Names are looked up only for institutes this token
  // may see, so an out-of-scope deferral is never read, not merely never shown.
  const inScope = scope && new Set(scope);
  const deferredIds = [
    ...new Set(cycles.flatMap((c) => (c.deferred ?? []).map((d) => String(d.instituteId)))),
  ].filter((id) => !inScope || inScope.has(id));
  const deferredInstitutes = new Map(
    (deferredIds.length
      ? await Institute.find({ _id: { $in: deferredIds.map(toId) } })
          .select('name district')
          .lean()
      : []
    ).map((row) => [String(row._id), row]),
  );

  return res.json({
    cycles: cycles.map((cycle) => {
      const count = byCycle.get(String(cycle._id)) ?? {};
      // Institutes the engine could not place under C1–C4. An officer's
      // reschedule queue, and §14's evidence that the constraints are real.
      const deferrals = (cycle.deferred ?? [])
        .filter((row) => deferredInstitutes.has(String(row.instituteId)))
        .map((row) => {
          const institute = deferredInstitutes.get(String(row.instituteId));
          return {
            instituteId: String(row.instituteId),
            name: institute.name,
            district: institute.district,
            reason: row.reason,
          };
        });
      return {
        id: String(cycle._id),
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        status: cycle.status,
        seedRevealed: cycle.seedRevealed,
        commitmentHash: cycle.commitmentHash,
        commitmentPublishedAt: cycle.commitmentPublishedAt,
        issued: count.issued ?? 0,
        completed: count.completed ?? 0,
        overdue: count.overdue ?? 0,
        cancelled: count.cancelled ?? 0,
        deferred: deferrals.length,
        deferrals,
        constraintRelaxations: cycle.constraintRelaxations ?? [],
      };
    }),
  });
}

/**
 * `GET /api/dashboard/findings` — the action queue.
 *
 * One aggregation rather than four round trips: a finding is only actionable
 * once you know which institute it belongs to, and that is two hops away
 * through the report and its assignment.
 */
export async function getFindings(req, res) {
  const now = new Date();
  const scope = await scopeOf(req.user);
  const status = req.query.status ? String(req.query.status).toUpperCase() : 'OPEN';
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const rows = await Finding.aggregate([
    { $match: status === 'ALL' ? {} : { status } },
    { $sort: { slaDueAt: 1 } },
    ...scopedToInstitute(scope),
    { $limit: limit },
    {
      $lookup: {
        from: 'institutes',
        localField: 'assignment.instituteId',
        foreignField: '_id',
        as: 'institute',
        pipeline: [{ $project: { name: 1, district: 1, riskSignature: 1 } }],
      },
    },
    { $unwind: '$institute' },
    {
      $lookup: {
        from: 'users',
        localField: 'ownerId',
        foreignField: '_id',
        as: 'owner',
        pipeline: [{ $project: { name: 1, role: 1 } }],
      },
    },
  ]);

  return res.json({
    findings: rows.map((row) => ({
      id: String(row._id),
      reportId: String(row.reportId),
      severity: row.severity,
      category: row.category,
      description: row.description,
      status: row.status,
      slaDueAt: row.slaDueAt,
      slaState: slaState(row, now),
      daysOpen: Math.max(0, Math.floor((now - new Date(row.report.submittedAt)) / MS_DAY)),
      owner: row.owner?.[0] ? { id: String(row.owner[0]._id), name: row.owner[0].name } : null,
      institute: {
        id: String(row.institute._id),
        name: row.institute.name,
        district: row.institute.district,
        riskSignature: row.institute.riskSignature,
      },
    })),
  });
}

/**
 * `GET /api/dashboard/unactioned` — §14's unactioned-flag panel.
 *
 * Counts per owning officer, not a page of rows. The queue read caps at 500 and
 * the whole point of this panel is how big a backlog has grown, so counting a
 * capped list would understate exactly the number it exists to raise.
 *
 * BREACHED is the one SLA state the database can answer by itself: `slaDueAt`
 * is stored and the test is a comparison against the clock. DUE_SOON needs the
 * three-day window the reader defines, which is why the queue still derives it.
 */
export async function getUnactioned(req, res) {
  const now = new Date();
  const scope = await scopeOf(req.user);

  const rows = await Finding.aggregate([
    { $match: { status: 'OPEN', slaDueAt: { $lt: now } } },
    ...scopedToInstitute(scope),
    {
      $group: {
        _id: '$ownerId',
        breached: { $sum: 1 },
        severe: { $sum: { $cond: [{ $in: ['$severity', ['HIGH', 'CRITICAL']] }, 1, 0] } },
        oldest: { $min: '$report.submittedAt' },
      },
    },
    { $sort: { breached: -1 } },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'owner',
        pipeline: [{ $project: { name: 1, homeDistrict: 1 } }],
      },
    },
  ]);

  return res.json({
    total: rows.reduce((sum, row) => sum + row.breached, 0),
    officers: rows.map((row) => ({
      // A null owner is not a rounding error: an unowned breached finding is
      // the worst row on the panel, because nobody is late for it.
      ownerId: row._id ? String(row._id) : null,
      name: row.owner?.[0]?.name ?? null,
      district: row.owner?.[0]?.homeDistrict ?? null,
      breached: row.breached,
      severe: row.severe,
      oldestDaysOpen: Math.max(0, Math.floor((now - new Date(row.oldest)) / MS_DAY)),
    })),
  });
}

/** `GET /api/dashboard/institutes` — the risk map. Points, not records. */
export async function getInstitutes(req, res) {
  const scope = await scopeOf(req.user);
  const rows = await Institute.find(scope ? { _id: { $in: scope.map(toId) } } : {})
    .select(
      'name district schemeType location riskSignature riskScore reportedCapacity reportedOccupancy',
    )
    .lean();

  return res.json({
    institutes: rows.map((row) => ({
      id: String(row._id),
      name: row.name,
      district: row.district,
      schemeType: row.schemeType,
      coordinates: row.location.coordinates,
      riskSignature: row.riskSignature,
      riskScore: row.riskScore,
      reportedCapacity: row.reportedCapacity ?? null,
      reportedOccupancy: row.reportedOccupancy ?? null,
    })),
  });
}

/**
 * `GET /api/reports/:id` — everything the review view shows except the score.
 *
 * The trust score stays on its own endpoint: it costs a corpus scan, and a
 * reviewer opening a report to read the answers should not pay for it twice.
 */
export async function getReport(req, res) {
  const report = await InspectionReport.findById(req.params.id).lean();
  if (!report) return fail(res, 404, 'NOT_FOUND', `No report with id ${req.params.id}.`);

  const assignment = await Assignment.findById(report.assignmentId).lean();
  const institute = assignment && (await Institute.findById(assignment.instituteId).lean());

  const scope = await scopeOf(req.user);
  if (scope && !scope.includes(String(institute?._id))) {
    return fail(res, 403, 'OUT_OF_SCOPE', 'That report is outside this account’s jurisdiction.');
  }

  const [cycle, evidence, findings] = await Promise.all([
    assignment &&
      InspectionCycle.findById(assignment.cycleId)
        .select('periodStart periodEnd status commitmentHash')
        .lean(),
    EvidenceItem.find({ reportId: report._id })
      .select('thumbnailUrl sha256 dHash capturedAt location flags')
      .lean(),
    Finding.find({ reportId: report._id }).lean(),
  ]);

  return res.json({
    id: String(report._id),
    submittedAt: report.submittedAt,
    capturedOffline: report.capturedOffline,
    status: report.status,
    deviceSignals: report.deviceSignals,
    answers: report.answers,
    signatureValid: Boolean(report.signature),
    assignment: assignment && {
      id: String(assignment._id),
      allocationType: assignment.allocationType,
      dueDate: assignment.dueDate,
      status: assignment.status,
      inspectorId: String(assignment.inspectorId),
    },
    cycle: cycle && { id: String(cycle._id), ...cycle, _id: undefined },
    institute: institute && {
      id: String(institute._id),
      name: institute.name,
      district: institute.district,
      schemeType: institute.schemeType,
      coordinates: institute.location.coordinates,
      riskSignature: institute.riskSignature,
      reportedCapacity: institute.reportedCapacity ?? null,
      reportedOccupancy: institute.reportedOccupancy ?? null,
    },
    evidence: evidence.map((item) => ({
      id: String(item._id),
      thumbnailUrl: item.thumbnailUrl,
      sha256: item.sha256,
      dHash: item.dHash,
      capturedAt: item.capturedAt,
      location: item.location,
      flags: item.flags,
    })),
    findings: findings.map((finding) => ({
      id: String(finding._id),
      severity: finding.severity,
      category: finding.category,
      description: finding.description,
      status: finding.status,
      slaDueAt: finding.slaDueAt,
    })),
  });
}
