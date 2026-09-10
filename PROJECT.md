# Ieumi (이음이) — Purpose, Scope & Direction

> **Read this first.** The code currently in this repository is a *working prototype for a single
> center*. What we are actually building is a **voice-service SaaS supplied to thousands of welfare
> centers nationwide**.
> This document explains **what we build, why, and how far** (direction). For how to run it, see
> [README.md](README.md).

---

## 0. One-line definition

**A voice service where seniors "just speak", supplied as SaaS to welfare centers nationwide.**

Seniors get help by talking instead of navigating complicated screens; welfare-center staff shed
routine workload; we operate the system and earn data and operating fees.

---

## 1. Purpose — why we are building this

Three goals interlock.

1. **Solve digital exclusion for seniors.** A senior who cannot handle apps, menus or buttons picks
   up the handset, simply speaks, and receives job / health / welfare information by voice and by SMS.
2. **Reduce the workload of welfare-center staff.** Ieumi absorbs repetitive intake and guidance so
   staff can focus on core work. The heavier a center's workload, the stronger its motivation to adopt.
3. **A sustainable operation (the business).** We supply the service to centers nationwide, collect
   data, and receive operating fees. **Keeping the complex administration with us (master) while
   centers only do the easy parts is the core of the revenue model.**

---

## 2. Scope — what, for whom, where

| Axis | Scope |
|------|-------|
| Target centers | Seocho, Gangseo … thousands of centers nationwide (**multi-tenant**) |
| Three user tiers | ① Seniors (voice) ② Center staff (dashboard) ③ Master = us (whole operation) |
| Domains | Jobs (complete today) → health & medical → welfare → daily living |
| Channel | **Mobile first** (for testing) → then kiosk and mobile in parallel |
| Language / tone | Korean, tuned for seniors: large type, slow warm voice, plain words, confirmation steps |

---

## 3. Product direction — the seven principles that form the product's skeleton

> These are the criteria for every development decision.

### 3-1. Multi-tenant SaaS

One system serves thousands of welfare centers at the same time. Data must be isolated per center,
and we need a scheme that identifies each center. **This is the decisive reason the database is the
top priority** (§6-P0).

### 3-2. Organic operation of common + individual content (content inheritance)

Information is a mix of **nationwide-common** (managed by master) and **center-specific** (adjusted
by each center). A center does not rebuild everything — it **inherits the common set and overrides**
it to fit its own area. *(The current "Service Priority" tool is the first seed of this direction.)*

### 3-3. Three permission tiers = the revenue structure

| Tier | What they do | Meaning |
|------|--------------|---------|
| **Master** (us) | Complex configuration, common content, data collection, operations | The basis for charging operating fees |
| **Center admin** | Their own center's services, Ieumi character settings | Autonomous operation |
| **Staff** | Only the easy things — entering and editing the senior roster | Minimal barrier to entry |

Complex administration stays with master, staff work stays easy — **this structure is the foundation
of both data collection and operating revenue.**

### 3-4. Staff self-service (entry and management must be easy)

Entering, editing and managing the existing senior roster must be genuinely comfortable (paste from
Excel, instant save, and so on). **If staff find it difficult, the product will not be adopted.**

### 3-5. Per-center Ieumi customization

Every center has its own Ieumi — **name, voice and speaking tone** updated directly and easily from
the staff dashboard. Thousands of staff members must each be able to change it comfortably.

### 3-6. Real-time response speed (so the conversation never stalls)

In a voice conversation with a senior, even a 1–2 second delay makes the exchange awkward. Ways to
make responses fast, **in order of impact**:

1. **Response streaming (LLM)** — do not wait for the whole answer to be generated; start processing
   as soon as tokens arrive. This cuts perceived latency the most.
2. **TTS streaming / parallelization** — do not wait for the full sentence; split by sentence or
   phrase and play back the earliest-generated part immediately. Overlapping text generation with
   speech synthesis shortens time-to-first-audio (TTFT).
3. **Pick a fast model that fits the conversation** — route everyday conversation to a fast
   lightweight model (Haiku class) and branch to a higher model only where complex judgement is
   needed. Faster per turn and cheaper. *(Ieumi currently uses a Sonnet-class model; simple
   conversation can safely drop to a faster, cheaper lightweight model.)*
4. **Prompt caching** — the system prompt and job list are identical on every request; cache them to
   cut input-processing time and cost.
5. **Prompt slimming** — keep the system prompt and context only as large as necessary. Shorter input
   means a faster first response.
6. **Minimize STT latency** — detect end-of-speech (endpointing) quickly, use streaming STT.
7. **Fast Mode (an option)** — some models can run at up to 2.5× output speed at the same quality
   (premium cost). The option for when speed must rise while quality is held.

> **In short: streaming + TTS parallelization + a fast model that fits the conversation** are the
> three things that decide response speed.

### 3-7. Mobile first → kiosk expansion

Because it is browser-based, building it as a responsive web app means the same code runs on both
mobile and kiosk. Validate on mobile first, then run kiosk and mobile in parallel. *(The
lowest-risk path.)*

---

## 4. Current state — "single-center prototype" (proof-of-concept stage)

> **Implementation note (2026-09-07):** §6-P0 has since been built — the sections below
> describe the state at the time this brief was written. Multi-tenancy, a Postgres
> database and the three permission tiers are now in place, and both dashboards and the
> kiosk run against the server rather than `localStorage`. See [README.md](README.md) for
> how to run it. The rest of §4 is kept as written, as the record of the starting point.

The code in this repository assumes **one center, Seocho**, and is a working demo.

- ✅ **The core flow is proven:** voice conversation → job guidance → SMS send, automatic member-name
  confirmation, and so on.
- ⚠️ **Not there yet:** multi-tenancy, a database, three permission tiers, per-center customization,
  streaming responses.
- Data is stored temporarily in the browser's `localStorage` → it cannot be shared across multiple
  centers or multiple devices.

In other words: **the concept is proven; turning it into a SaaS product is the job ahead.**

---

## 5. What has been built so far ✅

**Kiosk app**

- ✅ Prototype (`이음이-키오스크-프로토타입.html`) — UI demo with no backend
- ✅ LIVE app (`이음이-키오스크-LIVE.html`) — the whole real conversation:
  Claude conversation / intent detection / job selection · CLOVA voice (TTS) · browser speech
  recognition (STT) with text fallback · keypad → number confirmation → name lookup against the
  member roster · "message sent" card (real sending once keys are configured) · "other similar jobs"
  follow-up suggestion · no-response detection · emoji stripped before speech

**Backend** (`ieumi-server/server.js`, zero-dependency Node)

- ✅ `/chat` (Claude), `/tts` (CLOVA), `/stt` (CLOVA, optional), `/sms` (Aligo / SENS), `/health`
- ✅ Static server — serving of `.env`, source and hidden files is blocked (security)
- ✅ Claude conversation history normalized / all secrets loaded from `.env`
- ✅ **`/chat` returns structured JSON: `reply · category · summary · offerSms · pick`**
  *(the key integration point)*

**Dashboards**

- ✅ Admin dashboard — member roster, service categories, service-priority planning tool, statistics
- ✅ Staff dashboard — reviewing incoming requests

**Data**

- ⚠️ *This line originally read "data.go.kr senior-jobs API integrated". At the time it was written
  no such call existed anywhere in the repository — `DATAGO_KEY` was declared and read by nothing,
  and the kiosk passed two hardcoded Seocho listings to Claude. **It is integrated now**; see
  [§11](#11-job-data--datagokr) for what the source actually provides, which is less than this line
  implied.*

---

## 6. What to build next (roadmap — re-sorted around SaaS)

### 🟥 P0 — without these there is no SaaS ✅ **done**

- ✅ **Multi-tenant database** — moved from `localStorage` to Postgres. Per-center data isolation;
  the member roster, priorities, settings and request history are on the server and shared across
  devices. Content inheritance is live: nationwide-common services are owned by master and inherited
  by every center, which overlays its own selection, ordering and overrides. (§3-1, §3-2)
- ✅ **Three permission tiers + authentication** — master / center admin / staff, with server-side
  sessions and scrypt password hashing. The tenant boundary is enforced in one place
  (`auth.resolveCenter`) and covered by tests. (§3-3)

*Also brought forward from P1, because multi-tenancy required it:* the assistant's name, voice, tone,
greeting and the SMS sender line are per center (§3-5), and a kiosk identifies its own center by a
token in its URL.

### 🟧 P1 — the conditions for the product becoming genuinely usable

- **Per-center Ieumi customization** — name, voice, tone and so on configured from the staff
  dashboard, and reflected by the kiosk. (§3-5)
- ✅ **Response-speed improvements** — done. Time to the first spoken sound went from about
  **7 seconds to about 2.5**, measured end to end on the real prompt. Three changes, in the order
  §3-6 ranks them: the reply is **streamed** (which required moving the spoken text out of the JSON
  envelope — a reply wrapped in an object cannot be spoken until the object closes); **speech is
  synthesised sentence by sentence**, overlapping, so only the first short sentence is ever waited
  on; and the default model moved to `claude-sonnet-5` — newer, cheaper than the previous default
  ($2/$10 against $3/$15), **with thinking switched off**, which alone cut the first token from
  4.0s to 1.2s. Prompt caching was measured and deliberately skipped: see §9.
- ✅ **Wire the priority tool into the kiosk** — done. The services a centre switches on, in the order
  it chose, now reach Ieumi's system prompt: asked what it can help with, Ieumi names the top two;
  asked about one of them, it recognises it and passes the request to staff. Because only jobs have
  live data behind them, the prompt forbids inventing details for the rest. Each call also records
  *which* of the ~59 services it was about, so a centre can see which of its selections are actually
  used (§1-3).
- ✅ **Stronger staff input UX** — done. A 담당자 can now **correct a name or a number in place**
  by clicking it (previously impossible — adding upserts by phone, so a mistyped digit meant delete
  and retype). Adding one person runs on the keyboard alone: name → Tab → number → Enter. A paste
  from Excel is **previewed before it commits** — how many are new, how many are updates, and which
  lines will be skipped and why — instead of a count in an alert afterwards. Long rosters have a
  search, and the table is readable on a phone.

### 🟨 P2 — expansion and operations

- **Domain expansion** — beyond jobs to health & medical (Phase 1) → welfare → daily living. A data
  source and response logic per category.
- **Responsive (mobile ↔ kiosk)** — one codebase supporting both. (§3-7)
- **Deployment** — deploy backend and app to the cloud; manage secrets.
- **Request-handling loop** — kiosk creates a request → stored → staff handles it → status returned
  (server-side).
- **Real SMS sending / backend STT** — operational accounts and policy; backend STT as an option for
  microphone audio.

---

## 7. System structure (current)

```
┌────────────────────────┐        ┌───────────────────────┐      External services
│  Browser (app)         │        │  Node backend         │      ─────────────────
│  · microphone / voice  │  HTTP  │  server.js            │  ──► Claude       — understanding & response (JSON)
│  · character + bubbles │ ─────► │  /chat /tts /stt /sms │  ──► CLOVA        — voice (TTS / STT)
│  · SMS card / keypad   │ ◄───── │  + static server      │  ──► SENS / Aligo — SMS
└────────────────────────┘        └───────────────────────┘  ──► data.go.kr   — job data
```

The front end stays thin (input/output and screen); the back end orchestrates the external APIs.
**When we convert to SaaS, the database, authentication and tenancy layers are added here.**

---

## 8. File structure

```
ieumi-kiosk/
├── PROJECT.md                       # ← this document (purpose, scope, direction)
├── README.md                        # running it + configuration
├── 이음이-키오스크-프로토타입.html      # prototype (static)          [Ieumi kiosk — prototype]
├── 이음이-키오스크-LIVE.html          # LIVE app (needs the backend) [Ieumi kiosk — LIVE]
├── 서초-이음이-관리자-대시보드.html    # admin dashboard              [Seocho Ieumi — admin dashboard]
├── 서초-이음이-담당자-대시보드.html    # staff dashboard              [Seocho Ieumi — staff dashboard]
├── assets/prototype/                # character / phone / background images
└── ieumi-server/
    ├── server.js                    # zero-dependency Node backend
    └── .env.example                 # copy to .env and fill in the keys
```

> The file names are in Korean and the browser percent-encodes them automatically. If a file is
> renamed, update the references in the HTML files and in `server.js` as well.

---

## 9. Data, storage and cost (read before scaling)

- **Member roster and priorities:** currently `localStorage` (browser-only) → must move to a database
  (§6-P0).
- **Jobs:** live from data.go.kr. The two Seocho entries used for the demo are hardcoded in the LIVE
  app's `JOBS` (the live API returned zero Seocho results at build time).
- The member phone numbers in the repository are **dummies** (`01012345678`) — the repository is public.

| Service | Used for | Cost | Care when testing |
|---------|----------|------|-------------------|
| Claude | conversation | per token (cheap per call) | use your own key and set a spend limit |
| CLOVA | voice | small amount after the free tier | almost none |
| SENS / Aligo | SMS | **real money per message** | **leave the key blank while testing** (replaced by the on-screen card) |
| data.go.kr | jobs | free | daily call limit |

> `.env` is gitignored. **Never commit real keys.**

### On prompt caching (§3-6 ④)

Measured, then deliberately not implemented. The system prompt is **1,554 tokens**. The minimum
cacheable prefix is model-dependent, and for Haiku 4.5 it is **4,096 tokens** — well above what this
prompt reaches, so a cache marker would silently do nothing (no error, just no cache). On
`claude-sonnet-5` the minimum is 1,024, so caching *would* engage there; it is worth revisiting once
the prompt grows — a centre enabling many more of its 59 services would push it past every
threshold. Verify with `usage.cache_read_input_tokens` rather than assuming.

Note also that the persona (name, centre, tone) currently sits at the **top** of the prompt, so no
two centres share a prefix. If caching is turned on, move the invariant rules first and the
per-centre persona last, or every centre pays for its own cache entry.

---

## 10. Service-priority planning tool (recently added)

Admin dashboard → ⭐ **Service Priority** tab. For each center, roughly **59 services** across four
categories (health · welfare · daily living · jobs) can be selected and ordered. Today it is a
planning tool (a record of intent) and **is not yet wired into the kiosk** (§6-P1). It is the first
implementation of §3-2 (common + individual inheritance) and becomes the foundation of the
multi-tenant content structure to come.

---

## 11. Job data — data.go.kr

The kiosk's job listings come from the 한국노인인력개발원 노인일자리 API (`SenuriService`), synced into
Postgres by `ieumi-server/jobs.js`. Run `npm run sync-jobs`, ideally daily on a schedule.

**Why it is synced rather than called live.** Three properties of the API decide this, all measured:

- **There is no region filter.** `schSido`, `schSigungu` and `workPlc` are all accepted and all
  ignored — every query returns the same national list (761,748 rows). The only way to find a
  centre's postings is to hold them and filter locally.
- **A single call takes 9–30 seconds.** Nothing that slow can sit in front of a waiting senior (§3-6).
- The key has a daily call limit.

**What the source provides — and what it does not.**

| Available | Not available |
|---|---|
| Job title, organisation, region | **Pay — no field exists** |
| Application deadline and dates, how to apply (방문/우편/…) | **Working hours — no field exists** |
| From the per-job detail call: address, contact name, **contact phone**, minimum age, headcount | |

This matters for expectations. The original demo script had Ieumi saying *"월급 150만원"* and
*"시급 만 삼백이십 원"* — **those numbers cannot come from this source.** The prompt now states the gap
outright, so Ieumi answers a question about pay with "I can't know that; the contact number will
tell you" rather than inventing a figure. If wages are required for the pilot, they need a different
source or manual entry by the centre.

**Two further realities of the data:**

- **Seocho really is nearly empty.** The first sync found exactly **1** open posting in 서초구, and
  none in 강서구. Widening to the whole of 서울 is the normal case, not an edge case — and Ieumi
  announces it ("서초에는 지금 열린 자리가 없어…") rather than passing another district off as local.
- **The region is blank on a large share of postings** (200 of 354 in the first sync). The detail
  call's address recovers it, so each sync backfills a bounded number; coverage grows over
  successive runs rather than all at once.
- The feed is newest-first and reaches back years — page 50 was already a year old — so a sync only
  walks the recent rows and keeps what is still open.

---

## Starting point (for developers)

1. **Run the prototype** (just open the HTML) → feel the UX in 30 seconds
2. **Run the backend and the LIVE app** ([README.md](README.md)) → see the real flow
3. **Understand `/chat` in `server.js`** and the JSON structure Claude returns
4. Using §3 as the standard, **start with §6-P0 (multi-tenant DB + permissions)** — it unblocks the
   most.

---

*English translation of the client's Korean direction brief (이음이 — 서비스 목적·범위·방향성).*
