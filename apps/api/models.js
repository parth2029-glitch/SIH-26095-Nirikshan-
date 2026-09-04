import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// Enums live here until §3 lifts them into packages/core/constants.js.
export const SCHEME_TYPES = ['HOSTEL', 'SENIOR_HOME', 'DEADDICTION_CENTRE'];
export const RISK_SIGNATURES = [
  'GHOST_INTAKE',
  'THRESHOLD_GAMING',
  'PREPARED_VISIT',
  'EVIDENCE_REUSE',
  'INSPECTOR_CAPTURE',
  'CLEAN',
];
export const ALLOCATION_TYPES = ['RANDOM', 'TARGETED'];
export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const ROLES = ['INSPECTOR', 'DISTRICT', 'DIVISION', 'INSTITUTE', 'BENEFICIARY', 'AUDITOR'];
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
    geofenceRadiusM: { type: Number, default: 150 },
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
    randomShare: { type: Number, default: 0.7 },
    targetedShare: { type: Number, default: 0.3 },
    status: { type: String, enum: ['OPEN', 'ASSIGNED', 'CLOSED', 'REVEALED'], default: 'OPEN' },
    config: { type: Schema.Types.Mixed, default: {} },
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
    trustScore: { type: Number, default: null },
    trustFactors: { type: [Schema.Types.Mixed], default: [] },
    signature: String, // HMAC-SHA256 from the device key issued at login (§8)
  },
  opts,
);

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
};
