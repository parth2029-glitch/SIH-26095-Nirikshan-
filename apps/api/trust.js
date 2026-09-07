/**
 * `GET /api/reports/:id/trust` — the evidence trust score (§11, PRD F3).
 *
 * The scoring itself is in `packages/core/trust.js` and is pure: it takes
 * resolved facts and returns deductions. Everything here is the resolution —
 * the corpus scan, the duplicate query, the previous submission, the institute's
 * geofence — because those are the parts that need a database, and keeping them
 * out of core is what lets the dashboard score a what-if without one.
 *
 * Computed on read rather than stored. A score is derived from evidence that is
 * still arriving (an upload can land after the report), so a cached number would
 * be stale exactly when it matters. `InspectionReport.trustScore` stays null
 * until §13 finds a list view that cannot afford the recompute.
 *
 * It never blocks anything. Nothing calls this on the submission path; §9
 * accepts a report whatever this would return, which is PRD F3's requirement,
 * not an oversight.
 */
import { haversineKm } from '@nirikshan/core/assign';
import { TRUST_FACTORS, TRUST_THRESHOLDS } from '@nirikshan/core/constants';
import { fromHex } from '@nirikshan/core/dhash';
import { distance as hamming } from '@nirikshan/core/hamming';
import { score } from '@nirikshan/core/trust';
import { fail } from './auth.js';
import { nearest } from './corpus.js';
import { Assignment, EvidenceItem, InspectionReport, Institute } from './models.js';

/** India keeps one civil time, so L7's "local hour" is UTC+05:30, always. */
const IST_OFFSET_MINUTES = 330;
const istHour = (date) =>
  Math.floor(((date.getUTCHours() * 60 + date.getUTCMinutes() + IST_OFFSET_MINUTES) % 1440) / 60);

/**
 * What a reviewing officer is told when a layer was checked and passed. Present
 * for the same reason the fired ones are: a dashboard that only ever shows
 * failures cannot distinguish "clean" from "not looked at".
 */
const PASSED = {
  L1: 'No photograph matches evidence already on file.',
  L2: 'No byte-for-byte duplicate of any stored file.',
  L3: 'Location came from the device’s own positioning, not a mock provider.',
  L4: 'Capture device reports no rooting, emulation or developer mode.',
  L5: 'Travel from the previous submission is feasible.',
  L6: 'Evidence was captured inside the institute’s boundary.',
};

/** The layers the endpoint always accounts for. L7–L9 report only when they fire. */
const ALWAYS_REPORTED = Object.keys(PASSED);

const metres = (a, b) => haversineKm(a, b) * 1000;

/**
 * Every fact `score()` needs about one report, resolved from the database.
 *
 * Exported so §12's seed and §13's dashboard can score without going through
 * HTTP, and so the signals can be asserted directly in a test.
 */
export async function signalsFor(report) {
  const reportId = report.id;
  const evidence = await EvidenceItem.find({ reportId: report._id }).lean();
  const assignment = await Assignment.findById(report.assignmentId).lean();
  const institute = assignment && (await Institute.findById(assignment.instituteId).lean());

  // L1 — the corpus holds the server's dHash for every photograph ever stored.
  // Only the closest hit per historical report is kept: five near-identical
  // frames from one visit are one reuse, not five.
  const byReport = new Map();
  for (const item of evidence) {
    for (const hit of await nearest(fromHex(item.dHash), { excludeReportId: reportId })) {
      const kept = byReport.get(hit.reportId);
      if (!kept || hit.distance < kept.distance) byReport.set(hit.reportId, hit);
    }
  }
  const reusedEvidence = [...byReport.values()];

  // L2 — exact bytes. An indexed equality query, not a scan: this is the one
  // layer a database index can actually answer.
  const shas = evidence.map((item) => item.sha256);
  const duplicates = shas.length
    ? await EvidenceItem.find({ sha256: { $in: shas }, reportId: { $ne: report._id } }, 'reportId')
        .lean()
        .then((rows) => rows.map((row) => ({ reportId: row.reportId.toString() })))
    : [];

  // L3 — asserted rather than measured, anywhere in the trail. Read from both
  // the GPS series and the per-photograph fix: a fake-GPS app can be toggled
  // mid-inspection, which is exactly the case a single fix would miss.
  const mockedLocation =
    report.gpsSeries?.some((fix) => fix.mocked) || evidence.some((item) => item.location?.mocked);

  // L5 — the same inspector's previous submission, wherever it was.
  const impliedSpeedKmh = institute
    ? await impliedSpeed(assignment.inspectorId, report, institute)
    : undefined;

  // L6 — the furthest photograph from the institute, not the average: one
  // picture taken elsewhere is the finding.
  const distances = institute
    ? evidence
        .filter((item) => item.location?.coordinates?.length === 2)
        .map((item) => metres(item.location.coordinates, institute.location.coordinates))
    : [];

  // L9 — how far the device's own hash is from the server's. Scored only once
  // §11's fixture measurement sets `deviceHashHamming`; until then the layer is
  // disabled in core and this is measurement, not evidence.
  const deviceDistances = evidence
    .filter((item) => item.deviceDHash)
    .map((item) => hamming(fromHex(item.dHash), fromHex(item.deviceDHash)));

  const capturedAts = evidence.map((item) => item.capturedAt).filter(Boolean);

  return {
    reusedEvidence,
    duplicateEvidence: duplicates,
    mockedLocation,
    device: report.deviceSignals,
    impliedSpeedKmh,
    captureDistanceM: distances.length ? Math.max(...distances) : undefined,
    geofenceRadiusM: institute?.geofenceRadiusM ?? TRUST_THRESHOLDS.geofenceRadiusM,
    submittedHourLocal: istHour(new Date(report.submittedAt)),
    captureToSubmitHours: capturedAts.length
      ? (new Date(report.submittedAt) - Math.min(...capturedAts.map(Number))) / 3_600_000
      : undefined,
    deviceHashDistance: deviceDistances.length ? Math.max(...deviceDistances) : undefined,
  };
}

/**
 * km/h implied between this inspector's previous submission and this one.
 *
 * Institute-to-institute rather than fix-to-fix: the previous report's GPS trail
 * is the inspector's claim about where they were, and comparing two claims tests
 * nothing. The institutes are on the roster.
 */
async function impliedSpeed(inspectorId, report, institute) {
  const theirs = await Assignment.find({ inspectorId }, '_id').lean();
  const previous = await InspectionReport.findOne({
    assignmentId: { $in: theirs.map((a) => a._id) },
    _id: { $ne: report._id },
    submittedAt: { $lt: report.submittedAt },
  })
    .sort({ submittedAt: -1 })
    .lean();
  if (!previous) return undefined;

  const from = await Assignment.findById(previous.assignmentId).lean();
  const where = from && (await Institute.findById(from.instituteId, 'location').lean());
  if (!where) return undefined;

  const hours = (new Date(report.submittedAt) - new Date(previous.submittedAt)) / 3_600_000;
  // Two submissions in the same minute are a batch drain, not a journey — the
  // outbox sends a morning's work at once, and dividing by ~0 would flag every
  // inspector who found signal on the way home.
  if (hours <= 0.25) return undefined;
  return haversineKm(where.location.coordinates, institute.location.coordinates) / hours;
}

/** The per-layer facts a reviewer needs to check the finding themselves. */
function evidenceFor(id, factor, signals) {
  switch (id) {
    case 'L1':
      return {
        matchedReportIds: factor.cites,
        evidenceIds: signals.reusedEvidence.map((m) => m.evidenceId),
        hammingDistance: Math.min(...signals.reusedEvidence.map((m) => m.distance)),
      };
    case 'L2':
      return { matchedReportIds: factor.cites };
    case 'L3':
      return { mocked: true };
    case 'L4':
      return signals.device;
    case 'L5':
      return { impliedSpeedKmh: Math.round(signals.impliedSpeedKmh) };
    case 'L6':
      return {
        captureDistanceM: Math.round(signals.captureDistanceM),
        geofenceRadiusM: signals.geofenceRadiusM,
      };
    default:
      return undefined;
  }
}

/**
 * Score one report and shape it for the API (docs/API.md).
 *
 * Core returns only the layers that fired; the response also carries the ones
 * that passed, so the dashboard can show what was checked.
 */
export async function trustFor(report) {
  const signals = await signalsFor(report);
  const { score: value, factors } = score(signals);
  const fired = new Map(factors.map((factor) => [factor.id, factor]));

  const reported = [...new Set([...ALWAYS_REPORTED, ...fired.keys()])];
  return {
    reportId: report.id,
    score: value,
    computedAt: new Date().toISOString(),
    factors: reported.map((id) => {
      const factor = fired.get(id);
      return {
        id,
        label: TRUST_FACTORS[id].title,
        weight: TRUST_FACTORS[id].weight,
        deduction: factor?.points ?? 0,
        fired: Boolean(factor),
        reason: factor?.reason ?? PASSED[id],
        ...(factor && { evidence: evidenceFor(id, factor, signals) }),
      };
    }),
  };
}

export async function getTrust(req, res) {
  const report = await InspectionReport.findById(req.params.id);
  if (!report) return fail(res, 404, 'NOT_FOUND', `No report with id ${req.params.id}.`);
  return res.json({
    ...(await trustFor(report)),
    // Verified at intake by §9 — an unsigned report is rejected there and never
    // reaches the database, so this is a restatement, not a second check.
    signatureValid: Boolean(report.signature),
  });
}
