# Ieumi (이음이) — Senior-friendly Voice Kiosk

**Ieumi** is a voice-based information kiosk for elderly citizens.
The senior picks up a handset and simply **speaks**; Ieumi understands, answers by **voice**,
and sends the information (e.g. local job openings) by **SMS**.

> Front end: as simple as possible (one button, natural speech).
> Back end: structured (STT → LLM → TTS → SMS).

---

## Two versions

| File | Version | Backend needed? |
|------|---------|-----------------|
| `이음이-키오스크-프로토타입.html` | **Prototype** — scripted click-through demo of the UI flow | ❌ No (pure static, open directly in a browser) |
| `이음이-키오스크-LIVE.html` | **Live** — real AI conversation (Claude) + real voice (CLOVA TTS) + SMS | ✅ Yes (runs against the local server) |

Dashboards (need the server, the database, and a login):
- `로그인.html` — Login; sends you to the dashboard your role belongs to
- `서초-이음이-관리자-대시보드.html` — Admin dashboard (roster, service priority, Ieumi settings, accounts, centers, stats)
- `서초-이음이-담당자-대시보드.html` — Staff dashboard (incoming requests)

> File names are in Korean. In the browser the URL will be percent-encoded automatically — it still works.

---

## Project structure

```
ieumi-kiosk/
├── PROJECT.md                       # purpose, scope, direction (read first)
├── 로그인.html                       # Login — the way into both dashboards
├── 이음이-키오스크-프로토타입.html   # Prototype (static, no server)
├── 이음이-키오스크-LIVE.html         # Live app (needs server + ?c=<kiosk token>)
├── 서초-이음이-관리자-대시보드.html   # Admin dashboard
├── 서초-이음이-담당자-대시보드.html   # Staff dashboard
├── assets/
│   ├── ieumi-api.js                 # shared API client for the dashboards
│   └── prototype/                   # character / phone / background images
└── ieumi-server/
    ├── server.js                    # Node backend (chat / tts / stt / sms + static)
    ├── api.js                       # REST API — the tenant boundary lives here
    ├── auth.js                       # roles, sessions, password hashing
    ├── env.js                       # .env loader
    ├── db/
    │   ├── index.js                 # Postgres pool and query helpers
    │   ├── migrations/001_init.sql  # schema
    │   ├── migrate.js               # migration runner  (npm run migrate)
    │   └── seed.js                  # first center + catalog (npm run seed)
    ├── test/run.js                  # integration tests   (npm test)
    └── .env.example                 # copy to .env and fill your keys
```

---

## Run the Live version

**Requirements:** Node.js (v18+) and a **Postgres database**. Centers, accounts, rosters,
service priorities and requests all live in Postgres now — see [PROJECT.md](PROJECT.md) §6-P0.

1. **Get a database.** Any Postgres works. If you don't have one locally, a free hosted
   database (Neon, Supabase, Railway) gives you a connection string in a couple of minutes.

2. **Set up keys**
   ```bash
   cd ieumi-server
   cp .env.example .env
   # edit .env: DATABASE_URL is required; the API keys are optional (see below)
   ```

3. **Install and set up the database** (from `ieumi-server/`)
   ```bash
   npm install && npm run setup
   ```
   `npm run setup` creates the tables and seeds the first center (서초), the ~59-service
   catalog, a demo roster and one account per role. **The generated passwords are printed
   once — save them.** (Set `SEED_*_PASSWORD` in `.env` first to choose your own.)

4. **Start the server** (from the repository root)
   ```bash
   node ieumi-server/server.js
   ```
   The console prints the local URLs.

5. **Sign in** at `http://localhost:8791/로그인.html` — this is now the way into both dashboards.

6. **Open the kiosk** in Chrome (best speech-recognition support). The kiosk identifies its
   center by a token in the URL, so use the address shown in
   **Admin dashboard → 🎙️ 이음이 설정**:
   `http://localhost:8791/이음이-키오스크-LIVE.html?c=<kiosk token>`
   Allow microphone access. If speech isn't recognized, type in the input box at the bottom.

The **prototype** needs no server or database — just open `이음이-키오스크-프로토타입.html` directly.

### Job data

```bash
cd ieumi-server && npm run sync-jobs
```

Pulls senior job postings from data.go.kr into Postgres. Run it daily on a schedule — postings
are only useful while they are open. See [PROJECT.md §11](PROJECT.md#11-job-data--datagokr) for
what the source does and does not provide (it has **no pay and no working-hours field**).

### Deploying

See **[DEPLOY.md](DEPLOY.md)** — a Render Blueprint (`render.yaml`) is committed,
so deployment is connecting the repository and filling in the secrets. Read the
"What not to demo yet" section before pointing anyone at the kiosk.

### Tests

```bash
cd ieumi-server && npm test
```

Runs the migration, the seed and the API against a real Postgres compiled to WASM (PGlite),
so **no database server is needed to run the tests**. They cover the tenant boundary in
particular: that one center can never read or write another's data.

---

## Accounts and roles

| Role | Sees | Can do |
|------|------|--------|
| `master` (us) | every center, switchable from the header | everything, plus creating centers and common content |
| `center_admin` | one center | services & priority, Ieumi customization, staff accounts, roster |
| `staff` | one center | the roster, and handling incoming requests |

A center admin can only ever create **staff** accounts, never another admin or a master.
The server enforces this — the UI merely reflects it.

---

## Backend endpoints (`ieumi-server/server.js`)

| Route | Purpose |
|-------|---------|
| `POST /chat` | Claude conversation. Takes `c` = kiosk token, so the assistant speaks as that center's Ieumi and knows the services that center switched on. Returns `serviceCode`/`serviceName` when the caller's question matched one. **Pass `stream: true`** to get NDJSON instead: `{"t":"…"}` lines as the reply is written, then one `{"done":true, …}` line with the metadata — this is what lets the kiosk start speaking the first sentence before the rest exists |
| `POST /tts`  | CLOVA text-to-speech (returns audio). `c` selects the center's voice and speed |
| `POST /stt`  | CLOVA speech-to-text (optional; browser STT used by default) |
| `POST /sms`  | Send SMS (Aligo or NAVER SENS). `c` sets the sender name in the message |
| `GET  /health` | Health check (includes database status) |
| `GET  /*`    | Serves the static HTML/asset files |

### REST API (`ieumi-server/api.js`) — cookie session, same-origin

| Route | Purpose |
|-------|---------|
| `POST /api/login`, `POST /api/logout`, `GET /api/me` | Sign in / out, current account |
| `PATCH /api/me/password` | Change your own password (every role, including master) |
| `GET/POST /api/centers` | List centers; master creates one (it inherits the common catalog) |
| `GET/POST /api/users`, `PATCH /api/users/:id` | Accounts, within the caller's permission |
| `GET/POST/DELETE /api/members`, `PATCH /api/members/:id` | The senior roster — add (single or bulk), correct a name or number in place, remove |
| `GET /api/services`, `PUT /api/services/priority` | Resolved catalog (common + own) and the center's selection/order |
| `GET/PATCH /api/settings` | Per-center Ieumi name, voice, tone, greeting |
| `GET /api/requests`, `PATCH /api/requests/:id` | Incoming requests and their handling |
| `GET/POST/DELETE /api/job-posts` | Manually entered job material |
| `GET /api/stats` | Per-center summary |
| `GET /api/jobs/status`, `POST /api/jobs/sync` | Synced job postings for this center, and a manual refresh |
| `POST /api/import` | One-off import of data left in a browser's localStorage |

**Kiosk routes** use the center's kiosk token instead of a login, and can do only these three things:

| Route | Purpose |
|-------|---------|
| `GET  /api/kiosk/context?c=` | That center's name, Ieumi persona and enabled services |
| `POST /api/kiosk/lookup` | Is this phone number on our roster? |
| `POST /api/kiosk/requests` | File a request for the staff dashboard |

## Environment keys (`.env`)

See `ieumi-server/.env.example`. Summary:

- `DATABASE_URL` — **required**; Postgres connection string
- `DB_SSL`, `SESSION_HOURS`, `COOKIE_SECURE` — optional server settings
- `ANTHROPIC_API_KEY` — Claude (conversation)
- `CLOVA_API_KEY_ID`, `CLOVA_API_KEY`, `CLOVA_SPEAKER`, `CLOVA_SPEED` — CLOVA TTS
- `NCP_SENS_*`, `SMS_FROM_NUMBER` — SMS via NAVER SENS, **or**
- `ALIGO_API_KEY`, `ALIGO_USER_ID`, `ALIGO_SENDER` — SMS via Aligo
- `DATAGO_KEY` — public senior-job open data (data.go.kr); required for `npm run sync-jobs`

> ⚠️ Never commit the real `.env`. It is gitignored. Only `.env.example` (no values) is tracked.

---

## Notes

- If no SMS keys are set, `/sms` is a no-op and the app just shows the "message sent" card on screen (useful for demos).
- The Live app gracefully falls back to a text input box when browser speech recognition is unavailable.
