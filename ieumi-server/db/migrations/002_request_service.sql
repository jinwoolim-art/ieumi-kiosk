-- 002_request_service — record which catalogue service each call was about.
--
-- The kiosk now knows the centre's service list (§6-P1), so it can say which of
-- the ~59 services a caller actually asked for. Knowing which services seniors
-- really use, per centre, is the data the operating fee is grounded in (§1-3),
-- and it is what tells a centre which of its 59 selections were worth enabling.
--
-- Stored as the service's stable code rather than a foreign key: a centre may
-- later disable or replace a service, and the history of what was asked for
-- should survive that.

ALTER TABLE requests ADD COLUMN IF NOT EXISTS service_code text;

CREATE INDEX IF NOT EXISTS requests_service_idx
  ON requests (center_id, service_code)
  WHERE service_code IS NOT NULL;
