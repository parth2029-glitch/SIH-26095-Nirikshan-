# Nirikshan API

Contract for every endpoint in [PRD §10](../PRD_SIH26095_Nirikshan.md), plus `/api/auth/login`
(§2 depends on it). This file is the interface between the API, dashboard and mobile workstreams —
**change it here first, then in code.**

- Base URL: `${API_BASE_URL}` (`http://localhost:4000` in dev)
- All bodies are JSON unless marked `multipart/form-data`
- All IDs are Mongo ObjectId strings
- All timestamps are ISO 8601 UTC
- Auth: `Authorization: Bearer <jwt>` on everything **except** `POST /api/auth/login` and
  `GET /api/cycles/:id/verify` (public by design — a third party must verify without an account)

## Roles (PRD §6)

`INSPECTOR` · `DISTRICT` · `DIVISION` · `INSTITUTE` · `BENEFICIARY` · `AUDITOR`

## Error envelope

Every non-2xx response uses this shape.

```json
{
  "error": {
    "code": "FORBIDDEN_ROLE",
    "message": "Role INSPECTOR may not write override events.",
    "details": { "required": ["DISTRICT", "DIVISION"] }
  }
}
```

| Status | `code` values |
| --- | --- |
| 400 | `VALIDATION_FAILED`, `CYCLE_STILL_OPEN`, `SEED_ALREADY_REVEALED` |
| 401 | `NO_TOKEN`, `TOKEN_EXPIRED`, `BAD_CREDENTIALS` |
| 403 | `FORBIDDEN_ROLE`, `OUT_OF_SCOPE`, `OVERRIDE_REQUIRED`, `SELF_APPROVAL_BLOCKED` |
| 404 | `NOT_FOUND` |
| 409 | `DUPLICATE_IDEMPOTENCY_KEY`, `ASSIGNMENT_EXISTS` |
| 422 | `CONSTRAINTS_UNSATISFIABLE` |
| 500 | `INTERNAL` |

---

## Endpoint index

| Method | Path | Auth | Section |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | public | §2 |
| POST | `/api/cycles` | DIVISION | §5 |
| POST | `/api/cycles/:id/assign` | DIVISION | §5 |
| POST | `/api/cycles/:id/reveal` | DIVISION | §5 |
| GET | `/api/cycles/:id/verify` | **public** | §5 |
| GET | `/api/assignments/mine` | INSPECTOR | §7 |
| POST | `/api/reports` | INSPECTOR | §9 |
| POST | `/api/reports/:id/evidence` | INSPECTOR | §10 |
| GET | `/api/reports/:id/trust` | DISTRICT, DIVISION | §11 |
| POST | `/api/overrides` | DISTRICT, DIVISION | §6 |
| GET | `/api/overrides/verify-chain` | DIVISION, AUDITOR | §6 |
| GET | `/api/overrides/officer-rates` | DIVISION | §6 |
| GET | `/api/dashboard/velocity` | DIVISION | §14 |
| GET | `/api/dashboard/scorecard` | DIVISION | §14 |
| GET | `/api/institutes/:id/risk` | DISTRICT, DIVISION, INSTITUTE (own) | §19 |
| POST | `/api/vc/sessions` | DISTRICT, DIVISION | §23 |
| GET | `/api/stream/:instituteId/index.m3u8` | DISTRICT, DIVISION | §22 |

---

## Auth

### `POST /api/auth/login`

Public.

```json
{ "email": "inspector7@pmu.gov.in", "password": "hunter2", "deviceId": "a1b2c3d4e5f6" }
```

`deviceId` is optional and mobile-only. When present the response carries `deviceHmacKey`, the
per-device signing key from §8 — returned **once, at login**, never re-fetchable.

`200`

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresAt": "2026-09-05T22:00:00.000Z",
  "user": {
    "id": "66f0a1b2c3d4e5f600000001",
    "name": "A. Sharma",
    "role": "INSPECTOR",
    "inspectorId": "66f0a1b2c3d4e5f600000101",
    "homeDistrict": "Pune",
    "instituteId": null
  },
  "deviceHmacKey": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}
```

`401 BAD_CREDENTIALS` — identical response for an unknown email and a wrong password.

---

## Cycles — commit–reveal (F1)

### `POST /api/cycles`

`DIVISION`. Creates the cycle and publishes the commitment. **The seed is generated here, stored
server-side, and never appears in a response until reveal.**

```json
{
  "periodStart": "2026-10-01",
  "periodEnd": "2026-10-31",
  "randomShare": 0.7,
  "targetedShare": 0.3,
  "config": { "noRepeatCycles": 4, "workloadTolerance": 0.15, "maxTravelKmPerDay": 250 }
}
```

`201`

```json
{
  "id": "66f0a1b2c3d4e5f600000201",
  "periodStart": "2026-10-01T00:00:00.000Z",
  "periodEnd": "2026-10-31T00:00:00.000Z",
  "commitmentHash": "3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
  "commitmentPublishedAt": "2026-09-20T09:00:00.000Z",
  "randomShare": 0.7,
  "targetedShare": 0.3,
  "status": "OPEN",
  "seedRevealed": false
}
```

`commitmentHash = SHA-256(seed || cycleId)`, hex, lowercase.

### `POST /api/cycles/:id/assign`

`DIVISION`. Runs the engine and writes `Assignment` docs. **Idempotent** — a second call returns the
existing result with `created: false` and writes nothing.

```json
{ "dryRun": false }
```

`200`

```json
{
  "cycleId": "66f0a1b2c3d4e5f600000201",
  "created": true,
  "assignmentCount": 200,
  "byAllocationType": { "RANDOM": 140, "TARGETED": 60 },
  "deferred": [
    {
      "instituteId": "66f0a1b2c3d4e5f600000042",
      "reason": "No inspector satisfied C1 and C2 after relaxing C3 by one step."
    }
  ],
  "constraintRelaxations": [{ "constraint": "C3", "steps": 1, "affectedInstitutes": 3 }]
}
```

`422 CONSTRAINTS_UNSATISFIABLE` if every institute defers.

### `POST /api/cycles/:id/reveal`

`DIVISION`. Exposes the seed and closes the cycle. Refuses while the cycle is still `OPEN` —
revealing early would let institutes predict the draw.

```json
{ "confirm": true }
```

`200`

```json
{
  "cycleId": "66f0a1b2c3d4e5f600000201",
  "status": "REVEALED",
  "seed": "d2a84f4b8b650937ec8f73cd8be2c74add5a911ba64df27458ed8229da804a26",
  "commitmentHash": "3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
  "revealedAt": "2026-11-01T00:00:00.000Z"
}
```

`400 CYCLE_STILL_OPEN` — `details` carries `{ "closesAt": "2026-10-31T23:59:59.000Z" }`.

### `GET /api/cycles/:id/verify`

**Public, no auth.** Returns everything a stranger needs to replay the draw in their own browser.
The server does **not** replay it and does **not** return a verdict — a server-computed "MATCH"
proves nothing. The dashboard page recomputes both the commitment and the assignment client-side.

`200`

```json
{
  "cycle": {
    "id": "66f0a1b2c3d4e5f600000201",
    "periodStart": "2026-10-01T00:00:00.000Z",
    "periodEnd": "2026-10-31T00:00:00.000Z",
    "commitmentHash": "3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
    "seed": "d2a84f4b8b650937ec8f73cd8be2c74add5a911ba64df27458ed8229da804a26",
    "seedRevealed": true,
    "randomShare": 0.7,
    "config": { "noRepeatCycles": 4, "workloadTolerance": 0.15, "maxTravelKmPerDay": 250 }
  },
  "inputs": {
    "institutes": [
      { "id": "66f0a1b2c3d4e5f600000001", "district": "Pune", "schemeType": "HOSTEL", "riskScore": 0.31 }
    ],
    "inspectors": [
      { "id": "66f0a1b2c3d4e5f600000101", "homeDistrict": "Nagpur", "workloadCount": 6 }
    ],
    "history": [
      {
        "cycleId": "66f0a1b2c3d4e5f600000200",
        "instituteId": "66f0a1b2c3d4e5f600000001",
        "inspectorId": "66f0a1b2c3d4e5f600000104"
      }
    ]
  },
  "assignments": [
    {
      "instituteId": "66f0a1b2c3d4e5f600000001",
      "inspectorId": "66f0a1b2c3d4e5f600000101",
      "allocationType": "RANDOM",
      "dueDate": "2026-10-14T00:00:00.000Z"
    }
  ],
  "deferred": []
}
```

Before reveal: `seed` is `null`, `seedRevealed` is `false` and `assignments` is `[]`. The commitment
is still published, so its timestamp is checkable against the assignment date.

---

## Inspector workflow (F2)

### `GET /api/assignments/mine`

`INSPECTOR`. The inbox. Scoped to the calling inspector server-side; an `inspectorId` query param is
ignored. Everything needed offline is embedded — the app caches this response whole.

Query: `?status=PENDING|SUBMITTED|ALL` (default `PENDING`)

`200`

```json
{
  "assignments": [
    {
      "id": "66f0a1b2c3d4e5f600000301",
      "cycleId": "66f0a1b2c3d4e5f600000201",
      "allocationType": "RANDOM",
      "dueDate": "2026-10-14T00:00:00.000Z",
      "status": "PENDING",
      "institute": {
        "id": "66f0a1b2c3d4e5f600000001",
        "name": "Sunrise Boys Hostel",
        "schemeType": "HOSTEL",
        "district": "Pune",
        "state": "Maharashtra",
        "location": { "type": "Point", "coordinates": [73.8567, 18.5204] },
        "geofenceRadiusM": 150,
        "reportedCapacity": 120,
        "reportedOccupancy": 98
      },
      "checklistId": "hostel.v1"
    }
  ],
  "checklists": { "hostel.v1": { "version": 1, "sections": [] } },
  "serverTime": "2026-10-02T06:00:00.000Z"
}
```

`checklists` carries the full JSON for every checklist referenced above, so a cached inbox is
enough to run an inspection with no connectivity.

### `POST /api/reports`

`INSPECTOR`. **Accepts an array** — the offline outbox drains in batches.

An `Idempotency-Key` header is required. Replaying the same key returns the original result with
`duplicate: true` and writes nothing.

```json
{
  "reports": [
    {
      "clientId": "3f2a9c10-7b1e-4f0a-9d55-1c2b3a4d5e6f",
      "assignmentId": "66f0a1b2c3d4e5f600000301",
      "submittedAt": "2026-10-08T11:24:00.000Z",
      "capturedOffline": true,
      "answers": [
        { "questionId": "hostel.hygiene.toilets", "value": "PARTIAL", "note": "2 of 6 unusable" },
        { "questionId": "hostel.occupancy.headcount", "value": 41 }
      ],
      "deviceSignals": {
        "deviceId": "a1b2c3d4e5f6",
        "platform": "android",
        "osVersion": "13",
        "rooted": false,
        "emulator": false,
        "devModeEnabled": false,
        "appVersion": "1.0.0"
      },
      "gpsSeries": [
        {
          "at": "2026-10-08T11:14:02.000Z",
          "lat": 18.5205,
          "lng": 73.8566,
          "accuracyM": 8,
          "mocked": false
        }
      ],
      "signature": "2f1dc9a45b...",
      "evidenceClientIds": ["b7c8d9e0-1111-2222-3333-444455556666"]
    }
  ]
}
```

`signature` is HMAC-SHA256 over the canonical JSON of the report, keyed with the device key issued
at login.

`201`

```json
{
  "results": [
    {
      "clientId": "3f2a9c10-7b1e-4f0a-9d55-1c2b3a4d5e6f",
      "reportId": "66f0a1b2c3d4e5f600000401",
      "status": "ACCEPTED",
      "duplicate": false,
      "evidenceUploadUrls": {
        "b7c8d9e0-1111-2222-3333-444455556666": "/api/reports/66f0a1b2c3d4e5f600000401/evidence"
      }
    }
  ]
}
```

Per-item failures return `status: "REJECTED"` with an `error` object on that item; the batch as a
whole still returns `201`. The client retries only the rejected items.

### `POST /api/reports/:id/evidence`

`INSPECTOR`. `multipart/form-data`. One image per request.

| Field | Type | Notes |
| --- | --- | --- |
| `file` | binary | Original JPEG, **unmodified bytes** |
| `clientId` | string | Matches an entry in the report's `evidenceClientIds` |
| `sha256` | string | Device-computed, over the same bytes |
| `deviceDHash` | string | Device-computed dHash, 16 hex chars. Stored, never used by L1 |
| `capturedAt` | string | ISO 8601 |
| `location` | JSON string | `{ "coordinates": [lng, lat], "accuracyM": 8, "mocked": false }` |

`201`

```json
{
  "id": "66f0a1b2c3d4e5f600000501",
  "reportId": "66f0a1b2c3d4e5f600000401",
  "storageKey": "evidence/2026/10/66f0a1b2c3d4e5f600000501.jpg",
  "thumbnailUrl": "https://cdn.example.org/thumb/66f0a1b2c3d4e5f600000501.jpg",
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "deviceSha256Match": true,
  "dHash": "f0e1d2c3b4a59687",
  "deviceDHash": "f0e1d2c3b4a59687",
  "deviceServerDHashDistance": 2,
  "capturedAt": "2026-10-08T11:20:00.000Z",
  "location": {
    "type": "Point",
    "coordinates": [73.8566, 18.5205],
    "accuracyM": 8,
    "mocked": false
  },
  "flags": []
}
```

`dHash` is the **server** value from `sharp().resize(9,8).greyscale().raw()`. It is the only value
the L1 reuse check compares against. `deviceSha256Match: false` is recorded as a flag, never a
rejection — the score routes review, it does not block submission.

### `GET /api/reports/:id/trust`

`DISTRICT`, `DIVISION`. Never blocks submission; it prioritises review.

`200`

```json
{
  "reportId": "66f0a1b2c3d4e5f600000401",
  "score": 42,
  "computedAt": "2026-10-08T11:30:00.000Z",
  "factors": [
    {
      "id": "L1",
      "label": "Image reuse",
      "weight": "HIGH",
      "deduction": 35,
      "fired": true,
      "reason": "Photo matches evidence submitted for this institute in cycle 7 (Hamming distance 3 of 64).",
      "evidence": {
        "evidenceId": "66f0a1b2c3d4e5f600000501",
        "matchedReportId": "66f0a1b2c3d4e5f600000388",
        "matchedCycleId": "66f0a1b2c3d4e5f600000207",
        "hammingDistance": 3
      }
    },
    {
      "id": "L3",
      "label": "Mock location",
      "weight": "CRITICAL",
      "deduction": 23,
      "fired": true,
      "reason": "The device reported that its location came from a mock provider.",
      "evidence": { "mocked": true }
    },
    {
      "id": "L2",
      "label": "Byte duplicate",
      "weight": "HIGH",
      "deduction": 0,
      "fired": false,
      "reason": "No exact byte-level duplicate found."
    }
  ],
  "signatureValid": true
}
```

All six factors L1–L6 are always present. Unfired ones carry `fired: false` and `deduction: 0`, so
the dashboard can show what was checked and passed, not only what failed.

---

## Override ledger (F4)

### `POST /api/overrides`

`DISTRICT`, `DIVISION`. **Every weakening action goes through here.** Direct model writes are
blocked at the Mongoose layer (§6), so this is the only door.

```json
{
  "eventType": "ASSIGNMENT_CANCELLED",
  "targetType": "Assignment",
  "targetId": "66f0a1b2c3d4e5f600000301",
  "reasonCode": "INSPECTOR_UNAVAILABLE",
  "justification": "Inspector hospitalised 07 Oct; institute rescheduled to the next cycle.",
  "payload": { "status": "CANCELLED" }
}
```

`eventType` is one of the 8 in PRD F4. `justification` is required, minimum 20 characters.

`201`

```json
{
  "id": "66f0a1b2c3d4e5f600000601",
  "seq": 1487,
  "actorId": "66f0a1b2c3d4e5f600000002",
  "actorRole": "DISTRICT",
  "eventType": "ASSIGNMENT_CANCELLED",
  "targetType": "Assignment",
  "targetId": "66f0a1b2c3d4e5f600000301",
  "reasonCode": "INSPECTOR_UNAVAILABLE",
  "justification": "Inspector hospitalised 07 Oct; institute rescheduled to the next cycle.",
  "previousValue": { "status": "PENDING" },
  "prevHash": "8c3f19aa...",
  "entryHash": "b41d7742...",
  "at": "2026-10-07T15:02:11.000Z"
}
```

The ledger write and the target mutation are one Mongo transaction — both land or neither does.

`403 SELF_APPROVAL_BLOCKED` when the actor is the subject of the action (PRD §6).

### `GET /api/overrides/verify-chain`

`DIVISION`, `AUDITOR`. Walks the chain from genesis and reports the first break.

`200` — intact:

```json
{
  "ok": true,
  "entriesChecked": 1487,
  "genesisAt": "2026-06-01T00:00:00.000Z",
  "headHash": "b41d7742...",
  "checkedAt": "2026-10-08T12:00:00.000Z"
}
```

`200` — broken. Still `200`: a tampered ledger is a finding, not a server error.

```json
{
  "ok": false,
  "entriesChecked": 902,
  "break": {
    "seq": 903,
    "entryId": "66f0a1b2c3d4e5f600000901",
    "expectedEntryHash": "aa11ff00...",
    "storedEntryHash": "bb22ee11...",
    "detail": "Entry 903 does not hash to its stored value — its payload was altered after it was written."
  }
}
```

### `GET /api/overrides/officer-rates`

`DIVISION`. Per-officer override rate against the peer mean, flagging anyone above 2σ.

Query: `?from=2026-01-01&to=2026-10-08&eventType=ALL`

`200`

```json
{
  "window": { "from": "2026-01-01T00:00:00.000Z", "to": "2026-10-08T00:00:00.000Z" },
  "peer": { "mean": 0.061, "stdDev": 0.024, "flagThreshold": 0.109, "officerCount": 18 },
  "officers": [
    {
      "actorId": "66f0a1b2c3d4e5f600000002",
      "name": "R. Deshmukh",
      "role": "DISTRICT",
      "district": "Pune",
      "overrideCount": 34,
      "decisionCount": 210,
      "rate": 0.162,
      "sigmasFromMean": 4.2,
      "flagged": true,
      "byEventType": {
        "ASSIGNMENT_CANCELLED": 19,
        "FINDING_DOWNGRADED": 11,
        "INSTITUTE_EXEMPTED": 4
      }
    }
  ],
  "patterns": [
    {
      "type": "CONSECUTIVE_EXEMPTION",
      "instituteId": "66f0a1b2c3d4e5f600000042",
      "cycles": [9, 10, 11],
      "detail": "Institute exempted in 3 consecutive cycles by the same officer."
    },
    {
      "type": "REPEAT_DOWNGRADE",
      "actorId": "66f0a1b2c3d4e5f600000002",
      "instituteId": "66f0a1b2c3d4e5f600000042",
      "count": 7,
      "detail": "One officer downgraded 7 findings from a single institute."
    },
    {
      "type": "LATE_REASSIGNMENT",
      "assignmentId": "66f0a1b2c3d4e5f600000301",
      "hoursAfterReveal": 62,
      "detail": "Reassigned after the schedule was knowable by the institute."
    }
  ]
}
```

---

## Dashboard (F6)

### `GET /api/dashboard/velocity`

`DIVISION`. Monitoring decay — the failure mode PRD §4.2 says these systems die of.

Query: `?cycles=12`

`200`

```json
{
  "series": [
    {
      "cycleId": "66f0a1b2c3d4e5f600000201",
      "label": "2026-10",
      "assigned": 200,
      "completed": 171,
      "overdue": 12,
      "cancelled": 17,
      "completionRate": 0.855,
      "medianDaysToSubmit": 6.5,
      "overrideRate": 0.085
    }
  ],
  "trend": { "completionRateSlopePerCycle": -0.021, "decaying": true }
}
```

### `GET /api/dashboard/scorecard`

`DIVISION`. Detections against the false-positive burden they impose (PRD §4.5, §12).

`200`

```json
{
  "window": { "from": "2026-01-01T00:00:00.000Z", "to": "2026-10-08T00:00:00.000Z" },
  "flagsRaised": 312,
  "flagsActioned": 240,
  "flagsConfirmed": 96,
  "flagsDismissed": 144,
  "falsePositiveRate": 0.6,
  "unactionedPastSla": 72,
  "medianDaysToAction": 4.5,
  "bySignature": {
    "GHOST_INTAKE": 21,
    "THRESHOLD_GAMING": 33,
    "EVIDENCE_REUSE": 18,
    "PREPARED_VISIT": 14,
    "INSPECTOR_CAPTURE": 10,
    "CLEAN": 216
  },
  "inspectorHoursAdded": 410
}
```

### `GET /api/institutes/:id/risk`

`DISTRICT`, `DIVISION`, and `INSTITUTE` for its own record only. Proxies the FastAPI service.

`200`

```json
{
  "instituteId": "66f0a1b2c3d4e5f600000042",
  "riskScore": 0.81,
  "riskSignature": "THRESHOLD_GAMING",
  "computedAt": "2026-10-08T02:00:00.000Z",
  "model": {
    "name": "logistic-regression",
    "version": "0.3.0",
    "trainedOn": "RANDOM allocations only"
  },
  "topFactors": [
    {
      "feature": "occupancy_vs_funding_threshold",
      "contribution": 0.34,
      "explanation": "Reported occupancy has sat 1–3% above the funding cut-off for 5 consecutive cycles."
    },
    {
      "feature": "finding_severity_trend",
      "contribution": 0.27,
      "explanation": "Findings downgraded from HIGH to LOW in 4 of the last 6 reviews."
    },
    {
      "feature": "evidence_recency",
      "contribution": 0.2,
      "explanation": "Three photographs reused from earlier cycles."
    }
  ],
  "recommendedProtocol": "Verify the intake register against an occupancy count on an unannounced visit.",
  "coldStart": false
}
```

`coldStart: true` means the score came from Isolation Forest with no labelled history — the
dashboard must label it provisional.

---

## Phase 2 endpoints

### `POST /api/vc/sessions`

`DISTRICT`, `DIVISION`. Sessions are scheduled by the §4 randomisation engine — unannounced.
**Recording is off by default and enabling it requires an OverrideEvent** (§23).

```json
{
  "instituteId": "66f0a1b2c3d4e5f600000042",
  "scheduledAt": "2026-11-12T10:00:00.000Z",
  "durationMinutes": 20,
  "participantRoles": ["INSTITUTE", "BENEFICIARY"],
  "beneficiaryCount": 3,
  "seed": "optional-cycle-seed-for-reproducible-selection"
}
```

`201`

```json
{
  "id": "66f0a1b2c3d4e5f600000701",
  "instituteId": "66f0a1b2c3d4e5f600000042",
  "roomName": "nirikshan-42-8f3a1c",
  "joinUrl": "https://meet.jit.si/nirikshan-42-8f3a1c",
  "jwt": "eyJhbGciOiJIUzI1NiIs...",
  "scheduledAt": "2026-11-12T10:00:00.000Z",
  "durationMinutes": 20,
  "recordingEnabled": false,
  "participants": [{ "role": "BENEFICIARY", "consentRequired": true, "consentGivenAt": null }],
  "notifiedAt": null
}
```

Participants are stored **by role, not by name** — beneficiaries are never identified (PRD §11).

### `GET /api/stream/:instituteId/index.m3u8`

`DISTRICT`, `DIVISION`. Returns an HLS playlist, `Content-Type: application/vnd.apple.mpegurl`.

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:120
#EXTINF:4.000,
segment120.ts
#EXTINF:4.000,
segment121.ts
```

`404 NOT_FOUND` when the institute has no configured stream. The demo source is a looped file — say
so out loud (§22): the camera is simulated, the pipeline is real.

---

## Sign-off

Each member confirms they have read this and will build against it.

| Member | Workstream | Signed off |
| --- | --- | --- |
|  | API / ledger | ☐ |
|  | Assignment engine / core | ☐ |
|  | Mobile | ☐ |
|  | Dashboard | ☐ |
|  | ML / CV | ☐ |
|  | Seed data / demo | ☐ |
