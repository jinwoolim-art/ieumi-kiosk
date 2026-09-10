# Deploying Ieumi (이음이) to Render

The goal of this first deployment is a URL you can send to the client and to
welfare-centre staff so they can use the **dashboards** themselves. The kiosk is
reachable at the same URL and is now in a state worth trying — read
[The kiosk — what is true of it now](#the-kiosk--what-is-true-of-it-now) first,
so you can say up front what it does and does not do.

Roughly 30 minutes, most of it waiting for the first build.

---

## Before you start

| | |
|---|---|
| **Cost** | Render Starter **$7/month**. The free plan sleeps after 15 minutes idle and takes ~50 seconds to wake — a client who opens your link and stares at a blank tab will assume it is broken. Do not send a free-plan URL. |
| **Database** | The Neon database you already created. Render connects to the same one. |
| **Repository** | `jinwoolim-art/ieumi-kiosk` on GitHub. Render deploys from a branch, so the work has to be committed and pushed first. |

### 1. Rotate the Neon password — do this first

The connection string was pasted into a chat transcript, so treat it as public.

1. Neon dashboard → your project → **Roles** → `neondb_owner` → **Reset password**
2. Copy the new connection string
3. Update `ieumi-server/.env` locally
4. Use the new string for `DATABASE_URL` in Render below

### 2. Consider a separate database for development

Right now your laptop and the deployed site would share one database — every
local experiment shows up in the client's demo. Neon **branches** solve this
cleanly: branch the database, point your local `.env` at the branch, and leave
the main one for the deployed site.

Not required for the first deploy, but do it before more than one person is
using the site.

### 3. Tidy the demo data

The live checks left two things behind:

- a second centre, **강서 어르신 복지관** — keep it, it is the easiest way to show
  multi-tenancy to the client (switch centres from the header as `master`)
- a request titled **"라이브 점검 통화"** on the Seocho staff dashboard — delete it
  from the dashboard, or leave it, it is harmless

---

## Deploying

### 4. Push the branch

Already done — the work is committed and pushed to **`Update-Server`**, and `render.yaml`
deploys from that branch. `master` is untouched, so the client can review the change as a
pull request before it becomes their main line.

If you later merge to `master`, change `branch:` in `render.yaml` to match.

### 5. Create the Blueprint

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
2. Connect the `ieumi-kiosk` repository
3. Render reads `render.yaml` and proposes **two** services:
   - `ieumi` — the web app
   - `ieumi-job-sync` — a nightly job that refreshes the job postings
4. It prompts once for the shared secrets, which both services then use

### 6. Set the environment variables

They live in one shared group (`ieumi-secrets`), so each is entered once.

| Variable | Value |
|---|---|
| `DATABASE_URL` | the **new** Neon connection string from step 1 |
| `ANTHROPIC_API_KEY` | your Claude key — set a spend limit on it |
| `DATAGO_KEY` | data.go.kr, for the job postings |
| `CLOVA_API_KEY_ID`, `CLOVA_API_KEY` | NAVER CLOVA, for the voice |
| `CLOVA_SPEAKER` | `nara` |
| `CLOVA_SPEED` | `1` (slower, for older callers) |
| `ALIGO_*` / `NCP_SENS_*` / `SMS_FROM_NUMBER` | **leave empty** |

`COOKIE_SECURE=on`, `NODE_VERSION=22` and the sync's `JOBS_MAX_DETAIL` are
already in `render.yaml`.

> **Leave the SMS keys empty.** With no keys the app shows the "message sent"
> card on screen and sends nothing. Every real message costs money, and a test
> that texts actual seniors is not something to switch on by accident.

### 7. Deploy

Render builds (`npm ci --omit=dev`), runs the migrations, then starts the
server. The database already has its tables and seed data, so the migration step
will report that everything is applied and move on.

### 8. The nightly job sync

`ieumi-job-sync` runs at **20:00 UTC — 05:00 the next morning in Korea**, so a
centre opens to fresh postings and the slow API calls happen while nobody is
using the kiosk. It takes about ten minutes.

This is not optional decoration. Without it the postings freeze on whatever the
last run fetched, and within weeks Ieumi is offering jobs that have closed —
quietly, with nothing on screen to say so. The run also prunes postings that
closed more than 30 days ago.

**After the first deploy, trigger it once by hand** (Render → `ieumi-job-sync` →
**Trigger run**) rather than waiting for the small hours. Then check
**Admin dashboard → 📊 일자리 데이터**: it shows the last sync, how many postings
are stored, and which ones this centre would actually offer. The same page has a
**지금 갱신** button if you ever need a refresh between nightly runs.

---

## Once it is live

### 9. Change all three passwords — before you send the link

The seeded passwords (`ieumi-master-2026` and friends) are in a chat transcript
and in this repository's history. The site is now on the public internet.

Sign in as each account and use the **비밀번호** button in the top-right bar:

| Account | Role |
|---|---|
| `master` | you / Play4 |
| `seocho-admin` | 복지관 관리자 |
| `seocho-staff` | 담당자 |

Changing a password signs that account out everywhere else but keeps the tab you
are using.

### 10. Check it works

- [ ] `https://<your-app>.onrender.com/health` → `"db": "connected"`
- [ ] `/로그인.html` loads and all three accounts sign in
- [ ] `master` can switch centres in the header (서초 ↔ 강서)
- [ ] `seocho-staff` sees only the roster tab in the admin dashboard
- [ ] The staff dashboard lists the seeded requests, and a status change survives a reload
- [ ] Admin → **🎙️ 이음이 설정** shows the kiosk URL
- [ ] Admin → **📊 일자리 데이터** shows a recent sync and at least one posting

### 11. Send it

Give the client the login URL and the two accounts that matter to them —
`seocho-admin` and `seocho-staff`. Keep `master` to yourself; it is the account
that can see and change every centre.

The questions worth asking a 담당자, since they are what §3-4 says decides
adoption: is entering the roster comfortable? Would you paste from Excel? Is
anything here confusing?

---

## The kiosk — what is true of it now

Three of the four gaps that made the kiosk unsafe to demo are closed:

- ~~It ignores the service list.~~ **Fixed.** The services a centre switches on
  reach the conversation, in the order it chose, and each call records which one
  it was about.
- ~~There is no live job data.~~ **Fixed.** Postings come from data.go.kr and are
  refreshed nightly.
- ~~No streaming.~~ **Fixed.** Time to the first spoken word is about 2.5
  seconds, down from about 7.

**Three things to say out loud before anyone tries it:**

1. **No SMS** — by design for a test. The on-screen card stands in for it, and
   nothing is actually sent.
2. **No wages, and no working hours.** The job source has neither field. Ieumi
   says it cannot know and points at the contact number rather than inventing a
   figure. The original demo script's "월급 150만원" cannot be reproduced from
   this data — if the pitch needs wages, that is a separate source or manual
   entry by the centre.
3. **서초 genuinely has very few open postings** — often one. Ieumi widens to the
   rest of 서울 and says so. That is the data, not a bug.

**The one real unknown is speech recognition.** The kiosk uses the browser's,
and it has never been tried on an actual elderly Korean speaker — accent, pace,
background noise in a centre hallway. Put that first in the first supervised
session. The typed input is there for when it fails, and the server already has
a CLOVA speech-to-text endpoint wired up if the browser's proves inadequate.

---

## Costs

| | |
|---|---|
| Render Starter | $7/month |
| Neon | free tier is enough for this |
| Claude | per token; set a spend limit on the key |
| CLOVA | free tier, then small |
| SMS | **real money per message** — keys are empty |

---

## If something goes wrong

**Build fails on `npm ci`** — `ieumi-server/package-lock.json` has to be
committed. There should be no `package-lock.json` at the repository root.

**Site loads but every action fails** — check `/health`. `"db": "not configured"`
means `DATABASE_URL` did not reach the service; `"unreachable"` means Neon
refused the connection (wrong password after the rotation, or the database is
suspended and needs a moment to wake).

**Login says the password is wrong when you know it is right** — ten failed
attempts for one account from one address locks it for 15 minutes. Wait it out,
or restart the service, which clears the counter.

**Korean filenames 404** — the URLs are percent-encoded automatically. If you
typed one by hand, let the links do it instead.

**Everything is slow** — Render is in Singapore and Neon should be too. If you
moved Neon to Tokyo, move the Render region as well; a database on the far side
of an ocean from its app costs a round trip on every query.
