import mongoose from 'mongoose';
// Enums come from packages/core (§3) so the dashboard and the mobile app can
// use them without importing Mongoose. This file owns schemas, not vocabulary.
import {
  ALLOCATION_TYPES,
  ASSIGN_DEFAULTS,
  OVERRIDE_EVENT_TYPES,
  RISK_SIGNATURES,
  ROLES,
  SCHEME_TYPES,
  SEVERITIES,
  TRUST_THRESHOLDS,
} from '@nirikshan/core/constants';

const { Schema, model } = mongoose;

// A sub-schema, not a plain object: a plain `{ type: ... }` literal collides
// with Mongoose's own `type` key and is parsed as a type declaration.
const pointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }, // [lng, lat] — GeoJSON order
  },
  { _id: false },
);

const opts = { timestamps: true };

// ── User — login identity, distinct from Inspector (§2) ──────────────────────
// An Inspector is a person on a duty roster; a User is an account that can hold
// a token. They are separate so an inspector can be assigned work before an
// account exists, and so non-inspector roles need no roster row.
const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // select:false, like InspectionCycle.seed — a careless `res.json(user)`
    // must not be able to leak the hash.
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // Scope claims. Copied into the JWT so a per-request scope check costs no
    // database read (§2: an INSTITUTE token may only read its own record).
    inspectorId: { type: Schema.Types.ObjectId, ref: 'Inspector', default: null },
    instituteId: { type: Schema.Types.ObjectId, ref: 'Institute', default: null },
    homeDistrict: String,
    active: { type: Boolean, default: true },
  },
  opts,
);

// ── Institute ────────────────────────────────────────────────────────────────
const instituteSchema = new Schema(
  {
    name: { type: String, required: true },
    schemeType: { type: String, enum: SCHEME_TYPES, required: true },
    ngoDarpanId: String,
    district: { type: String, required: true },
    state: { type: String, required: true },
    location: { type: pointSchema, required: true },
    // L6 compares against this radius; the fallback it uses when the field is
    // absent lives in core, so both must be the same number.
    geofenceRadiusM: { type: Number, default: TRUST_THRESHOLDS.geofenceRadiusM },
    reportedCapacity: Number,
    reportedOccupancy: Number,
    riskSignature: { type: String, enum: RISK_SIGNATURES, default: 'CLEAN' },
    riskScore: { type: Number, default: 0 },
  },
  opts,
);
instituteSchema.index({ location: '2dsphere' });

// ── Inspector ────────────────────────────────────────────────────────────────
const inspectorSchema = new Schema(
  {
    name: { type: String, required: true },
    homeDistrict: { type: String, required: true },
    activeCycles: { type: Number, default: 0 },
    workloadCount: { type: Number, default: 0 },
    deviceId: String,
  },
  opts,
);

// ── InspectionCycle ──────────────────────────────────────────────────────────
const inspectionCycleSchema = new Schema(
  {
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    commitmentHash: { type: String, required: true },
    commitmentPublishedAt: { type: Date, default: Date.now },
    // select:false so the seed cannot leak through a careless `res.json(cycle)`.
    // The reveal endpoint (§5) must ask for it explicitly: .select('+seed')
    seed: { type: String, required: true, select: false },
    seedRevealed: { type: Boolean, default: false },
    revealedAt: Date,
    // Derived from the one value the engine reads, so the two cannot drift
    // apart into a cycle whose shares do not sum to 1.
    randomShare: { type: Number, default: 1 - ASSIGN_DEFAULTS.targetedShare },
    targetedShare: { type: Number, default: ASSIGN_DEFAULTS.targetedShare },
    status: { type: String, enum: ['OPEN', 'ASSIGNED', 'CLOSED', 'REVEALED'], default: 'OPEN' },
    config: { type: Schema.Types.Mixed, default: {} },
    // The exact arrays handed to assign(), frozen at draw time and published
    // verbatim by /verify. Not rebuilt on read: riskScore and workloadCount
    // both move between the draw and the audit, so a verifier reading them
    // live would replay an honest cycle as MISMATCH. Presence of this field is
    // also what makes the assign endpoint idempotent (§5).
    inputs: { type: Schema.Types.Mixed, default: null },
    // Engine output that has no Assignment row to live on. Deferred institutes
    // are an officer's reschedule queue; the relaxation log is what a verifier
    // compares its own replay against.
    deferred: { type: [Schema.Types.Mixed], default: [] },
    constraintRelaxations: { type: [Schema.Types.Mixed], default: [] },
  },
  opts,
);

// ── Assignment ───────────────────────────────────────────────────────────────
const assignmentSchema = new Schema(
  {
    cycleId: { type: Schema.Types.ObjectId, ref: 'InspectionCycle', required: true },
    instituteId: { type: Schema.Types.ObjectId, ref: 'Institute', required: true },
    inspectorId: { type: Schema.Types.ObjectId, ref: 'Inspector', required: true },
    allocationType: { type: String, enum: ALLOCATION_TYPES, required: true },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ['PENDING', 'SUBMITTED', 'CANCELLED', 'OVERDUE', 'DEFERRED'],
      default: 'PENDING',
    },
    supersededBy: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
  },
  opts,
);
// One inspection per institute per cycle. This is what makes §5's assign
// endpoint idempotent — a second run collides instead of duplicating.
assignmentSchema.index({ cycleId: 1, instituteId: 1 }, { unique: true });

// ── InspectionReport ─────────────────────────────────────────────────────────
const inspectionReportSchema = new Schema(
  {
    assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
    clientId: { type: String, required: true }, // offline idempotency key (§9)
    submittedAt: { type: Date, required: true },
    capturedOffline: { type: Boolean, default: false },
    deviceSignals: {
      deviceId: String,
      platform: String,
      osVersion: String,
      rooted: { type: Boolean, default: false },
      emulator: { type: Boolean, default: false },
      devModeEnabled: { type: Boolean, default: false },
      appVersion: String,
    },
    gpsSeries: [
      {
        _id: false,
        at: Date,
        lat: Number,
        lng: Number,
        accuracyM: Number,
        mocked: { type: Boolean, default: false },
      },
    ],
    answers: [{ _id: false, questionId: String, value: Schema.Types.Mixed, note: String }],
    // Moved only by a REPORT_REOPENED override event (§6) — a reopened report
    // is a weakening of a closed record, so it goes through the ledger.
    status: {
      type: String,
      enum: ['SUBMITTED', 'UNDER_REVIEW', 'ACCEPTED', 'REOPENED'],
      default: 'SUBMITTED',
    },
    trustScore: { type: Number, default: null },
    trustFactors: { type: [Schema.Types.Mixed], default: [] },
    signature: String, // HMAC-SHA256 from the device key issued at login (§8)
  },
  opts,
);

// One report per client-generated id. This is what makes §9's batch intake
// idempotent — a retried outbox row collides instead of double-submitting.
inspectionReportSchema.index({ clientId: 1 }, { unique: true });

// ── EvidenceItem ─────────────────────────────────────────────────────────────
const evidenceItemSchema = new Schema(
  {
    reportId: { type: Schema.Types.ObjectId, ref: 'InspectionReport', required: true },
    clientId: String,
    storageKey: { type: String, required: true },
    thumbnailUrl: String,
    sha256: { type: String, required: true },
    // Server-computed dHash from sharp(). The ONLY value L1 compares against.
    dHash: { type: String, required: true },
    // Device-computed dHash. Recorded for the §11 threshold measurement,
    // never mixed into the L1 corpus — a phone can lie about it.
    deviceDHash: String,
    // 8 position-tagged bands of dHash, e.g. "0:f0". Multikey-indexed so a
    // near-duplicate lookup can pre-filter before the Hamming scan.
    dHashBands: { type: [String], default: [] },
    capturedAt: Date,
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: [Number],
      accuracyM: Number,
      mocked: { type: Boolean, default: false },
    },
    flags: { type: [String], default: [] },
  },
  opts,
);
evidenceItemSchema.index({ sha256: 1 });
evidenceItemSchema.index({ dHashBands: 1 });

// ── Finding ──────────────────────────────────────────────────────────────────
const findingSchema = new Schema(
  {
    reportId: { type: Schema.Types.ObjectId, ref: 'InspectionReport', required: true },
    severity: { type: String, enum: SEVERITIES, required: true },
    category: { type: String, required: true },
    description: String,
    slaDueAt: Date,
    status: {
      type: String,
      enum: ['OPEN', 'ACTIONED', 'CLOSED', 'ESCALATED'],
      default: 'OPEN',
    },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  opts,
);

// ── OverrideEvent — append-only ledger (§6) ──────────────────────────────────
const overrideEventSchema = new Schema(
  {
    seq: { type: Number, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, enum: ROLES, required: true },
    targetType: {
      type: String,
      enum: ['Assignment', 'InspectionReport', 'Finding', 'Institute', 'VCSession'],
      required: true,
    },
    targetId: { type: Schema.Types.ObjectId, required: true },
    eventType: { type: String, enum: OVERRIDE_EVENT_TYPES, required: true },
    reasonCode: { type: String, required: true },
    justification: { type: String, required: true, minlength: 20 },
    previousValue: { type: Schema.Types.Mixed, default: null },
    prevHash: { type: String, required: true },
    entryHash: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  opts,
);
// Unique seq is the concurrency guard: two officers overriding at the same
// instant collide here rather than forking the hash chain (§6 retries ×3).
overrideEventSchema.index({ seq: 1 }, { unique: true });
overrideEventSchema.index({ actorId: 1, at: 1 });

// ── OccupancySnapshot ────────────────────────────────────────────────────────
// Count and timestamp only. No frames, no crops, no identities (PRD §11).
const occupancySnapshotSchema = new Schema(
  {
    instituteId: { type: Schema.Types.ObjectId, ref: 'Institute', required: true },
    source: { type: String, enum: ['CCTV', 'VC'], required: true },
    count: { type: Number, required: true },
    confidence: Number,
    at: { type: Date, default: Date.now },
  },
  opts,
);

// ── MerkleRoot — nightly anchor over the ledger (§6, PRD F4) ─────────────────
// Its own collection so an anchor cannot be edited by the same write path that
// edits the ledger. Published nightly; an old root pins every entry that
// existed when it was taken, so a later rewrite of history contradicts a value
// that was already public.
const merkleRootSchema = new Schema(
  {
    root: { type: String, required: true },
    fromSeq: { type: Number, required: true },
    toSeq: { type: Number, required: true },
    entryCount: { type: Number, required: true },
    headHash: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  opts,
);
merkleRootSchema.index({ toSeq: 1 });

// ── requireOverride — the mutation lockdown (§6, PRD F4) ─────────────────────
// Query middleware refuses outright: `recordOverride()` mutates through a
// loaded document, never through a query, so there is no legitimate caller to
// let past. `bulkWrite` is absent from this list because Mongoose cannot hook
// it at all — ESLint bans it instead (eslint.config.js).
const BLOCKED_QUERIES = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
];

class OverrideRequiredError extends Error {
  constructor(what) {
    super(`${what} weakens a monitored record — route it through recordOverride() (§6).`);
    this.name = 'OverrideRequiredError';
    this.code = 'OVERRIDE_REQUIRED';
  }
}

function requireOverride(schema, { allowLocal } = {}) {
  for (const op of BLOCKED_QUERIES) {
    schema.pre(op, function () {
      throw new OverrideRequiredError(`${this.model.modelName}.${op}()`);
    });
  }

  // Creation is not a weakening — an inspection that never existed cannot be
  // suppressed. Every later edit needs a ledger entry to point at, stamped on
  // `$locals` by recordOverride() inside the transaction that writes it.
  schema.pre('save', function () {
    if (this.isNew || this.$locals.overrideId) return;
    // A named, per-schema exemption rather than a general escape hatch: the
    // caller has to have verified the precondition and stamped $locals for it,
    // exactly as recordOverride() does.
    if (allowLocal && this.$locals[allowLocal]) return;
    throw new OverrideRequiredError(`Modifying ${this.constructor.modelName}`);
  });
}

for (const schema of [findingSchema, inspectionReportSchema]) {
  schema.plugin(requireOverride);
}
// PENDING → SUBMITTED is an inspector finishing their work, not an officer
// weakening a record, and it is the only Assignment write §9 makes. The flag is
// stamped in reports.js after that precondition is checked; every other edit
// still needs a ledger entry.
assignmentSchema.plugin(requireOverride, { allowLocal: 'inspectionSubmitted' });

export const User = model('User', userSchema);
export const Institute = model('Institute', instituteSchema);
export const Inspector = model('Inspector', inspectorSchema);
export const InspectionCycle = model('InspectionCycle', inspectionCycleSchema);
export const Assignment = model('Assignment', assignmentSchema);
export const InspectionReport = model('InspectionReport', inspectionReportSchema);
export const EvidenceItem = model('EvidenceItem', evidenceItemSchema);
export const Finding = model('Finding', findingSchema);
export const OverrideEvent = model('OverrideEvent', overrideEventSchema);
export const OccupancySnapshot = model('OccupancySnapshot', occupancySnapshotSchema);
export const MerkleRoot = model('MerkleRoot', merkleRootSchema);

export const models = {
  User,
  Institute,
  Inspector,
  InspectionCycle,
  Assignment,
  InspectionReport,
  EvidenceItem,
  Finding,
  OverrideEvent,
  OccupancySnapshot,
  MerkleRoot,
};
