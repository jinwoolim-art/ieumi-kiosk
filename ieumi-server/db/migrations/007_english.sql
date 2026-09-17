-- 007_english — 목록을 영어로도 읽을 수 있게.
--
-- 화면의 글자(버튼·안내문)는 i18n.js 사전이 바꿉니다. 그러나 서비스 이름과 설명은
-- 클라이언트가 준 자료이고, 자료의 언어는 사전이 아니라 자료가 들고 있어야 합니다.
-- 사전에 넣으면 카탈로그 사본이 하나 더 생겨서 조용히 어긋납니다.
--
-- The UI chrome is translated by a dictionary at render time. The catalogue is
-- not chrome — it is the client's own content, and its language belongs with the
-- row. Putting 60 service descriptions into the UI dictionary would create a
-- second copy of the catalogue that drifts the moment anyone imports a revision.
--
-- 왜 필요한가: 개발자가 한국어를 읽지 못합니다. 읽지 못하는 화면은 시험할 수
-- 없고, 시험하지 못한 것은 클라이언트가 처음 발견하게 됩니다 — 지금까지 그랬습니다.
--
-- Nullable on purpose. English is a convenience for whoever cannot read Korean;
-- Korean is the source of truth and every one of these may be NULL forever
-- without anything breaking. Readers fall back to the Korean column.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS sub_en         text,
  ADD COLUMN IF NOT EXISTS description_en text,
  ADD COLUMN IF NOT EXISTS keywords_en    text,
  ADD COLUMN IF NOT EXISTS org_en         text,
  ADD COLUMN IF NOT EXISTS category_en    text;

-- 복지관 이름도 화면 곳곳에 나옵니다 — the centre's name sits in every header.
ALTER TABLE centers
  ADD COLUMN IF NOT EXISTS name_en text;
