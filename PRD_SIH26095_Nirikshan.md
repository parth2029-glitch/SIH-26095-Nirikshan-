# Product Requirements Document

## Nirikshan — Verifiable Inspection & Monitoring Platform

**Problem Statement:** SIH26095 — Smart Real-Time Monitoring & Inspection Mobile App
**Sponsoring Organisation:** Ministry of Social Justice & Empowerment (MoSJE / DoSJE)
**Category:** Software
**Team:** G-AMPS
**Document version:** 1.0
**Date:** 4 September 2026

> **Verify before submission.** The PS ID, theme label and deadline in this document were
> cross-checked against two independent community mirrors of the SIH 2026 list, which
> disagree with each other on theme and on total statement count. Confirm all of it directly
> on `sih.gov.in/sih2026PS` before your SPOC submits. Deadline appears as either 20 or 30
> September 2026.

---

## 1. Document purpose

This PRD is the single source of truth for what we are building, why each decision was made,
and what we are deliberately *not* building. It exists because the biggest failure mode for a
hackathon team on a seven-feature problem statement is building all seven badly.

Every design decision in Section 8 traces back to a specific research finding in Section 4.
If a feature cannot be traced to a finding or to explicit PS text, it should be cut.

---

## 2. The problem statement

### 2.1 Official text (as published)

Develop a centralized mobile application for real-time monitoring, surprise inspections, CCTV
surveillance integration, and random inspection assignment for projects / institutes / NGOs
running under DoSJE schemes.

**Key features listed:**

- Live CCTV feed integration from projects / institutes
- Random Video Conferencing (VC) connectivity with Project Incharge / Staff / Beneficiaries
- Real-time monitoring dashboard for Department officials
- Mobile-based inspection module for PMU / Inspection Teams
- Random assignment of inspection duties through AI / automation
- Geo-tagged inspection reports and live evidence capture
- AI-based anomaly and attendance analytics

**Stakeholders:** DoSJE Divisions, PMU Teams, NGOs / Institutes, Beneficiaries, State / District
Authorities

**Expected outcomes:** Improved transparency and accountability; reduction in fake reporting and
proxy functioning; real-time monitoring of projects; better inspection governance and compliance;
enhanced citizen-centric service delivery.

### 2.2 What the ministry is actually buying

Read the expected outcomes again. *Reduction in fake reporting and proxy functioning* is the
core. Every listed feature is a countermeasure against a specific fraud mode:

| Fraud mode | What it looks like | PS feature that targets it |
|---|---|---|
| **Ghost beneficiaries** | Institute claims 100 residents, houses 40 | Attendance analytics, random VC with beneficiaries |
| **Proxy functioning** | Institute performs only when an announced inspection is due | Surprise inspections, unannounced VC |
| **Fake inspection reports** | Inspector never visits, or is cultivated by the institute over repeat visits | Random duty assignment, geo-tagged live evidence capture |

**Our pitch is organised around these three fraud modes, not around the seven bullets.** This is
the single biggest differentiator available to us, because most competing teams will present a
feature list.

### 2.3 Institutions in scope

MoSJE funds and oversees residential and service institutions including SC/ST/OBC student
hostels, homes for senior citizens (AVYAY / IPSrC), de-addiction and rehabilitation centres
(NAPDDR — IRCA, ODIC, CPLI), and institutions serving persons with disabilities. Many are run by
NGOs under grant-in-aid schemes administered through the e-Anudaan portal.

**Consequence for design:** these institutions house minors, elderly residents and people in
recovery. Section 13 (Privacy & Legal) is a hard constraint, not a nice-to-have.

---

## 3. Goals and non-goals

### 3.1 Goals

| # | Goal | Measurable outcome |
|---|---|---|
| G1 | Make inspection assignment unriggable and **provably** so | Any third party can independently verify an assignment cycle was not tampered with |
| G2 | Make submitted evidence verifiable rather than assumed | Every report carries a computed trust score with itemised reasons |
| G3 | Instrument the administrative layer above the inspector | Every exemption, override, cancellation and reassignment is logged and attributed |
| G4 | Close the loop from detection to action | Flagged items have owners, SLAs and escalation; unactioned flags are themselves flagged |
| G5 | Cause minimal harm to compliant institutions | False-positive burden is reported alongside detections |
| G6 | Verify presence without identifying individuals | Occupancy counting only; zero facial recognition |

### 3.2 Non-goals

- We are **not** claiming to eliminate fraud. The research says no system does.
- We are **not** building production CCTV infrastructure or a video conferencing stack.
- We are **not** replacing e-Anudaan, PFMS, or NGO Darpan. We integrate conceptually.
- We are **not** doing financial / ledger audit. That is CAG's job and a different problem.
- We are **not** identifying individual beneficiaries by biometrics or face.

---

## 4. Research foundation

Roughly 30 papers were reviewed. Full citations are in the companion research report. The
findings that directly drive design decisions:

### 4.1 Random assignment works — this is proven policy, not a gimmick

Duflo, Greenstone, Pande & Ryan (2013, *QJE*) ran a two-year RCT on 473 Gujarat factories. The
status quo — where the audited firm chose and paid its own auditor — was largely corrupted, with
auditors reporting emissions just below the legal threshold when true readings were higher. Random
assignment plus central payment plus back-checking plus accuracy bonuses substantially improved
truth-telling. **Gujarat reformed its actual regulations in 2015 as a result.**

Olken (2007, *JPE*) — 608 Indonesian village road projects. Raising audit probability from 4% to
100% cut missing expenditure by 8 percentage points. Community monitoring alone had little average
effect. Notably, nepotism *rose* in response, suggesting substitution between corruption forms.

Abbink (2004) — the mechanism. When repeat interaction is removed, the shared expectation that
collusion is safe collapses.

The Chinese CSRC random-inspection literature adds one refinement: that regime randomises **both**
the inspected entity and the inspector. Randomising one side leaves an attack surface.

> **Design consequence (F1):** Randomisation is the intellectual core of the product, not a
> scheduling utility. Randomise institute-to-inspector pairing, not just visit timing.

### 4.2 These systems decay, and they are defeated administratively

Two Indian studies read side by side are the most important finding in this document.

- Duflo, Hanna & Ryan (2012, *AER*) — camera-based attendance monitoring in ~150 Rajasthan
  schools produced immediate and durable improvement. **The technology worked.**
- Banerjee, Duflo & Glennerster (2008, *JEEA*) — near-identical approach applied to government
  nurses. Highly effective initially. Then the local health administration began granting
  increasing numbers of **"exempt days."** Within 18 months the programme was completely
  ineffective.

Nothing broke. No camera failed. The officials operating the system dismantled it from the inside
using a legitimate administrative feature.

Callen, Gulzar, Hasanain, Khan & Rezaee (2020, *JDE*) is effectively our PS, already built. Punjab
(Pakistan) "Monitoring the Monitors" gave inspectors smartphones that geocoded and time-stamped
inspections onto a dashboard for senior managers. Result: **+104% inspections at 6 months, falling
to +43.8% (not statistically significant) at 12 months**, with no clear evidence of improved staff
attendance. But: **when senior officials acted on the flagged information, doctor attendance rose
75%.**

> **Design consequence (F4, F6, G4):** Instrument the exemption/override layer as a first-class
> monitored entity. Track monitoring *velocity*, not just level. Make unactioned flags visible.

### 4.3 The right countermeasure depends on the fraud mode

Muralidharan, Niehaus & Sukhtankar (2016, 2020) — biometric authentication reduced leakage where
the problem was ghost beneficiaries, and did essentially nothing where the problem was
under-delivery to real beneficiaries. In Jharkhand, ABBA alone did not reduce leakage, slightly
raised transaction costs, and reduced benefits ~10% for those without prior ID registration.
Niehaus & Sukhtankar (2013) distinguish **ghosts** (do not exist) from **quasi-ghosts** (exist,
never received).

> **Design consequence (F5):** Classify an institute's fraud signature *before* selecting a
> verification protocol. Do not apply one blanket method.

### 4.4 Digital monitoring imposes real costs on the compliant

The NMMS (MGNREGA) critique is extensive: a 2023 Parliamentary Committee on Rural Development
report urged review; documented failures include device incompatibility, poor connectivity, and
the false assumption of universal smartphone ownership. Critics noted the ministry never quantified
the corruption being targeted or explained the mechanism.

> **Design consequence (F2, G5):** Offline-first is mandatory, not optional. Report false-positive
> burden alongside detections.

### 4.5 Automated fraud detection has a labelling problem

Medina-Hernández, Kertész & Fazekas (2025) name it precisely: supervised ML for procurement fraud
is blocked by **the absence of confirmed non-corrupt examples**. You know some cases were fraud;
you never know for certain which were clean. Their workaround is positive-unlabelled learning.

Separately, a 2026 study on 3.3M public-sector ledger entries combines Isolation Forest, Z-score
and ratio screening with a SHAP explainability layer, and documents an *aggregation masking
effect* where Benford's Law anomalies visible at transaction level vanish once aggregated. All of
this literature is financial; none of it has been applied to physical inspection data.

> **Design consequence (F5) — our strongest novel claim:** Randomly-assigned inspections produce an
> **unbiased ground-truth sample by construction**. That is exactly the clean labelled data the
> fraud-ML literature says is missing. Train the risk model on the random sample; use the model to
> allocate the *non-random* share of inspection capacity. Randomisation stops being only a
> deterrent and becomes the label generator.

### 4.6 Evidence integrity techniques exist but are unvalidated in this setting

Perceptual hashing (dHash / pHash) reliably catches recycled images, but Prokos et al. (2021,
USENIX Security) demonstrated adversarial attacks that evade perceptual-hash matching — **a single
method is insufficient**. GPS spoofing detection likewise requires layering: OS mock-location flag,
root/emulator detection, physics checks (impossible speed), and Wi-Fi/cell cross-referencing. One
paper proposes accelerometer step-count corroboration.

> **Design consequence (F3):** Layered evidence trust score, never a single check.

### 4.7 Counting without identifying is a solved research problem, unused here

Chan, Liang & Vasconcelos (2008, *CVPR*) established crowd-size estimation without object detection
or tracking, implementable on hardware producing no visual record of individuals. Later work runs
this on edge devices with encryption. Meanwhile Indian welfare schemes are moving toward facial
recognition of individual beneficiaries (e.g. Poshan Tracker).

> **Design consequence (F9, Section 13):** Occupancy counting only. No face recognition anywhere
> in the system.

---

## 5. Existing systems and our differentiation

### 5.1 What already exists

| System | Owner | What it does | What it does not do |
|---|---|---|---|
| **e-Anudaan** | MoSJE | NGO grant-in-aid application, document verification, approval workflow. **Already tied to CCTV policy.** | No inspection assignment, no evidence verification, no anomaly detection |
| **NGO Darpan** | NITI Aayog | NGO registry, unique IDs, blacklisting | Directory only; no field data |
| **NMMS** | MoRD (MGNREGA) | Two geo-tagged, time-stamped attendance photos per day | No published verification that photos are fresh, unedited, unique or correctly located |
| **National Scholarship Portal** | MoE / MoSJE | Scholarship applications and payments | CAG found sole reliance on it enabled large-scale irregularities |
| **Poshan Tracker** | MWCD | Facial recognition beneficiary verification | Privacy/legal exposure, especially with children |
| **Monitoring the Monitors** | Govt. of Punjab, Pakistan | Geo/time-stamped inspector app + senior dashboard | Effect decayed within a year; closest existing twin to this PS |
| **SafetyCulture, Tyler Technologies, SBN Inspect** | Commercial | Fast digital inspection checklists | Assume a cooperative inspector; zero anti-collusion design |

### 5.2 The critical prior-art finding

**MoSJE already issued a CCTV order in 2020.** Organisations receiving ministry grants were
required to install CCTV with live feeds available on their websites, proactively disclose
performance on e-Anudaan, and the ministry planned to review footage from at least 5% of such
organisations annually. During COVID, first grant instalments were released **without physical
inspection by PMU State Coordinators**, with monitoring done instead via live CCTV feeds shared by
the organisations.

> **We must say this openly in the pitch.** The CCTV and VC bullets are not novel ideas we are
> proposing — they are an existing, partially-implemented ministry policy that needs proper
> operationalisation. Acknowledging this demonstrates domain research and immediately separates us
> from teams presenting CCTV as their innovation.

### 5.3 Our eight differentiators

| # | Gap | Why nobody has done it | Our answer |
|---|---|---|---|
| D1 | **Nobody monitors the office above the inspector** | Research treats administration as neutral | Exemption/override ledger with per-officer anomaly detection (F4) |
| D2 | **Randomness is never made provable** | Economics literature evaluates policy, not algorithms | Commit–reveal published seed; independently replayable draw (F1) |
| D3 | **Random audits as label generator** | Fraud-ML literature lacks confirmed negatives | Train risk model on random sample; target the non-random capacity (F5) |
| D4 | **Evidence integrity is assumed** | NMMS collects photos, verifies nothing published | Layered trust score: pHash + hash-chain + spoof detection + travel feasibility (F3) |
| D5 | **One-size-fits-all countermeasures** | Tools deployed before diagnosing fraud mode | Fraud-signature classification drives protocol selection (F5) |
| D6 | **Decay is reported, never designed against** | Studies end at publication | Monitoring velocity as a tracked KPI with escalation (F6) |
| D7 | **False-positive burden never measured** | Systems optimise for detections | Two-sided scorecard (F6) |
| D8 | **Face recognition where counting suffices** | Convenience over proportionality | Privacy-preserving occupancy estimation (F9) |

---

## 6. Users and roles

| Role | Who | Primary needs |
|---|---|---|
| **Inspector (PMU field)** | PMU / Inspection Team member | Receive assigned duties, conduct inspection offline, capture evidence, submit |
| **District Officer** | State/District authority | Review submissions, act on flags, approve or reject exemption requests |
| **Division Official (DoSJE)** | Ministry division | Portfolio-level dashboard, risk view, override monitoring, escalation |
| **Institute Admin** | NGO / institute in-charge | Respond to findings, upload compliance evidence, view own record, appeal |
| **Beneficiary** | Resident of the institution | Participate in random VC (consented, opt-out), raise a grievance |
| **System Auditor** | Any third party, incl. CAG | Independently verify assignment fairness from published commitments |

**Role separation is a security requirement.** An Inspector cannot cancel their own assignment.
A District Officer cannot approve their own exemption request. All override actions require a
reason code and are written to an immutable ledger.

---

## 7. Domain model

Core entities and their relationships:

```
Institute ──< Scheme (AVYAY / NAPDDR / hostel GIA ...)
    │
    ├──< InspectionCycle ──< Assignment ──> Inspector
    │                            │
    │                            └──< InspectionReport ──< EvidenceItem
    │                                        │
    │                                        └──< Finding ──< Action
    │
    ├──< OccupancySnapshot   (from CCTV frames or VC)
    ├──< VCSession
    └──< RiskProfile         (fraud signature + score)

OverrideEvent ──> {Assignment | InspectionReport | Finding}   [immutable ledger]
CycleCommitment ──> InspectionCycle                            [commit–reveal record]
```

---

## 8. Feature specification

Priority key: **P0** = must ship, this is the differentiator. **P1** = must ship, PS-mandated.
**P2** = demonstrate the integration path only.

---

### F1 — Verifiable Random Assignment Engine `P0`

*The intellectual centre of the product. Traces to 4.1.*

**Description.** Assigns inspectors to institutes for each cycle such that the schedule is
unpredictable to institutes, un-riggable by officials, and independently verifiable by anyone.

**Constraints enforced:**

| ID | Constraint | Rationale |
|---|---|---|
| C1 | No inspector–institute pairing repeats within N cycles (default N=4) | Abbink (2004): break repeat interaction |
| C2 | No inspector assigned within their declared home district | Local capture |
| C3 | Workload balanced within ±15% across the inspector pool | Prevents dumping and burnout |
| C4 | Travel feasibility: assignments per day must be geographically achievable | Prevents impossible schedules that force falsification |
| C5 | Risk-weighted allocation applies **only** to the non-random capacity share | Preserves the unbiased sample (see F5) |

**Capacity split.** Each cycle divides inspection capacity:

- **70% random** — pure constrained-random draw. This is the ground-truth sample.
- **30% risk-targeted** — allocated by the F5 risk model.

The split is configurable and displayed on the dashboard. The random portion must never be
overridden without a logged OverrideEvent.

**Verifiability (commit–reveal):**

1. Before the cycle opens, server generates a 32-byte seed via `crypto.randomBytes`.
2. Server publishes `SHA-256(seed || cycleId)` — the **commitment** — visible to all roles and
   on a public verification page.
3. Assignment runs using a seeded PRNG (`seedrandom`) so the draw is deterministic given the seed.
4. After the cycle closes, the seed is **revealed**.
5. Anyone can re-run the published algorithm with the revealed seed and the published institute
   and inspector lists, and confirm the resulting assignment matches. A "Verify this cycle" button
   in the dashboard does this client-side.

If the commitment does not match the revealed seed, or the replay produces a different assignment,
the cycle is flagged as tampered.

**Algorithm.** Constrained randomised greedy with retry — *not* a solver.

```
function assign(cycle, institutes, inspectors, seed):
    rng = seededRNG(seed)
    pool = shuffle(institutes, rng)
    assignments = []
    for institute in pool:
        candidates = inspectors
            .filter(notPairedWithin(institute, N))      # C1
            .filter(notHomeDistrict(institute))          # C2
            .filter(underWorkloadCap)                    # C3
            .filter(travelFeasible(institute, date))     # C4
        if candidates is empty:
            relax C3 by one step, retry; if still empty, defer institute and log
        pick = candidates[floor(rng() * candidates.length)]
        assignments.push({institute, inspector: pick})
    return assignments
```

Deliberately **not** OR-Tools. The constraint set is satisfiable greedily, and keeping it in Node
means the team can debug it under time pressure.

**Acceptance criteria:**
- [ ] Given identical seed + inputs, the engine produces byte-identical assignment output
- [ ] Commitment hash is published before any assignment is visible to any user
- [ ] Public verification page replays a completed cycle and reports match/mismatch
- [ ] C1–C4 violations are zero across a 12-cycle simulation with 200 institutes / 30 inspectors
- [ ] Any manual reassignment writes an OverrideEvent and is visibly marked on the cycle

---

### F2 — Mobile Inspection Module (offline-first) `P1`

*Traces to 4.4. Direct port of the JhanSathi reporting flow.*

**Description.** React Native (Expo) app for PMU inspectors. Receives assignments, conducts
structured inspections offline, captures tamper-resistant evidence, syncs when connectivity
returns.

**Requirements:**

| ID | Requirement |
|---|---|
| F2.1 | Assignment inbox with due dates; institute details cached locally on assignment |
| F2.2 | Scheme-specific dynamic checklists (hostel / senior home / de-addiction differ) |
| F2.3 | **Camera-only evidence capture. Gallery selection disabled at the OS permission level.** |
| F2.4 | Full offline operation: SQLite write-through, outbox sync pattern, conflict-free |
| F2.5 | On-device computation of dHash + SHA-256 per evidence item **at capture time** |
| F2.6 | Location captured with `mocked` flag, accuracy radius, and a short GPS sample series |
| F2.7 | Device integrity signals collected: root/jailbreak, emulator, developer mode |
| F2.8 | Digital signature of the completed report before queueing |
| F2.9 | Multilingual UI (English + Hindi minimum; architecture supports more) |

**F2.3 is the highest-value-per-line-of-code feature in the entire product.** It blocks the most
common falsification route and demonstrates in ten seconds.

**Acceptance criteria:**
- [ ] Complete an inspection end-to-end in airplane mode, then sync successfully on reconnect
- [ ] Gallery import is impossible from within the app
- [ ] A report submitted with a fake-GPS app running is flagged before it reaches a reviewer

---

### F3 — Evidence Trust Score `P0`

*Traces to 4.6. Layered because single methods are defeatable.*

**Description.** Every submitted report receives a 0–100 trust score with itemised, human-readable
reasons. The score never auto-rejects; it prioritises human review.

**Signal layers:**

| Layer | Signal | Weight | Detection method |
|---|---|---|---|
| L1 | **Image reuse** | High | dHash Hamming distance ≤ 6 against the full historical corpus |
| L2 | **Byte-level duplicate** | High | SHA-256 exact match |
| L3 | **Mock location** | Critical | Android `isFromMockProvider` / Expo `mocked` flag |
| L4 | **Device integrity** | High | Root / emulator / developer-mode signature |
| L5 | **Travel feasibility** | Medium | Implied speed between consecutive submissions exceeds threshold |
| L6 | **Geofence deviation** | Medium | Capture point outside institute radius (default 150 m) |
| L7 | **Temporal anomaly** | Low | Submission outside plausible working window |
| L8 | **Capture-to-submit gap** | Low | Large delay between EXIF/device timestamp and capture event |
| L9 | **Tamper indicators** | Medium | Error Level Analysis; device-hash vs server-recomputed-hash mismatch |

**Storage note.** Cloudinary re-encodes and strips EXIF by default, destroying the metadata being
verified. Either upload evidence via the `raw` resource type, or store originals in Cloudflare R2 /
Backblaze B2 and use Cloudinary for derived thumbnails only. **The device-side hash (F2.5) makes
the system resilient regardless of storage choice** — server recomputes and compares.

**Acceptance criteria:**
- [ ] Resubmitted prior-quarter photograph is flagged with the matching historical report cited
- [ ] Every deduction shows a plain-language reason to the reviewing officer
- [ ] Trust score never blocks submission; it only routes and prioritises

---

### F4 — Override & Exemption Ledger `P0`

*Traces to 4.2. This is D1, our strongest differentiator, and no known system has it.*

**Description.** Every administrative action that weakens the monitoring system is a
first-class, immutable, attributed record — and is itself monitored.

**Logged event types:**

- Inspection cancelled
- Inspection deferred / rescheduled
- Assignment manually reassigned
- Institute granted exemption from a cycle
- Finding severity downgraded
- Finding closed without remedial action
- Trust-score flag dismissed
- Deadline extended

**Every event captures:** actor, role, timestamp, target entity, structured reason code, free-text
justification, and the previous value.

**Tamper-evidence.** The ledger is an append-only hash chain: each entry stores
`SHA-256(previousEntryHash || entryPayload)`. A periodic Merkle root is published. Any retroactive
edit breaks the chain and is detectable.

> **On blockchain.** A judge may ask. The answer: this hash chain provides tamper-evidence and
> full verifiability without a distributed ledger, at a fraction of the complexity. Have the answer
> ready; do not build a chain.

**Derived monitoring — the actual innovation:**

| Metric | Alert condition |
|---|---|
| Officer override rate | Exceeds 2 standard deviations above peer group |
| Institute exemption frequency | Same institute exempted in consecutive cycles |
| Downgrade concentration | One officer downgrades findings from one institute repeatedly |
| Post-assignment reassignment | Reassignment occurs after the institute could have learned the schedule |

**Acceptance criteria:**
- [ ] No code path modifies an assignment, finding or flag without writing a ledger entry
- [ ] Hash-chain verification endpoint detects an injected retroactive edit
- [ ] Officer override rates appear on the Division dashboard by default, not buried in a submenu

---

### F5 — Risk Model & Fraud Signature Classification `P0`

*Traces to 4.3 and 4.5. This is D3, the research contribution.*

**Description.** Two connected components:

**(a) Fraud signature classifier.** Categorises each institute's dominant anomaly pattern:

| Signature | Indicators | Recommended protocol |
|---|---|---|
| `GHOST_INTAKE` | Reported occupancy consistently above observed count | Occupancy verification + random beneficiary VC |
| `THRESHOLD_GAMING` | Metrics cluster just above funding cut-offs | Independent record back-check |
| `PREPARED_VISIT` | Clean on scheduled visits, poor on surprise visits | Increase surprise share |
| `EVIDENCE_REUSE` | Repeated pHash / metadata anomalies | Mandatory live VC capture |
| `INSPECTOR_CAPTURE` | One inspector's reports on one institute are anomalously clean | Force rotation + supervisory back-check |
| `CLEAN` | No dominant signature | Standard cycle |

`THRESHOLD_GAMING` is directly modelled on the Gujarat finding that auditors reported emissions
*just below* the standard — a computable clustering signature.

**(b) Risk scoring model.**

- **Training data:** outcomes of the **70% randomly-assigned** inspections only. This is the
  unbiased sample; using targeted-inspection outcomes would bake in selection bias.
- **Model:** logistic regression first. Interpretability matters more than raw accuracy here —
  the audit-analytics literature is explicit that unexplainable flags do not get acted on. Add
  gradient boosting only if time permits, and keep SHAP-style attribution.
- **Unsupervised support:** Isolation Forest over institute-level feature vectors for cold-start
  and for signatures with no labelled examples.
- **Output:** risk score + top three contributing features in plain language.
- **Use:** allocates the 30% targeted capacity in F1. **Never** contaminates the 70%.

**Acceptance criteria:**
- [ ] Model trains exclusively on randomly-assigned inspection outcomes; enforced in code
- [ ] Every risk score is accompanied by its top contributing factors in plain language
- [ ] Removing the random capacity share degrades model calibration in the simulation — demonstrating
      why the split exists

---

### F6 — Officials' Dashboard `P1`

*Traces to 4.2 (action gap), 4.4 (two-sided reporting), D6, D7.*

**Views by role.** Division, District, and Institute each see a scoped dashboard.

**Mandated panels:**

| Panel | Contents | Why |
|---|---|---|
| **Live cycle status** | Assignments issued / completed / overdue, current commitment hash | Core PS requirement |
| **Action queue** | Open findings by SLA state, with owner and days-open | Callen: action is what moves outcomes |
| **Unactioned flags** | Flags open beyond SLA, grouped by responsible officer | Closes G4 |
| **Override monitor** | Per-officer override rates vs peer baseline | D1 |
| **Monitoring velocity** | Inspections/week trend with decay alert | D6 — direct answer to the 104%→43.8% collapse |
| **Two-sided scorecard** | Detections **and** false-positive burden on clean institutes | D7 |
| **Risk map** | Leaflet map, institutes coloured by risk signature | Reuses existing JhanSathi mapping |
| **Verification** | Public commit–reveal replay tool | D2 |

**The "Unactioned flags" and "Override monitor" panels must be default-visible.** Burying them
would reproduce exactly the failure the research documents.

---

### F7 — CCTV Integration `P2` (demonstrate path only)

**Scope.** Prove the integration pipeline; do not build camera infrastructure.

- Simulated source: MediaMTX serving a looped video file as RTSP
- Transcode: `ffmpeg` RTSP → HLS
- Playback: `hls.js` in the dashboard
- Frames sampled at a configurable interval and passed to F9

**Acceptance:** one institute in the demo shows a live-appearing feed with an occupancy count
overlaid. State openly in the pitch that the camera is simulated and the pipeline is real.

---

### F8 — Random Video Conferencing `P2` (integrate, do not build)

**Scope.** Use the **Jitsi Meet SDK** — open source, self-hostable, has a React Native SDK.
"Video stays on Indian government infrastructure" is a meaningful sentence to say to this ministry.

- VC sessions scheduled by the same F1 randomisation engine (unannounced)
- Participant selection among staff and consenting beneficiaries is randomised
- Session metadata (time, participants by role, duration) logged; **recording off by default**

**Beneficiary participation is consented and opt-out at any moment.** See Section 13.

---

### F9 — Occupancy Analytics `P1` (privacy-constrained)

*Traces to 4.7 and D8.*

**Description.** Estimate how many people are present. Do **not** determine who they are.

- YOLOv8n via Ultralytics, `person` class only, on sampled frames
- Output: integer count + confidence. **No face crops, no embeddings, no identity, no tracking IDs
  persisted.**
- Compared against reported occupancy; sustained divergence feeds `GHOST_INTAKE` in F5
- Frames discarded after counting; only the count and timestamp are stored

**Explicitly prohibited:** facial recognition, face embedding storage, gait recognition, re-identification
across sessions.

---

### F10 — Escalation & Notifications `P1`

Direct reuse of the JhanSathi `node-cron` SLA escalation logic.

- Findings carry severity-based SLAs
- Breach escalates to the next level automatically
- **Escalation events are written to the F4 ledger** — so suppressing an escalation is itself visible
- Channels: in-app + email (SMS if time permits)

---

## 9. Technical architecture

### 9.1 Stack

| Layer | Choice | Justification |
|---|---|---|
| **Mobile** | React Native + **Expo (development build)** | Native camera/location/device APIs are non-negotiable for F2/F3. Expo Go cannot load the required native modules — use EAS to build the APK |
| **Dashboard** | React + Vite, Tailwind, Recharts, Leaflet | Direct reuse from JhanSathi. Not Next.js — no benefit here |
| **API** | Node.js + Express, JWT | Team's strongest ground |
| **Database** | MongoDB + Mongoose (geospatial indexes) | Postgres would suit the constraint and anomaly queries better, but migration cost exceeds the benefit in this timeframe. Use transactions for assignment writes |
| **Local store** | `expo-sqlite` | Offline outbox |
| **ML service** | Python + FastAPI, single container | **Two endpoints only:** occupancy count, risk score |
| **CV** | Ultralytics YOLOv8n | Person detection, count only |
| **ML** | scikit-learn (logistic regression, Isolation Forest) | Interpretable by default |
| **Image ops** | `sharp` + ~30-line dHash | Do not pull a heavy library for this |
| **Randomness** | `crypto.randomBytes` + `seedrandom` | Commit–reveal needs a reproducible PRNG |
| **Evidence storage** | Cloudflare R2 or Backblaze B2 (originals), Cloudinary (thumbnails) | Preserves bytes and metadata |
| **Video** | Jitsi Meet SDK | Self-hostable, avoids building signalling |
| **Streaming** | MediaMTX + ffmpeg + hls.js | Simulated source, real pipeline |

**Discipline rule:** the Python service does exactly two jobs. Every temptation to move logic into
it should be resisted — split brains under deadline pressure cause integration failures.

### 9.2 Architecture diagram

```
┌──────────────────┐         ┌──────────────────┐        ┌──────────────────┐
│  Inspector App   │         │  Web Dashboard   │        │  Institute Portal│
│  React Native    │         │  React + Vite    │        │  React + Vite    │
│  SQLite outbox   │         │                  │        │                  │
└────────┬─────────┘         └────────┬─────────┘        └────────┬─────────┘
         │  sync (batched)            │  REST                     │
         └─────────────┬──────────────┴───────────────────────────┘
                       ▼
         ┌─────────────────────────────────┐
         │   Node.js / Express API          │
         │  ┌────────────────────────────┐  │
         │  │ Assignment Engine (F1)     │  │──> CycleCommitment (commit–reveal)
         │  │ Evidence Trust Scorer (F3) │  │
         │  │ Override Ledger (F4)       │  │──> hash chain + Merkle root
         │  │ Escalation cron (F10)      │  │
         │  └────────────────────────────┘  │
         └──────┬───────────────┬───────────┘
                │               │
        ┌───────▼──────┐  ┌─────▼────────────────┐
        │  MongoDB     │  │  FastAPI (Python)    │
        │  + geo index │  │  /occupancy  (YOLO)  │
        └──────────────┘  │  /risk (sklearn)     │
                          └──────────┬───────────┘
        ┌──────────────┐             │
        │  R2 / B2     │◀────────────┘
        │  evidence    │
        └──────────────┘
                          ┌──────────────────────────────┐
                          │ MediaMTX ─ ffmpeg ─ HLS      │  (simulated CCTV)
                          │ Jitsi Meet SDK               │  (VC)
                          └──────────────────────────────┘
```

### 9.3 Key collections (MongoDB)

```js
Institute       { _id, name, schemeType, ngoDarpanId, district, state,
                  location: {type:"Point", coordinates:[lng,lat]}, geofenceRadiusM,
                  reportedCapacity, reportedOccupancy, riskSignature, riskScore }

Inspector       { _id, name, homeDistrict, activeCycles, workloadCount, deviceId }

InspectionCycle { _id, periodStart, periodEnd, commitmentHash, seedRevealed,
                  seed, randomShare, targetedShare, status }

Assignment      { _id, cycleId, instituteId, inspectorId, allocationType:"RANDOM"|"TARGETED",
                  dueDate, status, supersededBy }

InspectionReport{ _id, assignmentId, submittedAt, deviceSignals, answers[],
                  trustScore, trustFactors[], signature }

EvidenceItem    { _id, reportId, storageKey, dHash, sha256, capturedAt,
                  location:{coordinates, accuracyM, mocked}, flags[] }

Finding         { _id, reportId, severity, category, slaDueAt, status, ownerId }

OverrideEvent   { _id, actorId, actorRole, targetType, targetId, eventType,
                  reasonCode, justification, previousValue, prevHash, entryHash, at }

OccupancySnapshot { _id, instituteId, source:"CCTV"|"VC", count, confidence, at }
```

**Indexes:** `EvidenceItem.dHash` (duplicate lookup), `Institute.location` (2dsphere),
`OverrideEvent.actorId + at`, `Assignment.cycleId + instituteId`.

---

## 10. API surface (representative)

```
POST   /api/cycles                        create cycle, publish commitment
POST   /api/cycles/:id/assign             run assignment (idempotent given seed)
POST   /api/cycles/:id/reveal             reveal seed, close cycle
GET    /api/cycles/:id/verify             public: replay draw, return match result

GET    /api/assignments/mine              inspector inbox
POST   /api/reports                       submit report (batch-capable for sync)
POST   /api/reports/:id/evidence          upload evidence + device-computed hashes
GET    /api/reports/:id/trust             trust score with itemised factors

POST   /api/overrides                     any weakening action; writes ledger entry
GET    /api/overrides/verify-chain        hash-chain integrity check
GET    /api/overrides/officer-rates       per-officer override rates vs peers

GET    /api/dashboard/velocity            monitoring decay trend
GET    /api/dashboard/scorecard           detections + false-positive burden
GET    /api/institutes/:id/risk           score, signature, contributing factors

POST   /api/vc/sessions                   schedule randomised VC
GET    /api/stream/:instituteId/index.m3u8  HLS playlist
```

---

## 11. Privacy, legal and ethical constraints

**These are hard requirements. Violating them is a correctness bug, not a policy preference.**

| # | Constraint | Reason |
|---|---|---|
| P1 | **No facial recognition anywhere.** Occupancy counting only | Institutions house minors and people in recovery; DPDP Act exposure; Section 4.7 shows counting answers the actual question |
| P2 | Frames discarded after counting; only integer counts persisted | Data minimisation |
| P3 | Beneficiary VC participation is consented and opt-out at any moment | Power asymmetry — residents cannot meaningfully refuse an institution's instruction |
| P4 | VC recording off by default; enabling requires a logged OverrideEvent | Prevents silent surveillance creep |
| P5 | Evidence photographs must not centre on identifiable residents where the finding concerns facilities | Proportionality |
| P6 | Role-scoped data access; institutes see only their own record | Standard, but must be enforced server-side |
| P7 | Grievance channel for institutes to contest a flag | G5 — the system must be contestable |

**Present one slide on this.** Under the DPDP Act, processing children's personal data carries
heightened obligations, and a judge from this ministry is plausibly aware of them. Most competing
teams will demo face recognition. Choosing not to, and explaining why, is a scoring advantage.

---

## 12. Success metrics

| Metric | Definition | Target (simulation) |
|---|---|---|
| Assignment verifiability | % of cycles independently replayable | 100% |
| Constraint violations | C1–C4 breaches per cycle | 0 |
| Evidence reuse detection | Recall on injected duplicate images | > 95% |
| Spoof detection | Recall on mock-location submissions | > 90% |
| Override visibility | % of weakening actions with ledger entry | 100% |
| Action closure | % of flags actioned within SLA | tracked, not targeted |
| **False-positive burden** | Clean institutes flagged per true detection | tracked and **reported** |
| Monitoring velocity | Inspections/week trend slope | alert on sustained decline |
| Offline resilience | Inspections completable with zero connectivity | 100% |

**We report the false-positive metric even when it is unflattering.** The NMMS literature is the
reason. A judge who knows that literature will notice.

---

## 13. Build plan

**Timeline context:** today is 4 September 2026. Internal hackathon is in September. PS deadline is
20 or 30 September (verify). Grand finale is December 2026.

### Phase 1 — Internal round (now → internal hackathon)

Objective: a working demo that proves the differentiators, not feature coverage.

| Order | Deliverable | Owner |
|---|---|---|
| 1 | Assignment engine + commit–reveal + verification page | Backend lead |
| 2 | Mobile inspection module with offline sync, camera-only capture | Mobile lead |
| 3 | Evidence trust score (L1–L6 minimum) | Backend + mobile |
| 4 | Override ledger with hash chain | Backend lead |
| 5 | Dashboard: cycle status, action queue, override monitor, verification | Frontend lead |
| 6 | Seed data: 200 simulated institutes, 30 inspectors, 12 historical cycles | Data lead |
| 7 | Pitch deck + demo script | Presenter |

**Seed data matters more than teams expect.** Fraud-signature detection and the risk model need
history to demonstrate anything. Generate 12 cycles of synthetic data with deliberately injected
fraud patterns (one threshold-gamer, one evidence-reuser, one captured inspector) so the demo has
something real to find.

### Phase 2 — Pre-finale (October–November)

- Risk model trained on the random sample; SHAP-style explanations
- Occupancy counting via YOLOv8n
- Fraud signature classifier
- Two-sided scorecard, monitoring velocity panel
- CCTV pipeline (MediaMTX → HLS)
- Jitsi VC integration

### Phase 3 — Finale (December, 36 hours)

Polish, live demo hardening, offline demo rehearsal, judge Q&A preparation.

### Team allocation (6 members, SIH-mandated)

| Role | Responsibility |
|---|---|
| Backend lead | Assignment engine, override ledger, API |
| Mobile lead | React Native app, offline sync, device signals |
| Frontend lead | Dashboard, verification page, maps |
| ML/CV | FastAPI service, YOLO, risk model |
| Data/DevOps | Seed data, deployment, CCTV pipeline, Jitsi |
| Research/Presenter | Domain research, deck, demo script, judge Q&A |

---

## 14. Demo script

Sequence matters. Lead with the differentiator, not the login screen.

1. **Frame the problem in 30 seconds** using the three fraud modes. Not the feature list.
2. **Publish the commitment.** Show the hash appearing before the draw. State that no official can
   now rig the schedule undetectably.
3. **Run the assignment.** Show constraints satisfied. Then hit "Verify" and replay it live.
4. **Conduct an inspection on a phone in airplane mode.** Try to open the gallery — it isn't there.
   Reconnect; watch it sync.
5. **Submit a recycled photo.** Watch the trust score drop and cite the earlier report it came from.
6. **Turn on a fake-GPS app and resubmit.** Watch it get flagged.
7. **Have an "official" cancel an inspection.** Show the ledger entry appearing and the officer's
   override rate moving on the dashboard. *This is the moment that separates you.*
8. **Show the unactioned-flags panel** and say the Punjab number out loud: 104% at six months,
   43.8% at twelve, and attendance only moved when officials acted.
9. **Show occupancy counting.** State explicitly: we count, we do not identify, and here is why.
10. **Close on the two-sided scorecard.** We report what we cost honest institutes too.

---

## 15. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Expo native modules fail on judges' device | Medium | Build APK early via EAS; test on 3+ Android versions; carry a spare device |
| Team overreaches on CCTV/VC and loses the core | **High** | Timebox both to 2 days combined; they are P2 for a reason |
| ML component underdelivers | Medium | Logistic regression baseline first; unsupervised fallback; the product works without it |
| Cloudinary strips metadata, breaking F3 | Medium | Device-side hashing (F2.5) makes this survivable; switch to R2 if needed |
| Live demo network failure | Medium | Offline mode is a *feature* — rehearse demoing it deliberately |
| Judge asks "why not blockchain" | High | Hash-chain answer prepared (F4) |
| Judge asks "e-Anudaan already does this" | **High** | Acknowledge the 2020 CCTV order up front; position as operationalisation, not invention |
| PS ID/theme wrong in submission | Low but fatal | Verify on sih.gov.in before SPOC submits |

---

## 16. Open questions

1. Does the official PS description specify integration requirements with e-Anudaan or PFMS?
2. What is the actual PMU inspector-to-institute ratio? Affects realistic workload constraints.
3. Are institute-level inspection outcome datasets available publicly, or is simulation required
   throughout? (Assume simulation.)
4. Confirm whether the theme is Smart Automation — mirrors disagree.
5. Confirm submission deadline: 20 or 30 September 2026.

---

## 17. What we are claiming

We are not claiming this eliminates fraud. The research is unambiguous that it will not.

What we claim, with a citation behind every word: our design closes four specific failure points
that caused earlier systems to stop working —

1. **the administrative override** that killed the Rajasthan nurse programme,
2. **the unprovable draw** that lets institutions allege targeting and officials rig quietly,
3. **the unverified photograph** that NMMS collects and never checks,
4. **the report nobody acts on**, which is the difference between Punjab's 43.8% and its 75%.

That is a smaller claim than most teams will make, and a far more defensible one.

---

## Appendix — Key references

Full citations in the companion research report (`SIH26095_Research_Report.pdf`).

- Duflo, Greenstone, Pande & Ryan (2013), *QJE* 128(4) — random auditor assignment
- Olken (2007), *JPE* 115(2) — audit probability and corruption
- Abbink (2004), *EJPE* 20(4) — staff rotation breaks collusion
- Duflo, Hanna & Ryan (2012), *AER* 102(4) — camera monitoring worked
- Banerjee, Duflo & Glennerster (2008), *JEEA* 6(2-3) — the same idea defeated by exempt days
- Callen, Gulzar, Hasanain, Khan & Rezaee (2020), *JDE* 146 — Monitoring the Monitors
- Muralidharan, Niehaus & Sukhtankar (2016, 2020) — fraud mode determines tool efficacy
- Medina-Hernández, Kertész & Fazekas (2025) — the missing-negatives problem
- Prokos et al. (2021), USENIX Security — perceptual hashing is attackable
- Chan, Liang & Vasconcelos (2008), *CVPR* — counting without identifying
- CAG Report No. 10 of 2023 (NSAP); Report No. 36 of 2025 (scholarships)
- Parliamentary Standing Committee on Rural Development (2023) — NMMS review
