# Nirikshan — Verifiable Inspection & Monitoring Platform

**Surprise inspections you can prove. Evidence you can trust. Overrides no one can hide.**

Nirikshan is a centralized inspection, monitoring and audit platform for projects, institutes and NGOs running under Department of Social Justice & Empowerment (DoSJE) schemes — hostels, senior homes, de-addiction centres and disability institutions.

<sub>Smart India Hackathon 2026 · Problem Statement **SIH26095** · Ministry of Social Justice & Empowerment · Team **G-AMPS**</sub>

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![MongoDB](https://img.shields.io/badge/db-MongoDB%207-green)

---

## Table of contents

- [The idea](#the-idea)
- [Why this matters](#why-this-matters)
- [What makes this different](#what-makes-this-different)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Getting started](#getting-started)
- [Demo in 5 minutes](#demo-in-5-minutes)
- [Roles & access](#roles--access)
- [API overview](#api-overview)
- [Verification & trust](#verification--trust)
- [Mobile — offline-first](#mobile--offline-first)
- [Dashboard](#dashboard)
- [Testing & quality](#testing--quality)
- [Documentation](#documentation)
- [Roadmap](#roadmap)
- [Team](#team)
- [License](#license)

---

## The idea

Most inspection systems record **what was decided**. Nirikshan records **that the decision was fair**.

1. **Commit** — Division publishes `commitmentHash = SHA256(seed)` before the draw. The schedule can't be rigged after this point.
2. **Draw** — Constrained-random engine (`packages/core/assign.js`) assigns inspectors under C1–C4: no-repeat window, home-district exclusion, workload cap, travel feasibility.
3. **Reveal + Verify** — Seed is revealed. Anyone — journalist, auditor, NGO — opens `/verify.html?cycle=:id` with **no login** and replays the exact draw in their browser using the same isomorphic code the server ran. `MATCH` or `MISMATCH`.

```
publish commitment ──► random draw (C1–C4) ──► reveal seed ──► public replay
SHA256(seed)           assign(institutes,      seed + stored      verify.html
                       inspectors, history,   config             MATCH / MISMATCH
                       seed)
```

On top sits a second guarantee: every photo is scored for reuse/spoofing (9-layer trust score), and every weakening action — cancel, reassign, downgrade, exempt — is forced through an append-only hash-chained ledger. There is no quiet edit.

---

## Why this matters

The ministry's expected outcome is not "more dashboards" — it is **reduction in fake reporting and proxy functioning**:

| Fraud mode | What it looks like | Nirikshan countermeasure |
|---|---|---|
| **Ghost beneficiaries** | 100 residents claimed, 40 housed | Attendance analytics, random VC with beneficiaries, occupancy CV |
| **Proxy functioning** | Institute performs only when inspection is announced | Surprise draws, unannounced VC, offline mobile capture |
| **Fake inspection reports** | Inspector never visits / is captured by institute | Random duty assignment, geo-tagged live evidence, trust score, override ledger |

---

## What makes this different

### 1. Verifiable randomisation (F1) — not just "random"
Commit–reveal + deterministic seeded engine + public client-side replay. 100% of cycles independently replayable. Zero C1–C4 violations across the 12-cycle simulation in tests.

### 2. Evidence trust score (F3) — 9 layers, never a gate
L1 image-reuse (dHash), L2 byte duplicate (SHA-256), L3 mock-location, L4 device integrity, L5 travel feasibility, L6 geofence, L7 temporal anomaly, L8 capture-to-submit gap, L9 tamper indicators. The score **routes human review — never blocks submission**.

### 3. Override ledger (F4) — tamper-evidence, not tamper-proof claims
A Mongoose `requireOverride` plugin **refuses** direct `updateOne / deleteOne / findOneAndUpdate` on `Assignment`, `InspectionReport`, `Finding`. Every weakening must call `POST /api/overrides` with a structured reason code → hash chain (`seq`, `prevHash`, `entryHash`) + nightly Merkle anchor + `GET /api/overrides/verify-chain`.

### 4. Isomorphic core — one truth, three runtimes
`packages/core` is pure ES modules with zero Node built-ins (only `seedrandom`). The same `assign()`, `dhash()`, `trust.score()` runs on **Node (draw), browser (verify), React Native (capture)**. Pixel extraction is a caller-supplied adapter.

---

## Features

| ID | Feature | Status |
|---|---|---|
| **F1** | Verifiable assignment draw + public `/verify.html` replay | Done |
| **F2** | Mobile inspection: camera-only capture, HMAC-signed, SQLite outbox, 30s sync ticker | Done |
| **F3** | 9-layer evidence trust score (L1–L8 live, L9 measured) | Done |
| **F4** | Override ledger: hash chain, reason codes, officer-rate monitor, Merkle anchor | Done |
| **F6** | Dashboard: Overview, Action Queue, Risk Map (Leaflet), Report detail, Verify link | Done |
| **F5** | Risk model + 6 fraud signatures (`GHOST_INTAKE`, `THRESHOLD_GAMING`, …) | Seeded / rules (ML Phase 2) |
| **F10** | SLA escalation + velocity panel | API + seeded |
| **F7** | CCTV: MediaMTX → ffmpeg → HLS | Phase 2 |
| **F8** | Random VC: Jitsi, unannounced, recording-off-by-default | Phase 2 |
| **F9** | Occupancy counting (YOLOv8n, count-only, frames discarded) | Phase 2 |

Checklists shipped: `hostel.v1`, `senior-home.v1`, `deaddiction-centre.v1` in `apps/api/checklists/`.

---

## Tech stack

| Layer | Choice |
|---|---|
| Mobile | Expo 57 (RN 0.86, expo-router, camera, location, sqlite, secure-store), i18n en/hi |
| Dashboard | React 19 + Vite 8 + Tailwind 4 + React Router 7 + Leaflet |
| API | Node >=20 + Express 5 + Mongoose 9 + JWT + bcrypt + sharp |
| Shared core | `@nirikshan/core` — pure ESM (`assign`, `trust`, `dhash`, `hamming`, `canonical`, `hmac`, `constants`) + `seedrandom` |
| Database | MongoDB 7 replica set (single-node via Docker; transactions required) |
| Evidence store | Backblaze B2 (originals) or `./fixtures/uploads/` fallback; 320px JPEG thumbs via sharp |
| ML / CV (P2) | FastAPI (`/occupancy`, `/risk`), YOLOv8n, logistic regression + Isolation Forest |
| Streaming / VC (P2) | MediaMTX + HLS, Jitsi Meet |
| DevOps | npm workspaces, Docker Compose, GitHub Actions, EAS build |

---

## Architecture

```
              +------------------+
              | Dashboard (Vite) |  Overview / Queue / RiskMap / Report
              | React + Leaflet  |<- public /verify.html (no auth)
              +--------+---------+
                       | JWT /api/*
              +--------v---------+      +--------------+
              |  API (Express)   |----->| MongoDB 7    |
              | cycles / reports / trusts / overrides  | Institutes, Cycles, Reports, Ledger |
              +------------------+      +--------------+
                       |
        +--------------+----------------+
        v              v                v
 packages/core   B2 / local       FastAPI (P2)
 assign/trust/   evidence store   /occupancy /risk
        ^
        | same code
 +------+-----------+
 | Mobile (Expo)    |  inbox -> assignment -> inspect
 | offline SQLite   |  camera-only + GPS + HMAC + outbox
 +------------------+
```

Key invariants: engine knobs live per-cycle in `InspectionCycle.config` (never env); trust thresholds live in `packages/core/constants.js` (git history); verify path is public by design.

---

## Repository layout

```
nirikshan/
+- apps/
|  +- api/              Express + Mongoose (cycles, assignments, reports, evidence, trust, overrides)
|  |  +- checklists/    hostel.v1, senior-home.v1, deaddiction-centre.v1
|  +- dashboard/        React + Vite (App, Overview, Queue, RiskMap, Report)
|  |  +- public/verify.html  public replay page (imports /core + /vendor from API)
|  +- mobile/           Expo (app/ inbox, assignment/[id], inspect/[id]; lib/ api, db, sync, sign)
|  +- ml/               FastAPI stub — Phase 2
+- packages/core/       assign.js, trust.js, dhash.js, hamming.js, hmac.js, canonical.js, constants.js
+- scripts/             seed.js (200/30/12 + fraud plants), seed-users.js, dev-demo.js, smoke-models.js
+- fixtures/            evidence/ (~25 JPEGs), uploads/, hls/
+- tests/               assign, assignments, auth, core, cycles, dashboard, evidence, ledger, reports
+- infra/docker-compose.yml  MongoDB 7 replica set (loopback only)
+- docs/API.md          Frozen API contract (change here first, then code)
+- .env.example         Every var the project needs
+- PRD_SIH26095_Nirikshan.md  Source of truth
```

---

## Getting started

### Prerequisites

- Node.js `>=20`, npm `>=10`
- Docker + Docker Compose (MongoDB replica set)
- Mobile: Expo dev-client / EAS; Dashboard: modern browser

### Setup

```bash
git clone https://github.com/parth2029-glitch/SIH-26095-Nirikshan-.git
cd SIH-26095-Nirikshan-

npm install
cp .env.example .env
# Edit .env — at minimum JWT_SECRET, DEVICE_HMAC_SECRET, SEED_USER_PASSWORD

npm run db:up        # MongoDB replica set (ledger needs transactions)
npm run api:dev      # http://localhost:4000
npm run dash:dev     # http://localhost:5173 (proxies /api + /verify.html + /core)
npm run mobile:start # Expo — or npx expo run:android inside apps/mobile

npm run seed -- --reset --serve  # 200 institutes, 30 inspectors, 12 cycles + 6 fraud plants
npm run seed:users               # lightweight: one account per role
```

Key env vars (see `.env.example`): `PORT=4000`, `MONGODB_URI`, `JWT_SECRET`, `DEVICE_HMAC_SECRET`, `B2_*` (optional — local fallback), `ML_SERVICE_URL`, `JITSI_*`, `MEDIAMTX_RTSP_URL`, `EXPO_PUBLIC_API_BASE_URL`.

```bash
npm test            # node --test (all suites)
npm run lint
npm run format
npm run demo:cycle  # ephemeral Mongo + SEALED / MATCH / MISMATCH verify URLs
npm run db:down
```

---

## Demo in 5 minutes

**Option A — zero-install draw (F1):**

```bash
npm run demo:cycle
# Open the three printed URLs — no login needed:
#   SEALED    commitment published, pairings withheld
#   MATCH     replays from seed in your browser
#   MISMATCH  same, after one row edited behind the API's back
```

**Option B — full story (F1 + F3 + F4):**

```bash
npm run db:up
npm run seed -- --reset --serve   # deterministic — run twice, compare fingerprint
# 1. Login as division@example.test / nirikshan-dev → Overview → Queue → Risk map
# 2. Open /verify.html?cycle=<id> → Verify → MATCH
# 3. Cancel one assignment as the Pune officer → ledger entry + officer rate moves (e.g. 5.9% → 6.4%)
# 4. Open a planted EVIDENCE_REUSE report → trust score cites the earlier report
```

Seed logins (password `nirikshan-dev` locally): `division@`, `district@`, `inspector@`, `institute@`, `beneficiary@`, `auditor@example.test`.

---

## Roles & access

`INSPECTOR` · `DISTRICT` · `DIVISION` · `INSTITUTE` · `BENEFICIARY` · `AUDITOR`

- `DIVISION` creates / assigns / reveals cycles, writes + verifies ledger.
- `DISTRICT` + `DIVISION` write overrides; `AUDITOR` reads the chain, writes nothing.
- `INSPECTOR` reads `GET /api/assignments/mine`, submits reports + evidence.
- `INSTITUTE` reads its own record only (scope from JWT claims).
- Auth is opt-out (`authGate`); public: `POST /api/auth/login`, `GET /api/cycles/:id/verify`, `/verify.html`, `/core/*`.

---

## API overview

Base `http://localhost:4000` · JSON · ObjectIds · ISO-8601 UTC · `Authorization: Bearer <jwt>` · errors as `{ error: { code, message, details } }`.

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/login` | public |
| POST | `/api/cycles` → `/api/cycles/:id/assign` → `/api/cycles/:id/reveal` | DIVISION |
| GET | `/api/cycles/:id/verify` + `/verify.html?cycle=:id` | public |
| GET | `/api/assignments/mine` | INSPECTOR |
| POST | `/api/reports` (batch, idempotent) + `/api/reports/:id/evidence` | INSPECTOR |
| GET | `/api/reports/:id/trust`, `/api/evidence/:id/thumbnail` | DISTRICT, DIVISION (+AUDITOR thumbs) |
| POST | `/api/overrides` + `GET /api/overrides/verify-chain` + `/officer-rates` | DISTRICT/DIVISION (verify: +AUDITOR) |
| GET | `/api/dashboard/cycles|findings|unactioned|institutes`, `/api/reports/:id` | scoped by role |
| GET | `/api/institutes/:id` (+ `/risk` via ML) | scoped |

Full bodies: [`docs/API.md`](./docs/API.md).

---

## Verification & trust

- **Replay:** `verify.html` imports `/core/assign.js` + `/vendor/seedrandom` served by the API itself — publishing the engine source *is* the feature.
- **Deferrals carry reasons:** `deferred: [{ instituteId, reason: "No inspector satisfied C2 and C4…" }]` — a bare count tells an officer nothing.
- **Trust:** `GET /api/reports/:id/trust → { score: 35, factors: [{ id: "L1", title: "Image reuse", points: 25, cites: […] }] }`.
- **Ledger:** every `OverrideEvent` has `seq`, `prevHash`, `entryHash`, one of 21 `reasonCode`s + justification; `verify-chain` re-hashes head-to-tail; nightly Merkle anchor.

---

## Mobile — offline-first

- Camera-only (gallery reads blocked in `app.json`), GPS per photo, device dHash at capture, HMAC-signed payload.
- SQLite outbox + 30s ticker drain: exp. backoff 5s→15min, batch 20, idempotency key = batch clientIds, reports-first-then-images, 4xx backs off (never drops work).
- Bilingual (`en`/`hi`), `SyncStatus` indicator, expo-router `inbox → assignment/[id] → inspect/[id]`.

---

## Dashboard

Role-scoped nav: Division/District → Overview + Action Queue + Risk Map; Auditor → read-only; Institute → own record. Velocity + scorecard from `GET /api/dashboard/*`; "Verify a cycle" links the public page. Same-origin in dev (Vite proxy) and prod (served by API) — no second topology.

---

## Testing & quality

```bash
npm test && npm run lint && npm run format:check
```

- `tests/` on ephemeral `mongodb-memory-server` replset: draw determinism, 12-cycle zero-violation simulation, ledger lockdown (direct `updateOne` rejects; raw retro-edit caught by `verify-chain`), auth 403s, trust plants, evidence dedupe.
- CI (`.github/workflows/ci.yml`): `npm ci → lint → format:check → test` on every push/PR (Node 22).
- ESLint bans Node built-ins in `packages/core` and `bulkWrite` in the API (ledger bypass); Prettier enforced.

---

## Documentation

- [`PRD_SIH26095_Nirikshan.md`](./PRD_SIH26095_Nirikshan.md) — **source of truth**: problem, research, F1–F10, privacy, build plan
- [`docs/API.md`](./docs/API.md) — frozen endpoint contract
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) / [`IMPLEMENTATION_PLAN_V2.md`](./IMPLEMENTATION_PLAN_V2.md) — ordered build checklist (Sections 0–25)
- [`infra/docker-compose.yml`](./infra/docker-compose.yml) — why Mongo runs as a replica set
- [`.env.example`](./.env.example) — every var, with why engine knobs are *not* env vars

---

## Roadmap

- [x] Phase 1 (→ 20 Sept 2026): F1 + F2 + F3 + F4 + dashboard + 200/30/12 seed + demo script
- [ ] Phase 2 (Oct–Nov): risk model with explanations, YOLOv8n occupancy, fraud-signature classifier, velocity + two-sided scorecard, CCTV (MediaMTX→HLS), Jitsi VC
- [ ] Phase 3 (Dec finale, 36h): polish, offline rehearsal, hardening, Q&A — no new features after 1 Dec

> Confirm PS ID, theme label and deadline on `sih.gov.in/sih2026PS` before SPOC submission (mirrors disagree: 20 vs 30 Sept 2026).

---

## Team

**G-AMPS** — Backend · Mobile · Frontend · ML/CV · Data/DevOps · Research/Presenter. Six members per SIH mandate (allocation in PRD §13).

---

## License

MIT. `.env` never committed; `fixtures/uploads/` git-ignored; Mongo bound to `127.0.0.1` in dev.

