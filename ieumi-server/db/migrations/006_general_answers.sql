-- 006_general_answers — may Ieumi answer from general knowledge?
--
-- The client asked for it directly: "답변이 리스트를 우선적으로 답변을 하고
-- 리스트에 없는 경우 범용적인 지식이 답변이 되어야 합니다" — answer from the
-- catalogue first, and from general knowledge where the catalogue is silent.
--
-- It is a switch rather than a constant because the same client marks 건강·의료
-- as awaiting legal review. If that review comes back badly, turning this off has
-- to be a checkbox a centre can reach, not a redeploy. Default on, which is what
-- was asked for.
ALTER TABLE center_settings
  ADD COLUMN IF NOT EXISTS general_answers boolean NOT NULL DEFAULT true;
