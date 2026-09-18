-- 010_source_pages — 링크 한 장이 아니라, 그 링크가 이끄는 곳까지.
--
-- 008 에서 링크를 <열기> 시작했습니다. 그런데 클라이언트가 2026-09-18 에 짚은 것은
-- 그다음 문제였습니다: 서초50플러스센터 강좌 세 개를 소개해 달라고 했는데 이음이가
-- 답하지 못했습니다. 이유는 파이프라인이 고장난 것이 아니라, 카탈로그의 주소가
-- <한 페이지 얕았기> 때문입니다.
--
--   50plus.or.kr/sch/index.do      — 대문. 운영시간·전화·주소. 2,208자.
--   50plus.or.kr/sch/education.do  — 강좌표. 제목·모집기간·강사·수강료·정원. 3,241자.
--
-- 두 번째 주소는 <지금 코드로도 멀쩡히 읽힙니다.> 아무도 거기까지 가 보지 않았을
-- 뿐입니다. 카탈로그 링크 일흔 개 중 스물다섯 개가 이렇게 대문을 가리킵니다.
--
-- The client asked Ieumi to name three courses and it could not. The pipeline was
-- not broken: the catalogue URL was one page too shallow. The course table one
-- click away parses cleanly with the code that already shipped, and 25 of 70
-- links point at a bare homepage the same way.
--
-- 그래서 이 표는 이제 <서비스마다 여러 장>을 담습니다. kind 가 그 장이 어디서
-- 왔는지 말해 줍니다:
--   landing  카탈로그에 적힌 그 주소
--   subpage  거기서 한 번 따라간 곳 (강좌·시간표·신청 안내 등)
--   image    글이 아니라 그림으로만 있는 것 — 포스터를 눈으로 읽은 결과
--
-- 방배느티나무쉼터가 image 가 필요한 이유입니다: '프로그램 시간표' 페이지는 486자,
-- 그 486자가 전부 메뉴입니다. 10월 시간표는 JPG 한 장으로만 존재합니다. 링크를
-- 아무리 고쳐도 닿지 않습니다.
--
-- Bangbae's timetable page is 486 characters and every one of them is navigation;
-- the October schedule exists only as a JPG. No link fix reaches it, which is why
-- 'image' is a kind of its own rather than a flag.
ALTER TABLE service_sources
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'landing',
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS parent_url text;

DO $$
BEGIN
  ALTER TABLE service_sources ADD CONSTRAINT service_sources_kind_chk
    CHECK (kind IN ('landing', 'subpage', 'image'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 읽어 온 글 자체를 남깁니다.
--
-- 008 은 요약만 남기고 원문을 버렸습니다. 그때는 맞는 선택이었습니다 — 220KB 를
-- 대화에 넣을 수는 없으니까요. 하지만 버린 탓에 <나중에 다시 찾아볼 수가> 없습니다.
-- 강좌 서른 개가 있는 표를 열 줄로 줄이면, 어느 열 줄을 고르든 스무 개는 사라집니다.
-- 어르신이 무엇을 물으실지 모르는 채로 미리 고르는 일이기 때문입니다.
--
-- 그래서 요약은 요약대로 두고 (facts — 지금까지처럼 프롬프트에 항상 들어갑니다),
-- 원문은 원문대로 남겨 질문이 들어온 <뒤에> 필요한 대목만 꺼내 씁니다.
--
-- 008 kept only the summary and threw the page away. That was right for a 220KB
-- district page, but it means a table of thirty courses gets pre-compressed to ten
-- lines before anyone knows which course will be asked about. The summary stays
-- (it is what the prompt always carries); the text stays too, so the part that
-- answers a particular question can be fetched after the question exists.
ALTER TABLE service_sources
  ADD COLUMN IF NOT EXISTS text text;

CREATE INDEX IF NOT EXISTS service_sources_kind_idx ON service_sources (service_id, kind);

-- 질문이 들어온 뒤에 꺼내 쓰는 조각들.
--
-- 한 페이지를 통째로 프롬프트에 넣을 수는 없고, 열 줄로 줄이면 내용이 사라집니다.
-- 가운데를 택합니다: 페이지를 제목 단위로 잘라 두고, 질문과 겹치는 조각만 넣습니다.
-- '강좌 3개 소개해 줘' 에는 강좌표 조각이, '몇 시에 하나요' 에는 시간표 조각이
-- 들어갑니다. 같은 서비스인데 질문마다 다른 것이 들어갑니다.
--
-- heading 을 따로 두는 것은 점수를 매길 때 제목이 본문보다 무겁기 때문입니다.
-- '2026년 2학기 강좌' 라는 제목 한 줄이, 본문 어딘가에 '강좌' 가 스치는 것보다
-- 훨씬 강한 신호입니다.
--
-- A whole page will not fit in a turn and ten lines lose the content, so the page
-- is cut at its headings and only the pieces that overlap the question go in. The
-- heading is stored apart because it scores heavier than the body: a section
-- titled "2026 autumn courses" is a stronger signal than the word "course"
-- brushing past somewhere in a paragraph.
CREATE TABLE IF NOT EXISTS source_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id)        ON DELETE CASCADE,
  source_id   uuid NOT NULL REFERENCES service_sources(id) ON DELETE CASCADE,

  url         text NOT NULL,
  title       text,
  kind        text NOT NULL DEFAULT 'landing',

  ord         integer NOT NULL DEFAULT 0,
  heading     text,
  body        text NOT NULL,
  chars       integer NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_chunks_service_idx ON source_chunks (service_id);
CREATE INDEX IF NOT EXISTS source_chunks_source_idx  ON source_chunks (source_id);
