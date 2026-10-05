// 이음이 QA 캐시 (Phase A) — 반복되는 비변동 질문의 답을 재사용해 LLM 호출(=비용)을 줄인다.
//
// 설계: docs/이음이-시맨틱캐시-설계.md  (Phase A = 임베딩 없는 정규화 매칭 → 히트율 측정 → 높으면 Phase B)
// 원본: Play4HQ/ai-avatar-core 의 avatar-chat-semantic-cache (NestJS). 그 구조를 단순 Node 로 옮김.
//   - 센터별 분리(원본 avatarId → center_id), prompt_hash(시스템 프롬프트 SHA-256), TTL, 우회 사유 로깅.
//   - 임베딩/pgvector 는 Phase B 로 미룸.
//
// 모드 (env QA_CACHE_MODE):
//   off    — 아무것도 안 함(기본). 운영에 영향 0.
//   shadow — 조회·기록만. 답변은 "항상 LLM" 그대로 내보내고, "캐시로 답할 수 있었는지"만 로그/적재.
//            → 라이브에서 안전하게 히트율·오매칭을 재는 단계. 크레딧 추가 소모 0(임베딩 없음).
//   on     — 히트하면 저장된 답을 바로 반환(LLM 생략 = 비용 절감). shadow 로 충분히 검증한 뒤에만.
//
// 안전 원칙: 어떤 오류도 대화를 막지 않는다. 모든 공개 함수는 try/catch 로 감싸 best-effort.
const crypto = require('crypto');
const db = require('./db');

const MODE = () => (process.env.QA_CACHE_MODE || 'off').toLowerCase();
const TTL_DAYS = Number(process.env.QA_CACHE_TTL_DAYS || 7);
const MIN_LEN = Number(process.env.QA_CACHE_MIN_LEN || 4);
const MAX_LEN = Number(process.env.QA_CACHE_MAX_LEN || 120);

// 변동(캐시 금지) 주제 — 설계 6번. 확실하지 않으면 캐시하지 않습니다(보수적).
// 날씨·실시간, 오늘/지금/내일, 일자리(매일 바뀜), 당번약국·문 연 곳 등.
const VOLATILE = /날씨|기온|비가|비\s*오|더위|더워|추위|추워|추운|미세먼지|황사|오늘|지금|내일|모레|이번\s*주|이번주|당번|문\s*연|문연|열려|열린|실시간|몇\s*시|일자리|일거리|구인|채용|근무|급여|시급|일\s*있|일\s*구|자리\s*있|자리\s*없|모집/;

// 정규화 — 공백·문장부호 제거 + NFC + 소문자화 (설계 Phase A). 조사 제거는 뜻을 바꿀 수 있어
// 보수적으로 빼지 않습니다(히트율을 보고 다음에 조정). 한글/숫자/영문자만 남깁니다.
function normalize(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// prompt_hash — buildSystem(persona) 의 SHA-256. 프롬프트 규칙·서비스 목록이 바뀌면
// 값이 달라져 옛 캐시가 저절로 안 맞게 됩니다(자동 무효화). 참조 구현과 같은 방식.
function promptHash(fixedPrompt) {
  return crypto.createHash('sha256').update(String(fixedPrompt || '')).digest('hex');
}

function isVolatile(text) {
  return VOLATILE.test(String(text || ''));
}

// 조회/저장 자격. null 이면 가능, 문자열이면 그 사유로 우회.
function eligibilityReason({ centerId, normalized, volatile }) {
  if (MODE() === 'off') return 'disabled';
  if (!centerId) return 'no_center';
  if (!normalized) return 'empty';
  if (volatile) return 'volatile';
  if (normalized.length < MIN_LEN) return `too_short(${normalized.length}<${MIN_LEN})`;
  if (normalized.length > MAX_LEN) return `too_long(${normalized.length}>${MAX_LEN})`;
  return null;
}

const expiresAt = () => (TTL_DAYS > 0 ? new Date(Date.now() + TTL_DAYS * 86400_000) : null);

// 조회 — Phase A: 센터 + 프롬프트 지문 + 정규화 질문 완전일치.
async function lookup({ centerId, normalized, promptHash: ph }) {
  const rows = await db.all(
    `SELECT id, answer, service_code
       FROM qa_cache
      WHERE center_id = $1 AND prompt_hash = $2 AND normalized_q = $3
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [centerId, ph, normalized],
  );
  return rows[0] || null;
}

async function store({ centerId, normalized, promptHash: ph, answer, serviceCode }) {
  await db.query(
    `INSERT INTO qa_cache (center_id, prompt_hash, normalized_q, answer, service_code, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (center_id, prompt_hash, normalized_q)
     DO UPDATE SET answer = EXCLUDED.answer, service_code = EXCLUDED.service_code,
                   expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [centerId, ph, normalized, answer, serviceCode || null, expiresAt()],
  );
}

async function markHit(id) {
  await db.query(
    `UPDATE qa_cache SET hit_count = hit_count + 1, last_hit_at = now() WHERE id = $1`, [id],
  );
}

async function logEvent({ centerId, normalized, decision, reason }) {
  await db.query(
    `INSERT INTO qa_cache_event (center_id, normalized_q, decision, reason, mode)
     VALUES ($1,$2,$3,$4,$5)`,
    [centerId || null, (normalized || '').slice(0, 120), decision, reason || null, MODE()],
  );
}

/**
 * 한 턴의 캐시 조회. 대화 흐름에 끼워 넣기 쉽게, 다음 셋 중 하나를 돌려줍니다.
 *   { skip: true }                         — off 거나 조회할 것 없음(아무 기록 안 함)
 *   { hit, answer, serviceCode, meta }     — 캐시 히트
 *   { hit:false, store, meta }             — 미스(답을 만든 뒤 store(answer, serviceCode) 호출)
 * 어떤 경우에도 예외를 던지지 않습니다. 오류는 { skip:true } 로 조용히 넘어갑니다.
 */
async function forTurn({ centerId, text, fixedPrompt }) {
  const mode = MODE();
  if (mode === 'off') return { skip: true };
  try {
    const normalized = normalize(text);
    const volatile = isVolatile(text);
    const reason = eligibilityReason({ centerId, normalized, volatile });
    if (reason) {
      await logEvent({ centerId, normalized, decision: 'bypass', reason }).catch(() => {});
      return { skip: true };
    }
    const ph = promptHash(fixedPrompt);
    const found = await lookup({ centerId, normalized, promptHash: ph });
    if (found) {
      await logEvent({ centerId, normalized, decision: 'hit', reason: found.id }).catch(() => {});
      await markHit(found.id).catch(() => {});
      // shadow 에서는 히트해도 "히트할 수 있었다"만 기록하고 LLM 답을 쓰게 합니다.
      if (mode === 'shadow') return { skip: true, wouldHit: true };
      return { hit: true, answer: found.answer, serviceCode: found.service_code };
    }
    await logEvent({ centerId, normalized, decision: 'miss' }).catch(() => {});
    // 미스 — 답을 만든 뒤 적재할 수 있게 store 핸들을 돌려줍니다(shadow/on 공통).
    return {
      hit: false,
      store: (answer, serviceCode) =>
        store({ centerId, normalized, promptHash: ph, answer, serviceCode }).catch(() => {}),
    };
  } catch {
    return { skip: true };
  }
}

module.exports = {
  forTurn, normalize, promptHash, isVolatile, eligibilityReason,
  lookup, store, markHit, logEvent, MODE,
};
