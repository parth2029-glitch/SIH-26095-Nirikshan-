/**
 * Every enum and tuning constant the platform shares (§3).
 *
 * These lived in `apps/api/models.js` until now. They sit here so the dashboard
 * can render a severity badge and the mobile app can label a reason code
 * without either one importing Mongoose.
 *
 * Platform-neutral by rule: no imports, no I/O, no node built-ins.
 */

// ── Domain enums (PRD §6, §9.3) ──────────────────────────────────────────────

export const SCHEME_TYPES = ['HOSTEL', 'SENIOR_HOME', 'DEADDICTION_CENTRE'];

export const ROLES = ['INSPECTOR', 'DISTRICT', 'DIVISION', 'INSTITUTE', 'BENEFICIARY', 'AUDITOR'];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const ALLOCATION_TYPES = ['RANDOM', 'TARGETED'];

/** Fraud signatures the F5a classifier assigns to an institute. */
export const RISK_SIGNATURES = [
  'GHOST_INTAKE',
  'THRESHOLD_GAMING',
  'PREPARED_VISIT',
  'EVIDENCE_REUSE',
  'INSPECTOR_CAPTURE',
  'CLEAN',
];

// ── Override ledger (PRD F4) ─────────────────────────────────────────────────

export const OVERRIDE_EVENT_TYPES = [
  'ASSIGNMENT_CANCELLED',
  'ASSIGNMENT_REASSIGNED',
  'INSTITUTE_EXEMPTED',
  'FINDING_DOWNGRADED',
  'FINDING_DISMISSED',
  'SLA_EXTENDED',
  'REPORT_REOPENED',
  'RECORDING_ENABLED',
];

/**
 * Structured reason codes (PRD F4). A code is mandatory on every ledger entry;
 * the free-text justification sits alongside it, never instead of it. Codes are
 * deliberately shared across event types — "why" and "what" are separate axes,
 * and pinning each code to one event type buys nothing until §6 needs it.
 */
export const REASON_CODES = {
  INSPECTOR_UNAVAILABLE: 'Assigned inspector unavailable',
  CONFLICT_OF_INTEREST: 'Inspector has a declared conflict of interest',
  WORKLOAD_REBALANCE: 'Rebalancing inspector workload',
  TRAVEL_INFEASIBLE: 'Route not coverable within the cycle',
  INSTITUTE_CLOSED: 'Institute temporarily or permanently closed',
  RECENTLY_INSPECTED: 'Inspected within the preceding cycle',
  AUDIT_IN_PROGRESS: 'Separate audit already under way',
  LEGAL_STAY: 'Stayed by a court or statutory order',
  NATURAL_DISASTER: 'Disaster or emergency in the district',
  EVIDENCE_INSUFFICIENT: 'Evidence does not support the finding as recorded',
  DUPLICATE_FINDING: 'Already recorded under another finding',
  ASSESSMENT_ERROR: 'Recorded in error by the inspecting officer',
  REMEDIED_ON_SITE: 'Corrected during the inspection visit',
  OUT_OF_JURISDICTION: 'Outside this office’s jurisdiction',
  FUNDS_AWAITED: 'Remedial funds not yet released',
  PROCUREMENT_DELAY: 'Delayed by a procurement process',
  NEW_EVIDENCE: 'New evidence received after closure',
  COMPLAINT_RECEIVED: 'Reopened on a beneficiary complaint',
  BENEFICIARY_CONSENT: 'Beneficiary gave recorded consent',
  LEGAL_DIRECTIVE: 'Required by a legal or statutory directive',
};

// ── Evidence trust score (PRD F3) ────────────────────────────────────────────

/**
 * Points deducted from 100 when a layer fires. The score routes human review;
 * it never blocks a submission, so these are priorities, not verdicts.
 *
 * ponytail: weights are a first estimate, not a measurement. Retune in §11
 * once the 25 fixtures have been scored — they are here in one table so that
 * retuning is an edit to four numbers.
 */
export const TRUST_WEIGHTS = { CRITICAL: 40, HIGH: 25, MEDIUM: 12, LOW: 5 };

/** Layer IDs L1–L9 exactly as PRD F3 numbers them. Phase 1 implements L1–L6. */
export const TRUST_FACTORS = {
  L1: { title: 'Image reuse', weight: 'HIGH' },
  L2: { title: 'Byte-level duplicate', weight: 'HIGH' },
  L3: { title: 'Mock location', weight: 'CRITICAL' },
  L4: { title: 'Device integrity', weight: 'HIGH' },
  L5: { title: 'Travel feasibility', weight: 'MEDIUM' },
  L6: { title: 'Geofence deviation', weight: 'MEDIUM' },
  L7: { title: 'Temporal anomaly', weight: 'LOW' },
  L8: { title: 'Capture-to-submit gap', weight: 'LOW' },
  L9: { title: 'Tamper indicators', weight: 'MEDIUM' },
};

export const TRUST_THRESHOLDS = {
  /** L1 — dHash Hamming distance counted as the same photograph (PRD F3). */
  dhashHamming: 6,
  /** L5 — implied km/h between consecutive submissions. */
  impliedSpeedKmh: 120,
  /** L6 — fallback when the institute carries no `geofenceRadiusM`. */
  geofenceRadiusM: 150,
  /** L7 — plausible working window, local hours, inclusive start, exclusive end. */
  workingHours: [6, 22],
  /** L8 — hours between capture and submission before the gap is notable. */
  captureToSubmitHours: 48,
  /**
   * L9 — device-vs-server dHash distance that counts as tampering. `null`
   * disables the layer, which is the correct Phase 1 state: §11 measures this
   * across the 25 fixtures and sets it. A guessed value here would fabricate
   * tamper findings out of ordinary JPEG re-encoding noise.
   */
  deviceHashHamming: null,
};
