-- 003_jobs — 일자리 공고 저장 (data.go.kr 노인일자리 API)
--
-- Why the postings are stored rather than fetched during a conversation:
--
--   * The API has no region filter. Every query returns the same national list
--     (761k rows at the time of writing), so the only way to find a centre's
--     jobs is to hold them and filter here.
--   * A single API request takes 9-30 seconds. Nothing that slow can sit in the
--     path of a senior waiting for an answer (§3-6).
--   * There is a daily call limit on the key.
--
-- The feed is newest-first and goes back years, so a sync only walks the recent
-- pages and keeps what is still open.

CREATE TABLE IF NOT EXISTS jobs (
  id             text PRIMARY KEY,             -- the API's jobId
  title          text        NOT NULL,
  org            text        NOT NULL DEFAULT '',
  place          text        NOT NULL DEFAULT '',   -- as given: "서울 서초구"
  sido           text        NOT NULL DEFAULT '',   -- "서울"
  sigungu        text        NOT NULL DEFAULT '',   -- "서초구"
  deadline       text        NOT NULL DEFAULT '',   -- "접수중"
  from_date      date,
  to_date        date,
  apply_method   text        NOT NULL DEFAULT '',
  min_age        integer,
  headcount      integer,
  address        text        NOT NULL DEFAULT '',
  contact_name   text        NOT NULL DEFAULT '',
  contact_phone  text        NOT NULL DEFAULT '',
  source         text        NOT NULL DEFAULT '',   -- "워크넷" etc
  has_detail     boolean     NOT NULL DEFAULT false, -- address/phone come from a second call
  synced_at      timestamptz NOT NULL DEFAULT now()
);

-- The kiosk asks "what is open near this centre", so that is what is indexed.
CREATE INDEX IF NOT EXISTS jobs_region_idx ON jobs (sido, sigungu, to_date DESC);
CREATE INDEX IF NOT EXISTS jobs_open_idx   ON jobs (to_date DESC) WHERE deadline = '접수중';

-- One row, so the dashboard can show when the data was last refreshed and
-- whether the last run failed.
CREATE TABLE IF NOT EXISTS job_sync_state (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at  timestamptz,
  finished_at timestamptz,
  scanned     integer NOT NULL DEFAULT 0,
  stored      integer NOT NULL DEFAULT 0,
  detailed    integer NOT NULL DEFAULT 0,
  error       text
);
INSERT INTO job_sync_state (id) VALUES (1) ON CONFLICT DO NOTHING;
