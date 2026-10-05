-- 011_qa_cache — 이음이 QA 캐시 (Phase A: 임베딩 없는 정규화 매칭)
--
-- 설계: docs/이음이-시맨틱캐시-설계.md
-- 원본 로직: Play4HQ/ai-avatar-core 의 avatar_chat_semantic_cache 를 단순화해 포팅.
--   원본은 pgvector(vector 1536) 기반(Phase B). 여기서는 먼저 정규화 완전일치로
--   "반복 질문이 실제로 얼마나 되는지(히트율)" 를 재고, 높을 때만 임베딩을 올립니다.
--
-- 안전 설계(라이브 프로덕션):
--   · center_id 로 복지관별 완전 분리 — 한 복지관 답이 다른 곳으로 새지 않음
--   · prompt_hash = buildSystem(persona) 의 SHA-256 — 프롬프트·서비스 목록이 바뀌면
--     옛 캐시가 저절로 안 맞게 됨(자동 무효화)
--   · expires_at 로 TTL — 오래된 답은 만료
--   · 변동 주제(날씨·일자리·오늘/지금)는 애초에 저장하지 않음(앱 레벨에서 걸러짐)

CREATE TABLE IF NOT EXISTS qa_cache (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  center_id     uuid        NOT NULL REFERENCES centers(id) ON DELETE CASCADE,
  prompt_hash   varchar(64) NOT NULL,
  normalized_q  text        NOT NULL,
  answer        text        NOT NULL,
  service_code  text,
  hit_count     integer     NOT NULL DEFAULT 0,
  last_hit_at   timestamptz,
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Phase A 조회 키: 같은 복지관 + 같은 프롬프트 지문 + 같은 정규화 질문이면 한 줄.
  CONSTRAINT uq_qa_cache UNIQUE (center_id, prompt_hash, normalized_q)
);
CREATE INDEX IF NOT EXISTS idx_qa_cache_lookup ON qa_cache (center_id, prompt_hash, normalized_q);
CREATE INDEX IF NOT EXISTS idx_qa_cache_expires ON qa_cache (expires_at);

-- 매 조회의 결과(히트/미스/우회)를 남겨 히트율을 측정합니다 — 그림자 모드의 핵심.
-- 답변 전문은 넣지 않습니다(이미 qa_cache 에 있음). 커지면 stats 스크립트가 정리.
CREATE TABLE IF NOT EXISTS qa_cache_event (
  id            bigserial   PRIMARY KEY,
  center_id     uuid,
  normalized_q  text        NOT NULL DEFAULT '',
  decision      text        NOT NULL,          -- hit | miss | bypass
  reason        text,                          -- bypass 사유 또는 hit 시 유사도 정보
  mode          text        NOT NULL DEFAULT 'shadow',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qa_cache_event_time ON qa_cache_event (created_at);
