-- 005_service_links — where a service actually sends someone (client list V03).
--
-- The catalogue until now described a service but could not point at it: no
-- organisation, no link. That is the whole of what the client's V03 file adds
-- to the 59 rows already seeded, and without these columns their data has
-- nowhere to land.
--
-- update_method records how a row is kept current, which is an operational
-- fact rather than a decoration: 'manual' is a centre typing it in, and the
-- other two are code that has to exist and keep working. A centre reading its
-- own catalogue can see which of its entries depend on something that can go
-- stale silently.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS org  text NOT NULL DEFAULT '',   -- 방배노인종합복지관
  ADD COLUMN IF NOT EXISTS link text NOT NULL DEFAULT '';   -- https://www.bbsenior.org/

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS update_method text NOT NULL DEFAULT 'manual';

-- Added separately so re-running against a database that already has the column
-- does not fail on a duplicate constraint name.
DO $$
BEGIN
  ALTER TABLE services ADD CONSTRAINT services_update_method_chk
    CHECK (update_method IN ('manual', 'realtime_api', 'scraping'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- A centre inherits the common row and may point somewhere closer to home:
-- the nationwide entry for 노인장기요양보험 is right, but a centre may prefer its
-- own district office. NULL means "inherit", exactly like the existing overrides.
ALTER TABLE center_services
  ADD COLUMN IF NOT EXISTS override_org  text,
  ADD COLUMN IF NOT EXISTS override_link text;
