# Testing Ieumi — full walkthrough

Everything here was run on this machine while writing it. "Expected" means the
output I actually got, not what ought to happen.

You can now do all of this **in English**. That was the point of the last round:
you cannot test what you cannot read, and anything you cannot test, the client
finds first.

---

## 1. Start

```bash
cd ieumi-server && npm start
```

Expected:

```
이음이 백엔드 실행  (model=claude-sonnet-5, voice=vian)
  DB           연결됨 connected
  지역 사전      155개 지역 (job regions ready)
```

The `pg` SSL warning above it is a harmless deprecation notice.

If you get **`EADDRINUSE`**, something is already on port 8791 — often a previous
run that did not shut down. A stale process serves the **old code**, so a change
can look like it did nothing:

```bash
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8791 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
```

---

## 2. Pages, and the language switch

| URL | What |
|---|---|
| http://localhost:8791/login | Login |
| http://localhost:8791/admin | Admin dashboard — most testing happens here |
| http://localhost:8791/staff | Staff dashboard |
| http://localhost:8791/kiosk?c=TOKEN | The kiosk (token in §4) |
| http://localhost:8791/health | JSON status |

**Language.** Add `?lang=en` or `?lang=ko`, or use the small button bottom-right
on every page. The choice is remembered.

`?i18n=debug` prints any untranslated string to the browser console. All four
pages currently report **zero**. If you ever see Korean where you expect English,
open with that flag and the console names the exact string.

---

## 3. Log in

| Username | Password | Role |
|---|---|---|
| `master` | `ieumi-master-2026` | everything, all centres |
| `seocho-admin` | `ieumi-admin-2026` | Seocho only |
| `seocho-staff` | `ieumi-staff-2026` | requests only |

Use **`master`** — only master can switch centres, and switching centres is how
you see the import behaviour.

> These three passwords have been through a chat transcript. They need changing
> before anything gets a public URL.

---

## 4. Get the kiosk URL

Dashboard → the **microphone tab (🎙)** shows it in a 🔗 box. Or print both:

```bash
cd ieumi-server && node -e "const db=require('./db');(async()=>{for(const c of await db.all('SELECT slug,kiosk_token FROM centers ORDER BY slug'))console.log(c.slug+': http://localhost:8791/kiosk?c='+c.kiosk_token);await db.pool.end();})();"
```

Add `&lang=en` to run the kiosk in English.

---

## 5. What the data looks like right now

| | |
|---|---|
| **seocho** | 60 / 60 services on |
| **gangseo** | **0 / 15 on** ← test the import here |
| Pages read | **34 ok**, 11 could not be read, 6 had nothing usable |
| Job postings | 354 |
| SMS sending | **off** (`"sms": false`) — nothing can text a real person |
| Voice | CLOVA **is** configured, so the kiosk really speaks (small cost per phrase) |

---

## 6. Test A — the kiosk answers a real question *(the important one)*

This is what the client said was broken: *"the information is on the homepage,
but Ieumi says it doesn't know."*

1. Open the **seocho** kiosk URL with `&lang=en`
2. Press the green phone button. Ieumi greets you in English.
3. Type into the box at the bottom — speech needs Chrome and a microphone;
   typing exercises everything else:

   **"How much is the emergency living allowance for two people?"**

Expected — an actual answer, with a source and a date:

> According to the Seocho Welfare & Care Foundation page, checked on
> September 15 2026, the living expense support for a two-person household is
> **400,000 won**. Since this can change, it's good to double check with them
> directly. Would you like me to send this by text message?

> The source it names may be **Seocho District Office** instead. Both are
> correct — two services in the catalogue publish the same 서초형 긴급복지 table.

4. Now ask something the page does **not** cover:

   **"How many days does it take after I apply?"**

Expected — it says it does not know, and offers to pass it to a staff member.
**That boundary is the point.** Making Ieumi answerable was only worth doing if
it stayed honest about what it has not read.

---

## 7. Test B — services switch on when imported

The client's top-priority complaint. Test it on **gangseo**, not Seocho —
Seocho is already 60/60, so nothing visible changes there. This is the single
most likely way to conclude the fix did not work when it did.

1. `/admin` as `master`
2. Switch the centre dropdown (top) to **강서 어르신 복지관**
3. Open the **⭐ Service priority** tab — it reads **0 / 15 selected**
4. Paste the contents of **`서비스목록-v03_3_1-가져오기용.json`** into the import box
5. **Preview** (left button). Expected:

   ```
   수정 10건 · 켜짐 15건 · 변경 없음 49건 · 건너뜀 0
   ```

   `켜짐 15건` means 15 services will be switched on. Nothing is written yet.
6. **Apply** (right button) — the counter becomes **15 / 15**

**Test the opt-out too:** untick *"가져온 서비스를 바로 켜기"* and preview again.
The `켜짐` count disappears — the import then adds content without touching a
single switch.

---

## 8. Test C — the source panel

Same ⭐ tab. Above the list:

> 📄 **34** services have had their web page read, so Ieumi can answer specific
> questions such as amounts and eligibility. The rest can only give the
> organisation name and link.

That sentence is the honest version of "60 switched on". Under each service:

- **📄 page read** — with when, and how many characters of facts
- **⚠ could not read** — with the reason (`HTTP 404`, timeout…)
- **○ nothing usable on the page** — a menu or a search form
- **see what was read** — opens exactly the sentences Ieumi is using. This is the
  only place an extraction can be checked.
- **read it again now** — refetches that one link (15–30s). Many failures are
  transient, so retrying by hand is worth a button.

Try **see what was read** on *Emergency & Night/Holiday Care*. It reports that
the page carries no actual pharmacy details — which is true, it is a search form.
The extractor saying so instead of inventing something is the behaviour to check
for.

---

## 9. Test D — one text message carries both kinds of information

The bug the client described as *"if one part works, the other doesn't."*

1. In the kiosk, ask about a **job**: `일자리 알아봐 주세요` / "find me a job"
2. Then, in the same call, ask about a **service**:
   `밤에 문 연 약국 어디 있어요?` / "where is a pharmacy open at night?"
3. Press the **문자 받기 / SMS** button

The card should contain **both**: the job posting with its phone number, a blank
line, then the service with its organisation and link. Before the fix the second
half was silently dropped.

Nothing is actually sent — the SMS keys are deliberately empty.

---

## 10. Test E — Korean is unchanged

Switch to `?lang=ko` and repeat Test A in Korean:

**`긴급복지지원 생계비는 얼마나 나와요? 저희는 두 식구예요.`**

> 두 식구시면 생계비는 40만원 나옵니다. 서초구청 홈페이지에서 확인한 내용이에요.

English mode sends the **same Korean rules** with a language directive on top. A
separate English rule set would be a second system, and testing it would prove
nothing about the one that actually runs in Seocho. There is a test that pins
this.

---

## 11. Automated tests

```bash
cd ieumi-server && npm test
```

Expected **`111 passed, 0 failed`**. They run against an in-memory Postgres
(PGlite) and never touch the real database, so they are safe to run any time.

---

## 12. Re-reading the linked pages

```bash
cd ieumi-server && npm run sync-sources
cd ieumi-server && npm run sync-sources -- s61
cd ieumi-server && npm run sync-sources -- --force
```

First form does every link, second only the named services, third re-summarises
even when the page has not changed. Pages whose content is unchanged skip the
model call, so after the first run this costs little more than the fetches.
Worth scheduling daily. Around 8–10 minutes for the full catalogue, mostly
waiting on slow government hosts.

---

## Troubleshooting

**A change seems to have done nothing** — a stale server on 8791 is serving the
old code. Kill the port (§1) and restart.

**The kiosk does not hear you** — speech recognition needs **Chrome** and
microphone permission; an Android WebView will not work. Use the text box.

**A page 404s** — use the English URLs in §2.

**`Connection terminated due to connection timeout`** — Neon suspends idle
databases and the first query after a quiet spell can fail. Reload.

**Korean text where you expect English** — open with `?i18n=debug` and read the
console. It names the exact missing string.
