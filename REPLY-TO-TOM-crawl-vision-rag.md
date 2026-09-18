# 탐님께 — "크롤링 + 비전 + RAG 파이프라인이 구축 안 되어 있나요?" (2026-09-18)

*English version below — 영어본은 아래에 있습니다.*

---

## 1. 먼저, 질문에 그대로 답하겠습니다

**"수집 파이프라인이 구축 안 되어 있나요?"**

세 가지를 물으셨고, 답이 각각 다릅니다. 있는 그대로 적겠습니다.

| 물으신 것 | 어제까지의 상태 |
|---|---|
| **크롤링** | **절반.** 페이지를 받아오고, 한국 중계를 거치고, 자바스크립트로 그리는 페이지를 브라우저로 열고, 표를 칸까지 살려서 읽는 일은 <이미> 하고 있었습니다. 그런데 **서비스마다 주소를 딱 하나만** 읽었습니다 — 엑셀에 적힌 그 주소 한 장. 거기서 링크를 한 번도 따라가지 않았습니다. |
| **비전 (그림 읽기)** | **전혀 없었습니다.** HTML 이 아닌 것은 코드가 그 자리에서 버렸습니다. 그림이 모델에 닿은 적이 한 번도 없습니다. |
| **RAG** | **없었습니다.** 페이지를 읽은 뒤 200자짜리 요약만 남기고 **원문은 버렸습니다.** 꺼내 쓸 것이 남아 있지 않았으니, 검색해서 가져온다는 개념 자체가 성립하지 않았습니다. |

## 2. 그런데 42번 행은 파이프라인 고장이 아니었습니다

이 부분은 제가 틀렸다고 말씀드리는 편이 정확합니다. 재어 보고 알았습니다.

카탈로그에 적힌 서초50플러스센터 주소는 **`50plus.or.kr/sch/index.do`, 즉 대문**입니다.
수집은 그 대문을 정확히 읽었습니다 — 운영시간, 전화번호, 주소. **2,208자.** 잘못한 것이 없습니다.

강좌는 **한 번 더 눌러야 나오는 `/sch/education.do`** 에 있습니다.
그 페이지를 **어제 있던 코드 그대로** 열어 보았습니다:

```
http=200   3,241자
[표]
기관 | 중분류 | 소분류 | 제목 | 모집기간 | 교육기간 | 강사 | 수강료 | 정원
서초센터 | 2026년 서초 2학기 | 인생설계 | [건강] '누구나 쉽게 시작하는 셔플댄스' |
  2026.09.18~10.07 | 2026.10.08~11.12 | 이명준 | 30,000원 | 15 | …
```

**탐님이 캡처해 주신 그 표가, 새 코드 한 줄 없이 그대로 읽힙니다.**
아무도 그 링크를 따라가 본 적이 없었을 뿐입니다.

카탈로그 링크 **일흔 개 중 스물다섯 개**가 같은 모양입니다 — 대문만 가리키고 있습니다.
요약의 길이 중앙값이 **212자**였고, 그중 **스물네 개**는 마지막 줄이 *"이 페이지에는 나와
있지 않으니 전화로 문의하세요"* 였습니다. 탐님이 쓰신 "정보를 얻기에는 부족하다"가
정확히 이 숫자입니다.

## 3. 방배느티나무쉼터는 링크를 고쳐도 안 됩니다

화면 캡처 두 장을 같이 보내 주신 것이 결정적이었습니다.

- 대문: **1,039자**
- '프로그램 시간표' 페이지: **486자 — 그리고 그 486자가 전부 메뉴입니다.**
- 빨간 원으로 표시하신 10월 시간표: **JPG 그림 한 장**

그러니까 그때 이음이가 "자세한 시간표까지는 제가 알 수 없어요"라고 한 것은
**사실 그대로였습니다.** 그 시간표는 글로 존재하지 않습니다.
링크를 아무리 고쳐도, 브라우저로 아무리 잘 그려도 닿지 않습니다.
**눈으로 보는 수밖에 없습니다.** 탐님이 "텍스트 이미지 등 모든 정보"라고 쓰신 그대로입니다.

## 4. 오늘 만든 것

**① 한 걸음 더 따라갑니다.**
대문에서 강좌·프로그램·시간표·신청·이용안내로 보이는 링크를 골라 최대 네 장까지 더 읽습니다.
같은 기관 안에서만 움직이고, 로그인·약관·사이트맵은 따라가지 않습니다.

**② 요약이 강좌를 버리지 않습니다.**
이건 꼭 말씀드려야 합니다. 예전 요약 규칙에는 **강좌와 프로그램이 아예 없었습니다.**
금액·자격·신청방법·운영시간·전화번호만 남기라고 되어 있었고, 게다가
*"메뉴나 공지 목록이면 NOTHING 이라고 답하라"* 고 했습니다. **강좌표는 공지 목록처럼
생겼습니다.** 링크만 고치고 이걸 안 고쳤다면, 강좌를 애써 읽어 와서 이 단계에서 다시
버렸을 겁니다. 아무 오류도 없이, 조용히.

**③ 그림을 읽습니다.**
글이 얼마 없는 기관에서는 포스터를 그대로 받아쓰기 합니다. 요약이 아니라 받아쓰기입니다 —
시간표를 요약하면 시간표가 아니게 되니까요. 방배느티나무쉼터 10월 시간표 **2,182자**가
그렇게 들어왔습니다. 월~금, 어울림터·배움터·나눔터 세 곳, 시간대별 과목 전부입니다.

**④ 질문을 듣고 나서 필요한 대목을 꺼냅니다.**
요약 한 덩어리는 언제나 들고 있고, 거기에 더해 어르신이 물으신 것과 겹치는 원문 조각을
그때그때 찾아 넣습니다. **강좌 서른 개를 미리 열 줄로 줄여 놓지 않아도 되는 이유입니다.**
"무슨 강좌 있어요"와 "목요일 오후에 뭐 해요"가 같은 페이지에서 서로 다른 대목을 데려옵니다.

## 5. ⚠️ 그리고 하마터면 큰일 날 뻔한 것을 하나 잡았습니다

**이 항목을 제일 중요하게 봐 주셨으면 합니다.**

오늘 이 층을 처음 돌렸을 때, 방배느티나무쉼터 요약에 **주간 시간표 전체가 들어왔습니다.**
월요일 시니어발레, 화요일 요가교실, 수요일 K-트롯댄스… 실제 포스터와 **거의 맞았습니다.**

그런데 그때 읽어 온 3,211자 어디에도 '시니어발레'라는 글자는 **없었습니다.**
모델이 지어낸 것이었고, 지어낸 것이 **맞았습니다.**

**맞았다는 점이 더 위험합니다.** 대부분 맞으면 믿게 되고, 틀린 날에는 아무 표시도 나지
않습니다. 어르신이 화요일 열 시에 헛걸음을 하고 나서야 압니다. 실제로 지어낸 판과
나중에 포스터를 진짜로 읽은 판을 비교해 보니, 목요일 과목이 '캘리그라피'(지어냄) →
**'칼림바교실'(실제)** 로 달랐습니다. 딱 그만큼씩 틀립니다.

그래서 **기계 검사를 하나 넣었습니다.** 요약의 모든 줄을 실제로 읽어 온 글에 대고
맞춰 봅니다.

- **숫자는 하나도 틀리면 안 됩니다** — 금액·시각·전화번호는 어르신이 그대로 믿고
  움직이시는 것이라, 하나만 어긋나도 그 줄을 버립니다.
- 강좌 이름 같은 **고유한 말**이 원문에 없으면 그 줄을 버립니다.
- 모델을 한 번도 더 부르지 않습니다. 비용이 늘지 않습니다.

지금 상태에서 이 검사를 돌리면, 지어낸 시간표 줄은 **전부 걸러지고**, 서초50플러스센터의
진짜 강좌 열다섯 줄은 **하나도 걸리지 않습니다.** 포스터를 실제로 읽고 난 지금은
방배느티나무쉼터 시간표도 근거가 생겨서 그대로 남습니다.

## 6. 지금 이렇게 답합니다 (실제 출력입니다)

> **질문: 서초50플러스센터 강좌 프로그램 3개만 소개해 주세요**
>
> 안녕하세요, 어르신. 서초50플러스센터에 좋은 강좌들이 있어요. 어떤 강좌들이 있는지
> 몇 가지만 짧게 말씀드려 볼게요.
> '셔플댄스', '컬러로 이해하는 나와 타인', '아이패드로 그리는 어반드로잉' 같은 강좌들이
> 10월에 시작해요. 더 들어보시겠어요?

> **질문: 방배느티나무쉼터 10월 월요일에 무슨 프로그램 있어요?**
>
> 방배느티나무쉼터 월요일에는요, 시니어발레, 발레핏, 전신스트레칭, 밴드근력운동,
> 그리고 영어 수업들(스타트영어, 팝송영어교실, 미드영어회화)이랑 역사문화산책,
> 뎃생교실이 있어요.

> **질문: 셔플댄스 수강료가 얼마예요? 정원은 몇 명이에요?**
>
> 셔플댄스 수강료는 3만 원이고, 정원은 15명이에요. 신청은 9월 18일부터 10월 7일까지 받아요.

> **질문: 목요일 오후에 배울 수 있는 거 뭐 있나** *(카탈로그에 없는 말투로 물었을 때)*
>
> 목요일 오후에는 배움터에서 바리스타 배우실 수 있고, 나눔터에서는 보타니컬아트도
> 하실 수 있어요.

마지막 것은 **포스터 그림에서만 나오는 내용**입니다. 층 이름(배움터·나눔터)까지
그림 안에 있던 것입니다.

## 7. 탐님이 직접 확인해 보실 것

키오스크에서 그대로 물어봐 주세요.

1. `서초50플러스센터 강좌 프로그램 3개만 소개해 주세요`
   → 강좌 **이름 세 개**가 나와야 합니다. "여러 가지가 있어요"가 나오면 실패입니다.
2. `셔플댄스 수강료가 얼마예요?`
   → **30,000원, 정원 15명**이 나와야 합니다.
3. `방배느티나무쉼터 10월 월요일에 무슨 프로그램 있어요?`
   → 요일별 과목 이름이 나와야 합니다. 이건 **그림에서 읽은 것**입니다.
4. `목요일 오후에 배울 수 있는 거 뭐 있나`
   → 카탈로그 용어를 하나도 쓰지 않은 질문입니다. 그래도 답해야 합니다.
5. **일부러 없는 것을 물어봐 주세요** — 예: `방배느티나무쉼터 토요일에 뭐 해요?`
   → 시간표에 토요일이 없으므로, **없다고 말하고 전화번호를 알려드려야** 합니다.
   지어내면 그게 제일 큰 문제입니다. 이 항목을 꼭 같이 봐 주세요.

## 8. 아직 안 되는 것 — 솔직하게

- **표가 빽빽한 포스터는 칸을 한 줄 어긋나게 읽을 수 있습니다.** 시간표를 옮겨 적을 때
  `월 11:00-11:50 배움터(3층) 역사문화산책` 처럼 **칸마다 한 줄씩** 적게 해 두어서 사람이
  눈으로 대조할 수 있습니다. 다만 칸이 병합된 표에서는 과목이 10시인지 11시인지 한 칸
  밀릴 수 있습니다. **있지도 않은 과목을 지어내는 것과는 다른 종류의 오차**이고,
  §5 의 검사로는 잡히지 않습니다 — 그 과목은 실제로 그 표에 있기 때문입니다.
  그래서 이음이는 시간표를 말씀드린 뒤 **기관에 한 번 더 확인하시라고 권하고 전화번호를
  함께 알려드립니다.** 그 안내 문구는 그대로 두시는 편이 좋겠습니다.
- **PDF 와 한글 파일은 아직 안 읽습니다.** 셔틀버스 시간표처럼 첨부파일로만 있는 것이
  여기 걸립니다. 그림은 되고 PDF 는 아직입니다.
- **한 걸음만 따라갑니다.** 두 걸음부터는 기관 홈페이지 전체를 긁는 일이 되어,
  공개 페이지를 하루 한 번 읽는 것과는 성격이 달라집니다. 필요하다고 판단되면
  말씀 주십시오.
- **하루 한 번 갱신입니다.** 오늘 올라온 공지는 내일 아침에 반영됩니다. 실시간이
  필요한 것(오늘 문 연 약국 등)은 예정대로 공공 API 쪽 일입니다.
- **로그인해야 보이는 페이지는 못 읽습니다.** 앞으로도 읽지 않을 생각입니다.

---
---

# English version (for Play4 internal)

## What Tom asked

> "Is the link-content collection pipeline (crawling + vision + RAG) not built?"

Three things, three different answers. Honestly:

| | Before today |
|---|---|
| **Crawling** | **Half.** Fetch, the Korea relay, Chrome rendering and table parsing all worked. But it read **exactly one URL per service** — whatever the client's Excel said — and never followed a link out of it. |
| **Vision** | **Not built at all.** Non-HTML was discarded on the spot. No image ever reached a model. |
| **RAG** | **Not built.** The page was summarised to ~200 characters at ingest and the text was **thrown away**, so there was nothing to retrieve from. |

## His row-42 example was not a pipeline failure

The catalogue pointed at `50plus.or.kr/sch/index.do` — the **front door**. The pipeline read it
correctly: hours, phone, address, 2,208 characters. The courses are one click away at
`/sch/education.do`, which **yesterday's code already parses cleanly**: HTTP 200, 3,241
characters, the whole table with titles, dates, instructor, fee and capacity.

Nobody had ever followed the link. **25 of 70 catalogue links point at a bare homepage the same
way.** Median summary was 212 characters and 24 of them ended in *"this page doesn't say — call
them"*. That is Tom's complaint, quantified.

## Bangbae genuinely needed vision

Front door 1,039 characters; the "programme timetable" page **486 characters, every one of them
navigation**; the October schedule exists only as a JPG. Ieumi's "I can't know the detailed
timetable" was literally true, and no link fix reaches it.

## What was built

1. **One hop** — up to four sub-pages matching course/programme/timetable/apply/guide, same host
   only, skipping login and terms pages.
2. **The summariser keeps courses.** The old extraction rules **never mentioned courses at all**
   and told the model to answer `NOTHING` for "a notice list" — which is what a course table looks
   like. Fixing links without this would have thrown the courses away one step later, in silence.
3. **Poster transcription** where the text is thin — 2,182 characters of Bangbae's October
   timetable, every day, room and slot.
4. **Per-question retrieval** — the summary always travels, and the matching pieces of the raw page
   are added after the question is known, so thirty courses are not pre-compressed into ten lines.

## ⚠️ The important one: it was inventing timetables

On the first real run, the Bangbae summary came back holding a **full weekly timetable that very
nearly matched the real poster** — and the word 시니어발레 appeared **nowhere** in the 3,211
characters actually read. The model invented it, and was right.

Being right is the worse outcome: a fabrication that is usually correct earns trust and then fails
silently. Comparing the invented version against the later, genuinely-read poster, Thursday's class
was "캘리그라피" (invented) versus **"칼림바교실" (real)**. That is the size of the error.

So every summary line is now **checked mechanically against the text actually fetched**: every
number must be present (a wrong fee or time is what a senior acts on), and distinctive words like
course names must appear in the source. No extra model call, no added cost. Run against today's
data it drops **all** the invented timetable lines and **none** of the fifteen real course lines.

## Still not solved

- **A dense timetable grid can be read one row out.** Posters are transcribed one line per cell
  (`월 11:00-11:50 배움터(3층) 역사문화산책`) so a person can check them against the image, but where
  cells are merged a class can land at 10:00 instead of 11:00. This is a **different kind of error
  from inventing a class**, and the grounding check does not catch it — the class really is on that
  poster. Ieumi's closing advice to confirm with the organisation, and the phone number it reads
  out, are the mitigation; they should stay.
- **PDF and HWP attachments are not read** (shuttle-bus timetables live there). Images yes, PDFs
  not yet.
- **One hop only** — two would be crawling whole sites, a different proposition; say the word if
  it's wanted.
- **Daily refresh** — a notice posted today appears tomorrow morning.
- **Login-walled pages are not read**, and should not be.
