/**
 * Evidence trust score (§3, PRD F3).
 *
 * Layered because every single method is defeatable — Prokos et al. (2021)
 * showed a perceptual hash can be evaded by a determined forger, so one check
 * cannot be the check. The score prioritises human review and never rejects:
 * callers must not gate a submission on it (PRD F3 acceptance criteria).
 *
 * Pure: no lookups, no clock, no I/O. The caller resolves every signal (corpus
 * match, previous submission, institute geofence) and passes facts in, so the
 * same function scores a live report on the server and a what-if on the
 * dashboard.
 */
import { TRUST_FACTORS, TRUST_THRESHOLDS, TRUST_WEIGHTS } from './constants.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * One detector per layer, in L1–L9 order. Each returns `null` when the layer
 * did not fire, or `{ reason, cites }` — `reason` is shown verbatim to the
 * reviewing officer, so it is written for a person, not a log.
 */
const DETECTORS = {
  // L1 — the same photograph, re-encoded or lightly edited.
  L1: ({ reusedEvidence }) => {
    if (!reusedEvidence?.length) return null;
    const closest = reusedEvidence.reduce((a, b) => (b.distance < a.distance ? b : a));
    return {
      reason:
        `${plural(reusedEvidence.length, 'photograph matches', 'photographs match')} evidence ` +
        `already on file (closest: ${closest.distance} of 64 bits different). ` +
        `Nearest match came from report ${closest.reportId}.`,
      cites: reusedEvidence.map((m) => m.reportId),
    };
  },

  // L2 — the identical file, byte for byte.
  L2: ({ duplicateEvidence }) => {
    if (!duplicateEvidence?.length) return null;
    return {
      reason:
        `${plural(duplicateEvidence.length, 'file is', 'files are')} a byte-for-byte copy of ` +
        `evidence already submitted (report ${duplicateEvidence[0].reportId}).`,
      cites: duplicateEvidence.map((m) => m.reportId),
    };
  },

  // L3 — the strongest single signal: the location was asserted, not measured.
  L3: ({ mockedLocation }) =>
    mockedLocation
      ? { reason: 'Location came from a mock provider — the GPS trail cannot be trusted.' }
      : null,

  // L4 — the device itself is in a state where any of the above can be forged.
  L4: ({ device }) => {
    const flagged = [
      device?.rooted && 'rooted',
      device?.emulator && 'running in an emulator',
      device?.devModeEnabled && 'in developer mode',
    ].filter(Boolean);
    return flagged.length ? { reason: `Capture device reports as ${flagged.join(', ')}.` } : null;
  },

  // L5 — the inspector could not physically have been at both places.
  L5: ({ impliedSpeedKmh }) =>
    impliedSpeedKmh > TRUST_THRESHOLDS.impliedSpeedKmh
      ? {
          reason:
            `Implied travel speed since the previous submission is ` +
            `${Math.round(impliedSpeedKmh)} km/h, above the ${TRUST_THRESHOLDS.impliedSpeedKmh} km/h ` +
            `feasibility threshold.`,
        }
      : null,

  // L6 — captured somewhere other than the institute.
  L6: ({ captureDistanceM, geofenceRadiusM = TRUST_THRESHOLDS.geofenceRadiusM }) =>
    captureDistanceM > geofenceRadiusM
      ? {
          reason:
            `Evidence was captured ${Math.round(captureDistanceM)} m from the institute, ` +
            `outside its ${geofenceRadiusM} m boundary.`,
        }
      : null,

  // L7 — submitted at an hour no inspection plausibly happens.
  L7: ({ submittedHourLocal }) => {
    const [open, close] = TRUST_THRESHOLDS.workingHours;
    if (!Number.isInteger(submittedHourLocal)) return null;
    return submittedHourLocal < open || submittedHourLocal >= close
      ? {
          reason:
            `Submitted at ${String(submittedHourLocal).padStart(2, '0')}:00 local time, outside ` +
            `the ${open}:00–${close}:00 working window.`,
        }
      : null;
  },

  // L8 — a long gap between taking the photograph and sending it.
  L8: ({ captureToSubmitHours }) =>
    captureToSubmitHours > TRUST_THRESHOLDS.captureToSubmitHours
      ? {
          reason:
            `Evidence was captured ${Math.round(captureToSubmitHours)} h before it was submitted ` +
            `(over the ${TRUST_THRESHOLDS.captureToSubmitHours} h expected turnaround).`,
        }
      : null,

  // L9 — the file that arrived is not the file the device hashed.
  L9: ({ deviceHashDistance }) => {
    const limit = TRUST_THRESHOLDS.deviceHashHamming;
    // Disabled until §11 measures the threshold against the fixture set.
    if (limit === null || !(deviceHashDistance > limit)) return null;
    return {
      reason:
        `The hash the device computed at capture differs from the server's by ` +
        `${deviceHashDistance} of 64 bits — the image may have been altered after capture.`,
    };
  },
};

/**
 * @param {object} [signals] Resolved facts about one report. Every field is
 *   optional; an absent field means "not measured", which fires nothing.
 * @param {{ reportId: string, distance: number }[]} [signals.reusedEvidence] L1
 * @param {{ reportId: string }[]} [signals.duplicateEvidence] L2
 * @param {boolean} [signals.mockedLocation] L3
 * @param {{ rooted?: boolean, emulator?: boolean, devModeEnabled?: boolean }} [signals.device] L4
 * @param {number} [signals.impliedSpeedKmh] L5
 * @param {number} [signals.captureDistanceM] L6, metres from the institute
 * @param {number} [signals.geofenceRadiusM] L6, the institute's own radius
 * @param {number} [signals.submittedHourLocal] L7, 0–23
 * @param {number} [signals.captureToSubmitHours] L8
 * @param {number} [signals.deviceHashDistance] L9
 * @returns {{ score: number, factors: object[] }} 0–100, plus one itemised
 *   factor per layer that fired, in L1–L9 order.
 */
export function score(signals = {}) {
  const factors = [];

  for (const [id, detect] of Object.entries(DETECTORS)) {
    const hit = detect(signals);
    if (!hit) continue;
    const { title, weight } = TRUST_FACTORS[id];
    factors.push({ id, title, weight, points: TRUST_WEIGHTS[weight], ...hit });
  }

  const deducted = factors.reduce((total, f) => total + f.points, 0);
  // Floors at 0: enough layers firing together exceed 100, and a negative
  // trust score would sort below "no evidence at all", which is nonsense.
  return { score: Math.max(0, 100 - deducted), factors };
}
