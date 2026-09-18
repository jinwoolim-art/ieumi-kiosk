// 키오스크 컨텍스트 — everything a kiosk needs to speak as its own center:
// the persona (§3-5) and the services that center has switched on, in the order
// the dashboard put them (§3-2, §6-P1).
//
// Cached for a short while because every conversation turn needs it and the
// values only change when someone edits the dashboard — which busts the entry.
// Without the cache each turn pays two extra database round trips, and §3-6 is
// explicit that a second of delay is what makes the conversation awkward.
const db = require('./db');

const TTL_MS = Number(process.env.KIOSK_CONTEXT_TTL_MS || 60_000);
const cache = new Map();   // kiosk token -> { at, value }

const DEFAULT_PERSONA = {
  ieumi_name: '이음이',
  center_name: '어르신 행복이음 센터',
  tone: 'warm',
  region: '',
  services: [],
};

// One round trip: the center, its settings, and its enabled services.
const SQL = `
  SELECT c.id AS center_id, c.name AS center_name, c.name_en AS center_name_en, c.region,
         s.ieumi_name, s.tone, s.voice_speaker, s.voice_speed, s.chat_model,
         s.general_answers,
         s.greeting, s.greeting_en, s.roster_check_on,
         COALESCE(svc.list, '[]'::json) AS services
    FROM centers c
    LEFT JOIN center_settings s ON s.center_id = c.id
    LEFT JOIN LATERAL (
      SELECT json_agg(
               json_build_object(
                 -- 조각을 꺼내 올 때 쓰는 열쇠입니다 (retrieval.js). 이 목록이
                 -- 곧 <이 복지관이 켜 둔 서비스>이므로, 여기서 나온 id 로만
                 -- 찾으면 다른 복지관의 자료에는 닿을 수 없습니다 (§3-1).
                 -- This list *is* the centre's switched-on services, so keying
                 -- retrieval off these ids is the tenant boundary itself.
                 'id', sv.id,
                 'code', sv.code,
                 'category', sv.category,
                 'sub', COALESCE(cs.override_sub, sv.sub),
                 'description', COALESCE(cs.override_description, sv.description),
                 'org', COALESCE(cs.override_org, sv.org),
                 'link', COALESCE(cs.override_link, sv.link),
                 'keywords', sv.keywords,
                 'category_en', sv.category_en,
                 'sub_en', sv.sub_en,
                 'description_en', sv.description_en,
                 'org_en', sv.org_en,
                 -- 링크에서 읽어 온 사실 — 카탈로그를 대체하지 않고 그 위에 얹힙니다.
                 -- What the linked page actually says. It rides alongside the
                 -- catalogue row, never instead of it, so a service whose page
                 -- could not be read still answers from the catalogue.
                 'facts', src.facts,
                 'facts_en', src.facts_en,
                 'facts_at', to_char(src.fetched_at, 'YYYY-MM-DD'))
               ORDER BY cs.sort_order) AS list
        FROM center_services cs
        JOIN services sv ON sv.id = cs.service_id
        LEFT JOIN LATERAL (
          SELECT facts, facts_en, fetched_at FROM service_sources
           WHERE service_id = sv.id AND status = 'ok' AND facts IS NOT NULL
             AND kind = 'landing'
           ORDER BY fetched_at DESC LIMIT 1
        ) src ON true
       WHERE cs.center_id = c.id AND cs.enabled = true AND sv.active = true
    ) svc ON true
   WHERE c.kiosk_token = $1 AND c.active = true`;

/**
 * Resolve a kiosk token to its center's persona and service list.
 * An unknown token, or no token at all, yields the neutral default so a kiosk
 * opened without one still talks instead of failing.
 */
async function forToken(token) {
  if (!token) return { ...DEFAULT_PERSONA };

  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  try {
    const row = await db.one(SQL, [String(token)]);
    const value = row
      ? { ...DEFAULT_PERSONA, ...row, services: row.services || [] }
      : { ...DEFAULT_PERSONA };
    cache.set(token, { at: Date.now(), value });
    return value;
  } catch {
    // A database hiccup must not mute the kiosk mid-conversation; fall back to
    // whatever was cached, and to the default persona if there is nothing.
    return hit ? hit.value : { ...DEFAULT_PERSONA };
  }
}

/** Drop the cached entry for a center after its settings or services change. */
function bust(centerId) {
  for (const [token, entry] of cache) {
    if (entry.value && entry.value.center_id === centerId) cache.delete(token);
  }
}

const bustAll = () => cache.clear();

module.exports = { forToken, bust, bustAll, DEFAULT_PERSONA, TTL_MS };
