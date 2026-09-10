-- 004_job_region_source — how a posting's region was determined.
--
-- Two sources, and they are not equally trustworthy:
--
--   'api'     — the feed's own workPlcNm ("서울 서초구"). This is the work location.
--   'address' — recovered from the detail call's postal address when workPlcNm
--               was blank. That address is the EMPLOYER's office, which is often
--               but not always where the work is. A real example: an agency at
--               서울 강서구 advertising a caretaker post in 마장면, 이천.
--
-- A senior may travel to what Ieumi names, so only 'api' regions are used to
-- decide which postings belong to a centre. Address-derived regions are kept —
-- they are useful for the dashboard and for a future title/address cross-check —
-- but they never place a job in a district on their own.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS region_source text NOT NULL DEFAULT 'api'
  CHECK (region_source IN ('api', 'address'));

-- Existing rows that already had a region came from the feed; anything filled in
-- by the address backfill is corrected by the next sync.
CREATE INDEX IF NOT EXISTS jobs_region_trusted_idx
  ON jobs (sido, sigungu, to_date DESC)
  WHERE region_source = 'api';
