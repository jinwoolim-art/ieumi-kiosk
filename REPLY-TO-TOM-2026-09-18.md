# 탐님께 — 2026-09-18 답변 (① 키 ② 크롤링·비전·RAG)

*채팅에 그대로 붙여넣으실 수 있는 길이로 적었습니다. 자세한 내용은 아래 링크 문서에.*
*English below.*

---

## ① 먼저 키부터 — 방금 전부 다시 호출해서 확인했습니다

**결론: 키는 이미 적용되어 있고, 지금도 쓰고 있습니다.**
막혀 있는 것은 키가 아니라 **공공데이터포털의 '활용신청' 승인**입니다.

주신 `DATAGO_KEY` 로 방금 아홉 개 서비스를 실제로 호출해 봤습니다 (2026-09-18):

| 서비스 | 결과 |
|---|---|
| 노인일자리 (지금 키오스크가 매일 쓰는 것) | ✅ **NORMAL SERVICE** — 잘 됩니다 |
| 복지로 중앙부처 복지서비스 | ✅ **총 461건** |
| 복지로 지자체 복지서비스 (서초구) | ✅ **총 10건** |
| **약국** (국립중앙의료원) | ❌ HTTP 403 — **등록되지 않은 서비스키** |
| **응급의료기관** | ❌ HTTP 403 — 등록되지 않은 서비스키 |
| **응급실 실시간 병상** | ❌ HTTP 403 — 등록되지 않은 서비스키 |
| 기상청 단기예보 | ❌ HTTP 403 — SERVICE_KEY_IS_NOT_REGISTERED |
| 기상청 기상특보 | ❌ HTTP 403 — SERVICE_KEY_IS_NOT_REGISTERED |
| TAGO 버스도착 / 버스정류소 | ❌ HTTP 403 — SERVICE_KEY_IS_NOT_REGISTERED |
| 심평원 병원정보 | ❌ HTTP 403 — 등록되지 않은 서비스키 |

**"등록되지 않은 서비스키"는 키가 틀렸다는 뜻이 아닙니다.**
같은 키로 노인일자리와 복지로는 **바로 위에서 정상으로 열립니다.** 포털이
"이 키는 맞는데, 이 **서비스**에는 아직 신청·승인이 안 되어 있다"고 답하는 것입니다.

그래서 **키를 다시 보내 주셔도 이 화면은 그대로입니다.** 필요한 것은 포털에서
**'활용신청' 버튼**을 눌러 주시는 일 하나뿐입니다 (9/15 에 목록 드린 그대로입니다 —
`REPLY-TO-TOM-keys.md`). 승인은 보통 즉시~하루입니다. 승인되면 **연락 주실 필요도
없습니다** — 제가 같은 방법으로 다시 확인해서 먼저 알려드리겠습니다.

이 확인을 **버튼 하나로 다시 돌릴 수 있게** 만들어 두었습니다 (`npm run check-datago`).
승인해 주신 뒤에 제가 바로 돌려서, 위 표를 그대로 다시 보내드리겠습니다.
모델도 안 부르고 30초면 끝나니 몇 번이든 확인할 수 있습니다.

**혹시 다른 키를 보내주셨다면** 서버 설정에는 그 키가 들어와 있지 않습니다.
보내주시면 2분 안에 같은 방법으로 확인해서 결과를 알려드리겠습니다.
(다만 위 아홉 개 결과로 보아, 새 키라도 활용신청 전에는 같은 403 이 납니다.)

**그리고 기다리지 않고 지금 할 수 있는 것이 하나 있습니다.**
**복지로는 이미 열려 있습니다** (중앙부처 461건 + 서초구 10건). 원하시면 약국·날씨
승인을 기다리는 동안 **복지로부터 먼저 붙이겠습니다.** 다만 9/15 에 부탁드린
**"어느 API 가 59개 목록의 어느 줄에 붙는지"** 를 아직 못 받아서, 그것만 주시면
바로 시작하겠습니다. 추측으로 붙이면 엉뚱한 서비스에 엉뚱한 데이터가 붙습니다.

---

## ② "크롤링 + 비전 + RAG 파이프라인이 구축 안 되어 있나요?"

**세 가지를 물으셨고 답이 각각 다릅니다. 어제까지 기준으로 있는 그대로 말씀드립니다.**

- **크롤링 — 절반이었습니다.** 페이지 받아오기·한국 중계·자바스크립트 페이지
  브라우저로 열기·표 읽기는 이미 하고 있었습니다. 그런데 **서비스마다 주소를 딱
  하나만** 읽었습니다. 거기서 링크를 한 번도 따라가지 않았습니다.
- **비전 — 전혀 없었습니다.** HTML 이 아닌 것은 그 자리에서 버렸습니다.
- **RAG — 없었습니다.** 200자 요약만 남기고 원문을 버려서, 꺼내 쓸 것이 없었습니다.

**그런데 42번 행은 파이프라인 고장이 아니었습니다.** 카탈로그 주소가
`sch/index.do` — **대문**이었습니다. 강좌는 한 번 더 눌러야 나오는
`sch/education.do` 에 있었고, 그 페이지는 **어제 있던 코드로도 3,241자가 멀쩡히
읽힙니다.** 아무도 따라가 보지 않았을 뿐입니다. 링크 70개 중 **25개**가 같은
모양이었습니다.

**오늘 네 가지를 다 만들었습니다.** 그리고 지금은 이렇게 답합니다:

> **강좌 3개 소개해 주세요** → '셔플댄스', '컬러로 이해하는 나와 타인',
> '아이패드로 그리는 어반드로잉' … 10월에 시작해요.
>
> **방배느티나무쉼터 10월 월요일에 뭐 있어요?** → 11시부터 시니어발레, 12시반부터
> 발레핏, 오후 2시 전신스트레칭, 3시 밴드근력운동 …
>
> **셔플댄스 수강료는요?** → 3만 원, 정원 15명. 신청은 9월 18일~10월 7일.

두 번째 답은 **전부 JPG 포스터 한 장에서 읽어 온 것**입니다. 탐님이 빨간 원으로
표시해 주신 그 시간표입니다.

**⚠️ 그리고 꼭 말씀드려야 할 것이 있습니다.**
처음 돌렸을 때 이음이가 **주간 시간표를 통째로 지어냈습니다.** 실제 포스터와
거의 맞았는데, 읽어 온 글 어디에도 그 과목 이름이 없었습니다. **맞았다는 점이 더
위험합니다** — 대부분 맞으면 믿게 되고, 틀린 날에는 표시가 나지 않습니다.
그래서 **요약의 모든 줄을 실제로 읽어 온 글에 대고 검사하는 장치**를 넣었습니다.
숫자가 하나라도 원문에 없으면 그 줄을 버립니다. 지금 돌리면 지어낸 줄은 전부
걸러지고, 진짜 강좌 열다섯 줄은 하나도 안 걸립니다.

**자세한 내용과 탐님이 직접 확인하실 항목 5가지** → `REPLY-TO-TOM-crawl-vision-rag.md`
(그중 5번은 **일부러 없는 것을 물어보는 시험**입니다. 꼭 같이 봐 주세요.)

---
---

# English (Play4 internal)

## ① The keys — re-tested just now, all nine endpoints

**The key is applied and in use. What is blocked is data.go.kr's 활용신청 approval,
not the key.**

Called with the `DATAGO_KEY` already in the server (2026-09-18):

- ✅ **Senior jobs** — `NORMAL SERVICE` (the kiosk uses this every day)
- ✅ **Bokjiro central welfare** — 461 records
- ✅ **Bokjiro local welfare (Seocho)** — 10 records
- ❌ **Pharmacy, emergency centres, real-time ER beds, weather forecast, weather
  alerts, TAGO bus arrival, TAGO bus stops, HIRA hospitals** — all HTTP 403,
  `등록되지 않은 서비스키` / `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`

That error does **not** mean a wrong key — the same key returns NORMAL SERVICE on the
line above. It means the portal account has not been **approved for those services**.
**Re-sending the key changes nothing**; someone has to press 활용신청 on the portal for
the seven services listed in `REPLY-TO-TOM-keys.md` (sent 2026-09-15). Approval is
usually instant to one day, and they don't need to tell us — we re-probe and report.

If they did send a *different* key, it is not in the server's `.env`. Send it and we
verify in two minutes — though on this evidence a new key would hit the same 403 until
the services are subscribed.

**Shippable without waiting:** Bokjiro is already open. Offered to wire it now, pending
the one thing still outstanding from 2026-09-15 — **which API backs which of the 59
catalogue rows**. Guessing that mapping would attach live data to the wrong service.

## ② Crawl + vision + RAG

Crawling was half-built (one URL per service, never followed a link); vision did not
exist; RAG did not exist (the page text was summarised to ~200 chars and discarded).
But the row-42 example was **not** a pipeline failure — the catalogue URL was the front
door, and the course page one click away already parsed cleanly at 3,241 characters.
25 of 70 links had the same shape.

All four are now built, plus a fifth: the summariser was caught **inventing a weekly
timetable that nearly matched the real poster**, so every line is now checked against
the text actually fetched. Detail and the five things for Tom to test are in
`REPLY-TO-TOM-crawl-vision-rag.md`.
