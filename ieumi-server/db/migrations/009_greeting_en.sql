-- 009_greeting_en — 첫인사도 영어로.
--
-- 인사말은 복지관이 직접 써넣는 자료입니다. 화면 글자를 바꾸는 사전이 건드리지
-- 않는 것이 맞고, 실제로 건드리지 않았습니다 — 그래서 영어로 열어도 어르신이
-- 처음 듣는 한 문장만 한국어로 남아 있었습니다.
--
-- The greeting is content a centre writes for itself, so the UI dictionary
-- rightly leaves it alone — which left the very first thing a caller hears as
-- the one untranslated line on an otherwise English screen.
--
-- NULL 이면 기본 영어 인사를 씁니다. Nullable: with nothing here the kiosk falls
-- back to a neutral English greeting built from the centre's own Ieumi name,
-- so this never has to be filled in for English mode to work.
ALTER TABLE center_settings
  ADD COLUMN IF NOT EXISTS greeting_en text;
