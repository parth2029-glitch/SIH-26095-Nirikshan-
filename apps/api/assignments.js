import { fail } from './auth.js';
import { Assignment } from './models.js';
import hostel from './checklists/hostel.v1.json' with { type: 'json' };
import seniorHome from './checklists/senior-home.v1.json' with { type: 'json' };
import deaddiction from './checklists/deaddiction-centre.v1.json' with { type: 'json' };

/**
 * Scheme → checklist. Derived rather than stored on `Assignment`: the scheme is
 * what decides which questions apply, so a per-assignment column could only ever
 * disagree with it. When a scheme needs a v2, this map is the one edit.
 */
const CHECKLISTS = Object.fromEntries(
  [hostel, seniorHome, deaddiction].map((c) => [c.schemeType, c]),
);

/** Only what the inbox promises (docs/API.md) — riskScore/riskSignature stay off the device. */
const forInspector = (institute) => ({
  id: institute.id,
  name: institute.name,
  schemeType: institute.schemeType,
  district: institute.district,
  state: institute.state,
  location: institute.location,
  geofenceRadiusM: institute.geofenceRadiusM,
  reportedCapacity: institute.reportedCapacity,
  reportedOccupancy: institute.reportedOccupancy,
});

/**
 * `GET /api/assignments/mine` — the inspector inbox (§7, PRD F2).
 *
 * Scoped to the `inspectorId` claim, never to a query param: the app that reads
 * this runs on a device its holder controls. Everything the app needs offline is
 * embedded, checklists included, because §9 caches this response whole and an
 * inspection has to run with no connectivity.
 */
export async function listMyAssignments(req, res) {
  const { inspectorId } = req.user;
  if (!inspectorId) {
    return fail(res, 403, 'NO_INSPECTOR_PROFILE', 'This account has no inspector record.');
  }

  const status = String(req.query.status ?? 'PENDING').toUpperCase();
  if (!['PENDING', 'SUBMITTED', 'ALL'].includes(status)) {
    return fail(res, 400, 'VALIDATION_FAILED', 'status must be PENDING, SUBMITTED or ALL.');
  }

  const rows = await Assignment.find({
    inspectorId,
    ...(status !== 'ALL' && { status }),
  })
    .sort({ dueDate: 1 })
    .populate('instituteId');

  // Only the checklists actually referenced — an inbox of hostels does not pay
  // to carry the de-addiction questionnaire over a field connection.
  const checklists = {};
  const assignments = rows
    .filter((row) => row.instituteId) // a deleted institute must not 500 the inbox
    .map((row) => {
      const institute = row.instituteId;
      const checklist = CHECKLISTS[institute.schemeType];
      if (checklist) checklists[checklist.id] = checklist;
      return {
        id: row.id,
        cycleId: row.cycleId.toString(),
        allocationType: row.allocationType,
        dueDate: row.dueDate,
        status: row.status,
        institute: forInspector(institute),
        checklistId: checklist?.id ?? null,
      };
    });

  return res.json({ assignments, checklists, serverTime: new Date().toISOString() });
}
