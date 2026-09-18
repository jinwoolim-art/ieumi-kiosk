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
  source and response logic per category. *(Partly done: every service now carries the organisation
  that runs it and a link, so Ieumi can name a real body and text the address — see §10. Live data
  behind the other categories is still the open part.)*
- **Responsive (mobile ↔ kiosk)** — one codebase supporting both. (§3-7)
- **Deployment** — deploy backend and app to the cloud; manage secrets.
- **Request-handling loop** — kiosk creates a request → stored → staff handles it → status returned
  (server-side).
- **Real SMS sending / backend STT** — operational accounts and policy; backend STT as an option for
  microphone audio.

---

## 6a. Answering for the region the senior asked about

> The client's stated goal for the next test: *"이음이가 사용자가 원하는 지역의 답변을 정확히 하는지"* —
> whether Ieumi answers accurately for the region the **user** wants.

Until now the job search used one region only: the centre's own. A senior standing in a Seocho kiosk
asking about 강남 — where a son lives, where the bus goes — was answered with Seocho listings and no
acknowledgement that they had asked for somewhere else.

**The district a senior names now wins over the centre's.** Measured end to end against live data:
*"제가 강남구에 사는데, 강남구 쪽에 일자리 있을까요?"* returns five real 강남구 postings, and Ieumi
names the district back.

Three decisions are worth knowing:

- **The region is detected here, not by the model.** The reply is streamed, so anything the model
  reports arrives *after* the answer it was supposed to shape — a region in the trailing JSON could
  only help the turn after the one that needed it. A second model call to classify first would cost
  about a second, which §3-6 says is the whole difference between a conversation and an awkward pause.
- **The vocabulary is built from the postings themselves**, not from a list of Korean administrative
  divisions — 161 terms on the current data. A district only becomes recognisable when there is
  something to offer for it, so a match can never promise 강남구 and then produce nothing. Each
  district is registered under its full name and its bare stem, because a senior says "강남" at least
  as often as "강남구", and the longest match wins.
- **Only what the senior said counts.** Ieumi mentioning a district in its own reply must not
  redirect the next search. The scan runs newest-turn-first, so a senior may change their mind.

When the named district is empty the prompt says so rather than quietly substituting another — that
distinction (`asked` / `asked-wider` / `asked-none`) is what stops a senior being sent to the wrong
side of the city.

## 6b. Answering from general knowledge, within a boundary

> The client, in their first message: *"답변이 리스트를 우선적으로 답변을하고 리스트에 없는경우
> 범용적인 지식이 답변이 되어야합니다"* — answer from the list first; where the list is silent,
> general knowledge should answer.

The list still comes first. Beyond it, Ieumi may now answer from ordinary general knowledge — but
only ever about **how something works**, never about **a particular fact of here and now**:

| Allowed | Never, even as "general knowledge" |
|---|---|
| when medicine is usually taken, habits that help a cold, how to spot a voice-phishing call | phone numbers, addresses, organisation names not in the list |
| | amounts, benefit sums, wages, fees |
| | dates, application periods, opening hours |
| | whether *this* senior qualifies for something |

Those are exactly the things a senior would act on, and exactly what this data cannot vouch for.
Health talk carries an extra rule: never diagnose, never suggest changing medication, and close with
*"정확한 건 의사 선생님이나 보건소에 여쭤보세요"*.

Verified against the live model: a question about a cold gets a short answer and a nudge to see a
doctor; *"동사무소 전화번호 좀 알려줘요"* and *"기초연금은 한 달에 얼마나 나와요?"* are both declined and
passed to staff.

**It is a switch, not a constant** (`center_settings.general_answers`, default on — 🎙️ 이음이 설정).
The same client marks 건강·의료 as awaiting legal review; if that review comes back badly, turning
this off has to be a checkbox a centre can reach, not a redeploy.

## 6bb. Fixed after Play4's 2026-09-14 test

- ✅ **Ieumi appeared to talk to itself after every answer.** Each turn ended by
  reopening the microphone. In any room with noise the microphone heard that noise as a new
  question, which was answered, which reopened the microphone — a loop, and it ran even when the
  senior had typed rather than spoken. The model was replying exactly once; the loop was entirely
  in the browser. **The microphone now opens only while the senior presses 🎤 말씀하기.** A loop
  cannot form because nothing opens it automatically. Empty results, and results the browser
  itself reports low confidence in, are also discarded — but *not* short ones: "네" and "예" are
  one-character answers in Korean, so a character-count floor would throw away real replies.
- ✅ **The SMS number pad could never be opened.** `smsBtn.style.display` was set to `'none'` in
  three places and never set back, so the 📩 문자 받기 button did not exist on screen — while the
  status line actively told the senior to press it. It also shared a position with the status
  pill. Both buttons now sit in their own row, visible for the whole call.
- ✅ **A text sent before the senior chose a posting lost the contact number.** With exactly one
  posting on the table, that posting is now what gets texted, contact number included. With two or
  more, nothing is assumed — picking one arbitrarily is the mistake §6c describes.

> **Still open from that test: speech recognition quality.** The tester gave up and typed. This is
> the browser's Web Speech API and the risk TESTING.md §5 has flagged from the start; it has now
> been hit on a desk, before any elderly speaker or noisy hallway. The server already has a CLOVA
> `/stt` endpoint wired as the alternative, and choosing it changes the latency budget (§3-6).

## 6c. Fixed since the client's first test

- ✅ **A senior could be texted a job that does not exist.** The server built the prompt from real
  postings, so the model's `pick` was an index into *that* list — but the browser resolved it against
  a hardcoded two-item demo array carrying `월급 150만원` and `시급 만 삼백이십 원`, the invented
  figures §11 exists to prevent. A senior who asked about a real posting was shown, and would have
  been texted, a different fictional one. The server resolves `pick` now, exactly as it already did
  for `service`, and the demo array is gone.
- ✅ **A text message could only ever be a job posting.** After a welfare or health conversation
  `doSend()` fell back to the same fake posting, and the server's own wording said
  *"information about the job Ieumi told you about"* regardless of topic. `/sms` now takes a service
  code and a summary too, and builds the message from the centre's catalogue — the organisation and
  the link. This is the client's *"summarise the answer and send it to mobile on request"*.
- ✅ **The browser dictated the body of a real text message.** `/sms` took the whole posting object
  from the page and formatted it. With SMS keys configured that is an open relay pointed at seniors'
  phones. It takes identifiers now — a posting id, a service code — and reads the content back from
  the database; an id that is not in the table produces no message at all. The one remaining
  free-text field (the summary) is length-capped.
- ✅ **The "send me another job" follow-up was offered after every call**, including calls with no
  jobs in them, and answering yes sent the hardcoded posting. It is offered only when the centre
  actually has another posting to send.

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
    ├── sources.js                   # reads the linked pages, sub-pages and posters (§10a)
    ├── retrieval.js                 # picks the parts of those pages a question needs (§10a)
    ├── korea-relay.js               # fetches from inside Korea, for geo-blocked hosts
    ├── render.js                    # drives Chrome for JavaScript-built pages
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

### On prompt caching (§3-6 ④) — implemented 2026-09-15

This section previously said "measured, then deliberately not implemented", at **1,554 tokens** with
a handful of services switched on. Switching the client's catalogue on (60 services) took the system
prompt to **7,097 tokens**, which is past every threshold, so it is on now.

Measured against the live API on `claude-sonnet-5`, the client's own catalogue:

| | new input | cache write | cache read |
|---|---|---|---|
| no caching, every turn | 7,097 | 0 | 0 |
| caching, first turn | 180 | 6,917 | 0 |
| caching, every turn after | ~185 | 0 | 6,917 |

A cache write costs 1.25× a normal input token and a read 0.1×, so **this pays for itself inside a
single conversation** — a greeting plus four questions goes from 5.0× the prompt to 1.65×, with no
reuse by anybody else. Once warm it is ~8× cheaper per turn. The 5-minute TTL means a quiet kiosk
re-pays the write occasionally; that is still cheaper than not caching.

**It is a cost measure, not a speed one.** Time to first token, 16 interleaved samples per condition:
**1,606ms median without caching, 1,517ms with** — overlapping distributions, 22ms apart on the mean.
Prompt size is not what makes Ieumi feel slow, and trimming the service list will not speed it up
either. Verify with `usage.cache_read_input_tokens` rather than assuming.

**One breakpoint, not two.** `systemBlocks()` in `prompt.js` caches everything `buildSystem()`
produces — rules *and* per-centre persona and catalogue — and leaves `jobsSection()` outside it,
because that changes with every question. This section used to advise the opposite: invariant rules
first, persona last, so centres share a prefix. That was not done, and the reason is the arithmetic.
Sharing the rules across centres saves ~1,000 tokens per centre and costs a rewrite of the Korean
prompt text to lift `tone` and `region` out of the rules; caching the whole per-centre block saves
6,917. Each centre paying for its own entry is the right trade at two centres, and probably at fifty.
Revisit if the estimate ever becomes many centres each with traffic too sparse to keep a cache warm.

If `cache_control` is ever rejected, `degrade()` in `server.js` retries without it and sends the
identical prompt as one string — the fallback changes cost, never behaviour.

---

## 10. The service catalogue — and how a centre updates it

Admin dashboard → ⭐ **Service Priority** tab. For each center, roughly **60 services** across four
categories (health · welfare · daily living · jobs) can be selected and ordered. It is the first
implementation of §3-2 (common + individual inheritance), it **is** wired into the kiosk (§6-P1),
and each entry now carries the two fields that make it actionable:

| Field | What it is | Why it matters |
|---|---|---|
| `org` | the organisation that runs the service | Ieumi may **name it** — it is quoting a record, not guessing |
| `link` | that organisation's web address | too long to read aloud; it travels **by SMS** instead |
| `update_method` | `manual` / `realtime_api` / `scraping` | says which entries depend on code that can go stale silently |
| `scope` | `common` / `center` | whether every centre inherits it, or it belongs to this one alone |

### How an updated list reaches a running platform

The client maintains the list themselves and revises it (V03 → V04 → …). Re-running the seed does
**not** update anything (`ON CONFLICT DO NOTHING`), so the update path is an import:

**Dashboard → ⭐ 서비스 우선순위 → 📥 서비스 목록 가져오기** — drop in the JSON file, press
**미리보기** (preview), read what will change, press **반영하기** (apply). No deploy, no restart.
`POST /api/services/import` is the same thing for scripts.

Four properties are what make it safe to hand to a centre:

- **Preview first.** A dry run reports created / updated / unchanged / skipped, and for each update
  names the field and both values. Nothing is written. (The same shape as the Excel roster paste,
  which §3-4 says is what decides adoption.)
- **Idempotent.** Re-importing an unchanged file reports *48 unchanged* and writes nothing.
- **A partial file is a partial update, never a truncation.** A service absent from the file is left
  alone. Retiring one is a separate, deliberate act.
- **A field the file omits is left alone.** `{"id":"s1","org":"…"}` changes the organisation and
  nothing else.

**Who may write what** is decided from the session, never from the file (§3-3): master's import
becomes nationwide content that every centre inherits at once; a centre admin's import lands in that
centre only. A centre editing an *inherited* entry writes an **override** — the nationwide row is
untouched and other centres never see the change.

### `scope` — who a service belongs to, decided by the data rather than guessed

The first import classified content by reading the text: anything mentioning 서초 or 서리풀 was that
centre's, everything else nationwide. Adding the client's `org` column showed how badly that read the
data — it found **one** local service where **36 of the 50 organisations are Seocho-district bodies**
(방배노인종합복지관, 서초구보건소, 서초구청 …). Left as nationwide content, 강서 would have inherited
"Bangbae Senior Welfare Centre" as a national service, which is the inheritance model (§3-2) telling
a lie.

The client now classifies each row itself and the platform follows the file:

| `scope` | Count | What it means |
|---|---|---|
| `common` | 11 | nationwide or Seoul-wide — 복지로, 기상청, TOPIS, 노인일자리여기, 서울금융복지상담센터. Every centre inherits these. |
| `center` | 39 | a Seocho body, branch or facility — including the local branches of national systems (서초50플러스센터, 서초고용복지+센터), because 강서 must not inherit a Seocho branch. |

A row whose stored scope differs from the file's is a **move**, not an edit, and the import treats it
as one:

- It is done **in place** (`UPDATE services SET scope, center_id`), so the owning centre keeps its
  selection, its ordering and its overrides — those hang off `services.id`.
- Moving nationwide content into one centre **removes the inherited row from every other centre**.
  That is the entire point, and the preview states how many centres lose access *before* the button.
- **Only a scope the file states counts.** A defaulted scope never moves anything — reading the
  absence of the field (the client's first file had none) as "make everything nationwide" would strip
  every centre's own content in one press.
- A move is **master's to make**. A centre admin cannot reclassify nationwide content, and no import
  hands one centre's private service to another — that is a transfer, not a classification.

### Renames are reported separately, with the history riding on them

Changing `sub` is the one edit that can quietly turn a code into a different service. The client's
`s19` does exactly that: ours was 긴급복지지원 (emergency welfare support), theirs is 노인여가복지시설
안내 (senior leisure facilities). Every call already filed under that code silently re-labels, so the
preview calls renames out on their own and says **how many requests are attached**.

`s19` had none, so the client's version was applied and **긴급복지지원 was moved to `s61`** rather than
being deleted — the client owns this catalogue's numbering, and nothing of ours had to be lost to
honour it.

---

## 10a. Reading what is behind the link — pages, posters, retrieval

A catalogue row says what a service *is*. This layer is what the linked page *says*. It runs on a
schedule (`npm run sync-sources`), never inside a conversation (§3-6).

**The stage this was added to fix (2026-09-18).** The client asked Ieumi to name three courses from
the 서초50플러스센터 row and it could not. The pipeline was not broken: the catalogue URL was
`…/sch/index.do`, the **front door**, which the code read correctly — hours, phone, address, 2,208
characters. The courses sat one click away at `…/sch/education.do`, which the code *already parsed
cleanly* at 3,241 characters. Nobody had followed the link. **25 of 70 catalogue links point at a
bare homepage the same way**, the median summary was 212 characters, and 24 of them ended in "this
page doesn't say — call them".

```
services.link ──► landing page ──► up to 4 sub-pages     (강좌·시간표·신청·이용안내, same host)
                       │
                       └────────► up to 4 posters        (only when the text came up thin)
                                        │
        all of it ──► one summary  (service_sources.facts — always in the prompt)
                 └──► kept as text ──► source_chunks     (retrieved per question)
```

**Four properties worth keeping.**

- **One hop, same host.** Two hops is crawling a site, which is a different proposition from reading
  a few public pages once a day. The relay's allow-list is per hostname, so leaving the host would
  be refused anyway — and should be.
- **Posters are transcribed, not summarised.** 방배느티나무쉼터's timetable page is 486 characters
  and every one is navigation; the October schedule exists only as a JPG. A summarised timetable
  stops being a timetable, because the question is always about one cell of it.
- **The summary is kept *and* the text is kept.** Summarising chooses what matters before the
  question exists, so thirty courses become ten lines and twenty vanish. The summary still travels
  in every prompt; the pieces that match the question are added on top (`retrieval.js`).
- **Retrieval is substring overlap, not embeddings.** Korean glues its particles on (강좌/강좌를/
  강좌는 all contain 강좌), it needs no model call, and when an answer goes wrong it can be traced by
  eye — which matters when the person who got the wrong answer is 84. A small expansion table
  bridges the gap between how a senior asks ("몇 시에 문 여나요") and how a page writes it
  ("운영시간"), the same rule the prompt already gives the model.

### The invention guard — read this before touching the summariser

On the first real run of this layer, the summary for 방배느티나무쉼터 came back holding a **complete
weekly timetable that very nearly matched the real poster** — and the word 시니어발레 appeared
**nowhere** in the 3,211 characters actually fetched. The model invented it, and was right.

Being right is the worse outcome. A fabrication that is usually correct earns trust and then fails
with no warning. Compared against the poster once it was genuinely read, Thursday's class was
"캘리그라피" (invented) against **"칼림바교실"** (real). That is the size of the error, and the person
who discovers it is standing outside a locked door.

So every summary line is now checked against the text that was actually fetched, by
`dropUngrounded()` in `sources.js`, with no extra model call:

- **every number must be present** — a fee, a time or a phone number is what a senior acts on, so
  one that is not in the source drops the line outright;
- **distinctive words must be present** — three characters or more, because 이용/운영/안내 appear on
  every institutional page in Korea and separate nothing. What separates a transcribed line from an
  invented one is the names: 셔플댄스 is either written on the page or it is not.

Two calibrations were needed and both are load-bearing. Numbers are compared as **digit groups**,
because a summary rewrites them (`2026.09.18 ~2026.10.07` → `09.18~10.07`) and literal matching cut
all ten real course lines. Words are matched with **at most one trailing character removed**,
because stripping three let two-character stems match anywhere in a 2,700-character document and the
fabricated timetable scored 40 of 44 words "grounded" and sailed through.

A high `✂` count in the sync output is **not** a success. It means the extraction prompt is pushing
the model to fill gaps, and the prompt is what should change.

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
