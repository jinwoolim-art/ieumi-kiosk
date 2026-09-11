# Trying it out — 이음이

A walkthrough of everything built on top of the original prototype. Roughly
20 minutes to go through all of it.

UI labels are quoted in Korean exactly as they appear on screen.

---

## 1. Start it

Everything is already set up on the development machine (database, keys,
seed data). From the repository root:

```bash
node ieumi-server/server.js
```

It prints the URLs. Open **http://localhost:8791/로그인.html**.

> If it says `DATABASE_URL 미설정`, the `.env` is missing — see README.md.

### Accounts

| Sign in as | Password | Who they are |
|---|---|---|
| `master` | `ieumi-master-2026` | Play4 — sees and configures every centre |
| `seocho-admin` | `ieumi-admin-2026` | 복지관 관리자 — runs one centre |
| `seocho-staff` | `ieumi-staff-2026` | 담당자 — the roster and incoming requests |

**These are development passwords.** Change them before the site is on a public
URL (the **비밀번호** button, top right).

---

## 2. Letting the client try it

The app runs on one machine, so the client needs a way to reach it. Three
options, in increasing order of effort:

### a. Same network — nothing to install

If the client is in the same office, they can open
**http://192.168.1.10:8791/로그인.html** directly. Nothing else needed.

### b. A temporary public link — no account, no install

```bash
npx localtunnel --port 8791
```

It prints a public `https://…loca.lt` address that anyone can open. Good for a
scheduled call with the client.

Three things to know: the address changes every time you run it, this machine
must stay awake with the server running, and while it is up **anyone with the
link can reach the login page** — so change the passwords first, and stop the
tunnel (Ctrl-C) when the call ends.

### c. Deploy it properly

See **[DEPLOY.md](DEPLOY.md)**. A Render account and $7/month, permanent URL,
nothing depending on anyone's laptop. This is the right answer once more than
one person needs it, or the client wants to poke at it on their own time.

---

## 3. What to look at

### The dashboards

**Sign in as `seocho-staff`** — the most restricted role.

1. You land on the **담당자(상담) 대시보드**. Seven demo calls are listed, newest
   first, with an AI summary and the caller matched against the roster.
2. Press **처리중** on a card, then reload the page. The status stays. *(Before
   this work it lived in that one browser and nobody else could see it.)*
3. Go to **관리자(운영) 대시보드** via the header link. Notice there is **only
   one tab** — 회원명단. A 담당자 gets the roster and nothing else.

**Sign in as `seocho-admin`** — now there are seven tabs.

4. **👥 회원명단 관리** — the part §3-4 says decides adoption:
   - **Click a name or a phone number in the table.** It becomes editable.
     Enter saves, Esc cancels. *(Previously there was no way to fix a typo —
     you deleted the person and typed them again.)*
   - Add someone with the keyboard alone: name → `Tab` → number → `Enter`.
   - Paste this into the **엑셀에서 붙여넣기** box, exactly as-is:
     ```
     한복순	010-5555-1111
     010-5555-2222	조영식
     김순자, 010-1234-3456
     이상한사람, 없음
     ```
     Before you press anything it tells you what will happen: two new, one
     update (김순자 is already on the roster), one line skipped — and *which*
     line, and why. Tab-separated works, and so does a reversed column order.
   - Type in the **찾기** box to filter a long roster by name or number.

5. **⭐ 서비스 우선순위** — the ~60 services. Note the tags: **공통** are
   nationwide services managed by Play4, **우리 복지관** belong to Seocho alone.
   A centre inherits the common set and adds its own. Tick a few and reorder
   them with ▲▼; it saves as you go.

   Each entry now shows **🏢 the organisation that runs it and a link** — this is
   the client's V03 data — plus a badge saying how it is kept current
   (**직접입력** manual / **실시간 API** / **스크래핑** scraping). Eleven entries
   show **⚠ 담당기관·링크 없음** ("no organisation or link") in orange: those are
   services we added that the client's file does not cover, and Ieumi has nothing
   to text a senior about them yet.

   **📥 서비스 목록 가져오기 / 업데이트** — this is the answer to the client's
   *"how does an updated list reach the platform?"*. Paste or upload the JSON file
   exactly as they send it.

   - Press **미리보기** (preview) first. It reports how many are new, how many
     change, how many are identical, and how many are skipped — and for each
     change, **which field and both values**. Nothing is written yet.
   - Press **반영하기** (apply) to commit. No deploy, no restart.
   - Press **미리보기** again on the same file: everything reads *변경 없음*
     ("unchanged"). An import is safe to repeat.
   - A service **not in the file is left alone** — a partial file is a partial
     update, never a truncation.

   Signed in as `master` the note at the top reads **전국 공통 목록으로 반영됩니다**
   ("applies as the nationwide list — every centre inherits it immediately").
   Sign in as `seocho-admin` and the same box says **서초 … 전용**: a centre can only
   ever write its own content. That is §3-3 visible before you press anything.

   Two rows in the client's file are **refused**, by design: `s19` and `s43` are
   already Seocho-private services under different names, and the message names
   the centre that owns the code. See PROJECT.md §10 — it needs the client's
   decision, not ours.

   **기관·링크 고치기** on any row edits the organisation and link. As
   `seocho-admin` on a **공통** service this writes an *override*: Seocho sees the
   new value, every other centre still sees the original. Clear the field to
   inherit again.

6. **🎙️ 이음이 설정** — change the assistant's name, voice and speaking tone.
   Save. This page also shows **this centre's kiosk address** — copy it, you
   need it in a moment.

7. **📊 일자리 데이터** — real job postings from data.go.kr, refreshed nightly,
   filtered to this centre's district. **There is no pay or working-hours
   information** in that source; the note on the page says so, and Ieumi will
   not invent it.

**Sign in as `master`** — this is the Play4 view.

8. A **centre dropdown** appears in the header. Switch between 서초 and 강서 and
   watch the roster, services and requests change. Two centres, one system,
   no data crossing between them.
9. **🏢 복지관 관리** — add a centre. It inherits the whole common service
   catalogue immediately, with nothing switched on until that centre chooses.

### The kiosk

Open the address from step 6 — it looks like
`http://localhost:8791/이음이-키오스크-LIVE.html?c=…`

The token in the URL is how the kiosk knows which centre it belongs to; there is
nobody to log a kiosk in.

10. Press the green phone button. Ieumi greets you **in the voice and with the
    name you set in step 6**.
11. Say — or type in the box at the bottom if the microphone is not available —
    **"일자리 좀 알아봐 주세요"**. Ieumi offers a real posting from the centre's
    own district.
12. Ask **"월급은 얼마예요?"**. It says it cannot know and points you at the
    contact number. That is correct: the source has no wage field, and making
    one up is the failure this is designed to avoid.
13. Ask **"뭘 도와줄 수 있어요?"**. It names the services *this centre switched
    on in step 5*, top of the list first.
14. Ask for a text message, enter a phone number from the roster (e.g.
    `010-1234-3456`). It recognises the caller by name. Nothing is actually
    sent — SMS keys are deliberately unset — the card on screen shows exactly
    what would go out.

    **Check the card against step 11.** It must describe *the posting Ieumi just
    talked about*, and it must have **no 급여 (wage) line**. Until this round it
    could not: the browser resolved the model's choice against a hardcoded demo
    array, so a senior asking about a real posting was texted a fictional one
    with `월급 150만원` on it. The card is now the server's own message, echoed
    back — preview and actual cannot drift apart.

14b. Now try the same thing **without a job**. Press 통화 종료, start a new call,
    and ask a health question — **"밤에 문 연 약국은 어디서 찾아요?"** ("where do I
    find a pharmacy open at night?"). Ieumi names **휴일지킴이약국**, the real
    organisation from the catalogue, and offers a text. Ask for it: the message
    carries the summary of the answer, the organisation, and its web address.
    Before this round there was no such message — the code sent the fake cleaning
    job instead.
15. Press **통화 종료**, then open the **담당자 대시보드**. The call is at the top
    of the list, summarised, categorised, and tagged with which service it was
    about.

### Speed

The thing to feel rather than measure: Ieumi starts speaking **about two and a
half seconds** after you finish, and keeps talking while the rest of the answer
is still being written. It used to be about seven seconds of silence.

---

## 4. What is deliberately not working

- **No text messages are sent.** The keys are unset on purpose. Every real
  message costs money, and a test that texts actual seniors is not something to
  switch on by accident.
- **No wages or working hours** for job postings — that data does not exist in
  the government source. If the pitch needs them, they need a different source
  or manual entry by the centre.
- **서초 has very few open postings** — often one. Ieumi widens to the rest of
  Seoul and says so. That is the real data, not a bug.
- **Health, welfare and daily-living services** are recognised and passed to
  staff, but have no live data behind them yet. Your own dashboard marks
  건강·의료 as pending legal review.

## 5. The one thing nobody has tested

**Speech recognition with an actual elderly speaker.** The kiosk uses the
browser's, and it has never been tried on the accent, pace and background noise
of a real welfare centre. Everything else can be judged from a desk; this
cannot. Put it first in the first session with real callers — the typed input is
there for when it fails.
