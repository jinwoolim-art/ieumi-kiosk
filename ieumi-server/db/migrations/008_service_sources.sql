-- 008_service_sources — 링크의 내용을 실제로 읽어 둡니다.
--
-- 지금까지 이음이가 서비스에 대해 아는 것은 카탈로그 한 줄이 전부였습니다. 기관
-- 이름과 주소는 있지만 그 주소를 열어 본 적이 없어서, "생계비 얼마 나와요?" 처럼
-- 어르신이 실제로 묻는 것에는 언제나 "담당 선생님께 여쭤볼게요" 로만 답했습니다.
-- 클라이언트의 지적 그대로입니다: 그 상태의 이음이는 물어볼 이유가 없습니다.
--
-- Until now Ieumi held a catalogue row and a URL it had never opened, so every
-- question a senior actually asks — how much, who qualifies, when is it open —
-- ended at "I'll ask the staff member". This table is where the page behind the
-- link finally lands.
--
-- `facts` is not the page. It is a short, prompt-ready extract made once at
-- ingest time, because putting a 220KB district page into a conversation turn is
-- not an option. Extraction happens on a schedule; the conversation only reads.
--
-- `fetched_at` travels into the prompt with the facts. Ieumi has to be able to
-- say when something was checked — an amount quoted with no date is the same
-- confident-but-stale answer this project has been avoiding from the start.
CREATE TABLE IF NOT EXISTS service_sources (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id    uuid        NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  url           text        NOT NULL,

  fetched_at    timestamptz,
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','ok','empty','error')),
  http_status   integer,
  error         text,

  -- 내용이 그대로면 다시 요약하지 않습니다 — re-summarising an unchanged page is
  -- a model call for nothing, and these run daily across every centre.
  content_hash  text,
  raw_chars     integer,

  facts         text,
  facts_en      text,
  fact_chars    integer,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, url)
);

CREATE INDEX IF NOT EXISTS service_sources_service_idx ON service_sources (service_id);
CREATE INDEX IF NOT EXISTS service_sources_stale_idx   ON service_sources (fetched_at);
