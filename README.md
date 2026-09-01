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

Dashboards (static HTML):
- `서초-이음이-관리자-대시보드.html` — Admin dashboard (members, data, settings)
- `서초-이음이-담당자-대시보드.html` — Staff dashboard (incoming requests)

> File names are in Korean. In the browser the URL will be percent-encoded automatically — it still works.

---

## Project structure

```
ieumi-kiosk/
├── 이음이-키오스크-프로토타입.html   # Prototype (static)
├── 이음이-키오스크-LIVE.html         # Live app (needs server)
├── 서초-이음이-관리자-대시보드.html   # Admin dashboard
├── 서초-이음이-담당자-대시보드.html   # Staff dashboard
├── assets/prototype/                # character / phone / background images
└── ieumi-server/
    ├── server.js                    # zero-dependency Node backend
    └── .env.example                 # copy to .env and fill your keys
```

---

## Run the Live version

**Requirements:** Node.js (v18+). No `npm install` needed — the server uses only Node built-ins.

1. **Set up keys**
   ```bash
   cd ieumi-server
   cp .env.example .env
   # edit .env and fill in your own keys (see below)
   ```

2. **Start the server** (from the repository root)
   ```bash
   node ieumi-server/server.js
   ```
   The console prints the local URL (e.g. `http://localhost:8787/...`).

3. **Open the app** in Chrome (best speech-recognition support):
   `http://localhost:<port>/이음이-키오스크-LIVE.html`
   Allow microphone access. If speech isn't recognized, type in the input box at the bottom.

The **prototype** needs no server — just open `이음이-키오스크-프로토타입.html` directly, or serve it statically.

---

## Backend endpoints (`ieumi-server/server.js`)

| Route | Purpose |
|-------|---------|
| `POST /chat` | Claude conversation (returns reply + intent) |
| `POST /tts`  | CLOVA text-to-speech (returns audio) |
| `POST /stt`  | CLOVA speech-to-text (optional; browser STT used by default) |
| `POST /sms`  | Send SMS (Aligo or NAVER SENS) |
| `GET  /health` | Health check |
| `GET  /*`    | Serves the static HTML/asset files |

## Environment keys (`.env`)

See `ieumi-server/.env.example`. Summary:

- `ANTHROPIC_API_KEY` — Claude (conversation)
- `CLOVA_API_KEY_ID`, `CLOVA_API_KEY`, `CLOVA_SPEAKER`, `CLOVA_SPEED` — CLOVA TTS
- `NCP_SENS_*`, `SMS_FROM_NUMBER` — SMS via NAVER SENS, **or**
- `ALIGO_API_KEY`, `ALIGO_USER_ID`, `ALIGO_SENDER` — SMS via Aligo
- `DATAGO_KEY` — public senior-job open data (data.go.kr)

> ⚠️ Never commit the real `.env`. It is gitignored. Only `.env.example` (no values) is tracked.

---

## Notes

- If no SMS keys are set, `/sms` is a no-op and the app just shows the "message sent" card on screen (useful for demos).
- The Live app gracefully falls back to a text input box when browser speech recognition is unavailable.
