// 링크의 내용을 읽어 두는 층 — the layer that finally opens the links.
//
// 카탈로그는 "그 서비스가 무엇인가" 를 담고, 여기는 "지금 어떤가" 를 담습니다.
// 둘은 서로를 대체하지 않습니다 (클라이언트가 못박은 요구사항): 카탈로그 행은
// 그대로 있고, 여기서 읽어 온 사실이 그 위에 얹힙니다. API 가 죽어 있거나 페이지를
// 못 읽어도 카탈로그가 받쳐 주므로, 어르신이 아무 답도 못 받는 일은 없습니다.
//
// The catalogue says what a service *is*; this says what it *is right now*. They
// are layers on the same row, never alternatives — when a fetch fails the
// catalogue still answers, so a senior is never met with silence.
//
// 세 단계로 나뉩니다: 가져오기 → 글만 추리기 → 사실만 요약. 요약이 대화 중이 아니라
// 수집할 때 한 번 일어나는 것이 핵심입니다. 서초구청 페이지 하나가 220KB 인데,
// 그것을 매 turn 프롬프트에 넣을 수는 없습니다.
//
// Three stages: fetch, strip to text, summarise to facts. The summarise step runs
// at ingest and not in the conversation — one district page is 220KB, and §3-6
// forbids that kind of work inside a turn.
const crypto = require('crypto');
const db = require('./db');
const env = require('./env');
const render = require('./render');
const { pfetch } = require('./proxy-fetch');

// 브라우저와 같은 신원으로 요청합니다 — 봇 이름을 쓰면 아예 거부하는 사이트가
// 있습니다 (fss.or.kr 이 그랬습니다: 봇 UA 는 소켓 끊김, 브라우저 UA 는 HTTP 200).
// 사람이 직접 열어 보는 것과 같은 공개 페이지를, 하루 한 번 읽습니다.
//
// Some of these sites refuse an unrecognised user-agent outright — measured:
// fss.or.kr dropped the socket for a bot string and returned 200 for a browser
// one. These are public pages the client asked us to read, once a day.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_BYTES = 3_000_000;
const FETCH_MS = 40_000;   // 한국 공공기관 서버는 느립니다 — 25초로는 모자랐습니다

// ---------------------------------------------------------------- ① 가져오기
//
// 한 번 더 시도합니다 — 처음 돌렸을 때 '연결 실패' 11건 중 여러 건이 그 자리에서
// 다시 열어 보면 멀쩡했습니다. 한국 공공기관 서버는 느리고 가끔 연결을 끊습니다.
// 재시도가 없으면 그 서비스는 그날 하루 자료 없이 지내게 됩니다.
//
// Several of the first run's "fetch failed" results answered HTTP 200 when tried
// again seconds later. Korean government hosts are slow and drop connections;
// without a retry a service simply goes without facts for the day over a blip.
const RETRIES = 3;

async function fetchPage(url, attempt = 0) {
  try {
    return await fetchOnce(url);
  } catch (e) {
    const why = String((e.cause && (e.cause.code || e.cause.message)) || e.message || '');
    // EAI_AGAIN 은 DNS 가 잠깐 안 되는 것이고, 나머지는 연결이 끊긴 것입니다.
    // 둘 다 다음 번에는 되는 일이 흔합니다 — 실제로 sync 에서 실패한 주소를 손으로
    // 열어 보면 HTTP 200 이 나오는 경우가 여럿 있었습니다.
    //
    // Sites that failed during a sync answered HTTP 200 when poked by hand
    // moments later. One retry was not enough; these hosts are simply slow and
    // drop connections under any load.
    const transient = /timeout|abort|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|network|fetch failed/i
      .test(why);
    if (attempt < RETRIES - 1 && transient) {
      await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
      return fetchPage(url, attempt + 1);
    }
    throw e;
  }
}

// 한국 중계를 거칠 것인가.
//
// KOREA_RELAY_URL 이 설정되어 있으면 페이지를 그 서버에게 대신 열어 달라고
// 부탁합니다. 한국 사이트 상당수가 해외 IP 를 막기 때문입니다 (열두 곳 확인).
// 설정이 없으면 예전 그대로 직접 엽니다 — 한국에서 돌릴 때는 중계가 필요 없습니다.
//
// With KOREA_RELAY_URL set, pages are fetched through a small relay running in
// Korea (korea-relay.js); without it, directly, exactly as before. Only the
// page-reading job needs this — Claude, CLOVA and data.go.kr all answer from
// anywhere, so nothing else changes.
const RELAY = (env.KOREA_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_TOKEN = env.KOREA_RELAY_TOKEN || '';

// 글이 얼마나 들어 있는지 — 껍데기인지 아닌지 가늠하는 데만 씁니다.
// extractText 를 쓰지 않는 것은, 이 판단이 본문 추출보다 먼저 와야 하기 때문입니다.
const textLength = (html) => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

async function relayFetch(url, { render: wantRender = false } = {}) {
  const q = `url=${encodeURIComponent(url)}${wantRender ? '&render=1' : ''}`;
  // 중계는 프록시 뒤에서도 닿아야 합니다 — node 의 fetch 는 HTTPS_PROXY 를
  // 무시하므로 여기서는 pfetch 를 씁니다.
  const r = await pfetch(`${RELAY}/fetch?${q}`, {
    headers: RELAY_TOKEN ? { 'x-relay-token': RELAY_TOKEN } : {},
    timeoutMs: FETCH_MS + 60_000,
  });
  if (!r.ok) {
    const why = await r.json().catch(() => ({}));
    throw new Error('relay ' + r.status + ' ' + String(why.error || '').slice(0, 80));
  }
  // 중계는 바이트 그대로와 원래 content-type 을 따로 돌려줍니다 (EUC-KR 보존).
  return {
    status: Number(r.headers.get('x-relay-status')) || 200,
    type: r.headers.get('x-relay-content-type') || '',
    buf: Buffer.from(await r.arrayBuffer()),
  };
}

async function directFetch(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(FETCH_MS),
    redirect: 'follow',
  });
  return {
    status: r.status,
    type: r.headers.get('content-type') || '',
    buf: Buffer.from(await r.arrayBuffer()),
  };
}

// 그냥 받아왔을 때 글이 이보다 적으면, 브라우저로 한 번 더 열어 봅니다.
// 내용이 있는 페이지는 400자를 훌쩍 넘습니다 — 이보다 적다는 것은 대개
// 자바스크립트가 채우기 전의 빈 껍데기라는 뜻입니다.
const THIN_CHARS = Number(env.RENDER_THIN_CHARS || 400);

// 브라우저로 여는 것은 <필요할 때만> 합니다.
//
// 링크 쉰두 개 중 서른일곱 개는 그냥 받아와도 멀쩡합니다. 전부 브라우저로 열면
// 한 번 도는 데 몇 분이 더 걸리고, 얻는 것은 없습니다. 그래서 받아온 것이
// 비어 있을 때만 다시 엽니다.
//
// Rendering is the slow path, taken only when the cheap one came back empty:
// 37 of 52 links are fine as a plain fetch, and rendering all of them would add
// minutes per run for nothing.
async function maybeRender(url, html) {
  if (textLength(html) >= THIN_CHARS) return html;
  if (!render.available()) return html;
  try {
    const rendered = await render.renderHtml(url);
    // 더 나아졌을 때만 바꿉니다. 브라우저가 오류 화면을 뱉는 경우도 있습니다.
    return textLength(rendered) > textLength(html) ? rendered : html;
  } catch {
    return html;   // 렌더링 실패는 그냥 원래 것으로 — 하루 치 자료를 잃지 않습니다
  }
}

async function fetchOnce(url) {
  const r = RELAY ? await relayFetch(url, { render: true }) : await directFetch(url);
  const type = r.type;
  if (r.status < 200 || r.status >= 300) return { httpStatus: r.status, html: '', error: 'HTTP ' + r.status };
  if (!/html|text/i.test(type)) {
    // PDF·ZIP 은 이 경로로 읽지 않습니다 — a binary is a different job, and
    // guessing at one produces confident nonsense.
    return { httpStatus: r.status, html: '', error: 'not html (' + type.split(';')[0] + ')' };
  }
  const buf = r.buf;
  if (buf.length > MAX_BYTES) return { httpStatus: r.status, html: '', error: 'too large' };

  // 한국 공공기관 페이지는 아직 EUC-KR 이 남아 있습니다.
  const declared = (type.match(/charset=([\w-]+)/i) || [])[1]
    || (buf.slice(0, 2048).toString('latin1').match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(declared.toLowerCase()).decode(buf); }
  catch { html = buf.toString('utf8'); }

  // 중계를 쓰는 경우에는 중계 쪽에서 이미 브라우저로 열어 봤습니다 — 그 편이
  // 맞습니다. 막힌 사이트는 한국에서만 열리므로, 브라우저도 한국에서 돌아야 합니다.
  if (!RELAY) html = await maybeRender(url, html);

  return { httpStatus: r.status, html, error: null };
}

// ---------------------------------------------------------------- ② 글만 추리기
//
// 표가 핵심입니다. 탐님이 빨간 원으로 표시한 것이 바로 표였습니다 — 가구원수별
// 지원금액. 표를 태그째 지워 버리면 숫자만 줄줄이 남아 무슨 값인지 알 수 없습니다.
//
// Tables are the point. The figures the client circled were a table — support
// amounts by household size — and flattening one by stripping tags leaves a row
// of numbers with nothing saying what they count.
function tableToText(tableHtml) {
  const cell = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
  const rows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((c) => cell(c[0])).filter((x) => x !== ''));
  return rows.filter((r) => r.length).map((r) => r.join(' | ')).join('\n');
}

function extractText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const tables = [...s.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => tableToText(m[0]))
    .filter((t) => t && t.length > 10);

  s = s.replace(/<table[\s\S]*?<\/table>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');

  // 메뉴가 본문보다 깁니다 — 같은 줄이 반복되면 네비게이션입니다.
  const seen = new Set();
  s = s.split('\n').filter((l) => { if (seen.has(l)) return false; seen.add(l); return true; }).join('\n');

  return (tables.length ? '[표]\n' + tables.join('\n\n') + '\n\n[본문]\n' : '') + s;
}

// ---------------------------------------------------------------- ③ 사실만 요약
const SUMMARY_SYSTEM = `You read one Korean public-service web page and write down only the facts an elderly caller would act on.

Write TWO sections, in this exact format and nothing else:

[KO]
<Korean, 3-10 short lines>
[EN]
<the same lines in English>

What to keep, when the page states it:
- 지원금액 / amounts, including per-household-size tables (write them out: "1인 30만원, 2인 40만원, …")
- 자격 / who qualifies, income thresholds
- 신청 방법 / how to apply, what to bring
- 기간·횟수 / periods, deadlines, how many times
- 운영시간, 전화번호, 주소 / hours, phone, address
- 지원 종류 / what kinds of help exist

Rules:
- ONLY what the page actually says. Never infer, never round, never fill a gap. If the page does not give amounts, do not mention amounts.
- Keep numbers exactly as written, with their units (만원, %, 세, 시).
- No marketing sentences, no site navigation, no "click here".
- Each line must stand on its own when read aloud to someone in their 80s.
- If the page carries nothing a caller could act on (a menu, a notice list, a login wall), reply with exactly: NOTHING

Do not add commentary before or after the two sections.`;

async function summarise(service, text) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const head = `서비스: ${service.sub}\n설명: ${service.description || ''}\n기관: ${service.org || ''}\n\n---- 페이지 내용 ----\n`;
  const body = text.slice(0, 24_000);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
               'content-type': 'application/json' },
    body: JSON.stringify({
      model: env.SOURCE_MODEL || 'claude-sonnet-5',
      max_tokens: 1200,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: head + body }],
      thinking: { type: 'disabled' },
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const out = ((j.content && j.content[0] && j.content[0].text) || '').trim();
  if (/^NOTHING\b/i.test(out)) return { ko: '', en: '' };

  const ko = (out.match(/\[KO\]\s*([\s\S]*?)(?=\[EN\]|$)/) || [])[1] || '';
  const en = (out.match(/\[EN\]\s*([\s\S]*)$/) || [])[1] || '';
  return { ko: ko.trim(), en: en.trim() };
}

// ---------------------------------------------------------------- 한 건 갱신
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * 서비스 하나의 링크를 읽어 사실을 저장합니다.
 *
 * 내용이 지난번과 같으면 요약을 건너뜁니다 — 날짜만 새로 찍습니다. 매일 돌리는
 * 작업이라 이 한 줄이 대부분의 모델 호출을 없앱니다.
 */
async function refreshOne(service, { force = false, deps = {} } = {}) {
  const get = deps.fetchPage || fetchPage;
  const sum = deps.summarise || summarise;
  const url = (service.link || '').trim();
  if (!/^https?:\/\//i.test(url)) return { code: service.code, status: 'skipped', reason: 'no link' };

  const prev = await db.all(
    'SELECT * FROM service_sources WHERE service_id = $1 AND url = $2', [service.id, url]);
  const before = prev[0] || null;

  let page;
  try { page = await get(url); }
  catch (e) { page = { httpStatus: null, html: '', error: String(e.message || e).slice(0, 200) }; }

  if (page.error) {
    await save(service, url, { status: 'error', http: page.httpStatus, error: page.error,
                               hash: before && before.content_hash, raw: 0,
                               facts: before && before.facts, facts_en: before && before.facts_en });
    return { code: service.code, status: 'error', reason: page.error };
  }

  const text = extractText(page.html);
  const h = hash(text);
  if (!force && before && before.content_hash === h && before.status === 'ok') {
    await db.query('UPDATE service_sources SET fetched_at = now(), updated_at = now() WHERE id = $1',
      [before.id]);
    return { code: service.code, status: 'unchanged', chars: text.length };
  }

  let facts;
  try { facts = await sum(service, text); }
  catch (e) {
    await save(service, url, { status: 'error', http: page.httpStatus,
                               error: 'summary: ' + String(e.message || e).slice(0, 160),
                               hash: h, raw: text.length,
                               facts: before && before.facts, facts_en: before && before.facts_en });
    return { code: service.code, status: 'error', reason: 'summary failed' };
  }

  const empty = !facts.ko;
  await save(service, url, { status: empty ? 'empty' : 'ok', http: page.httpStatus, error: null,
                             hash: h, raw: text.length, facts: facts.ko, facts_en: facts.en });
  return { code: service.code, status: empty ? 'empty' : 'ok',
           chars: text.length, factChars: (facts.ko || '').length };
}

async function save(service, url, f) {
  // 실패했는데 지난번 사실이 남아 있으면, 그 줄은 <그대로 쓸 수 있는 상태로>
  // 둡니다 — 그리고 확인한 날짜도 그때 그대로 둡니다.
  //
  // 예전에는 실패하면 status 를 'error' 로 바꾸면서 facts 는 그대로 넘겨받았는데,
  // 키오스크는 status='ok' 인 줄만 읽습니다 (kiosk-context.js). 그래서 넘겨받은
  // 사실이 아무 데도 쓰이지 못했습니다 — 하룻밤 수집이 한 번 실패하면 60개
  // 서비스가 전부 "담당 선생님께 전해드릴게요" 로 돌아갔습니다. 조용히.
  //
  // fetched_at 을 건드리지 않는 것도 같은 이유입니다. 오늘 읽기에 실패했는데
  // "오늘 확인했다"고 날짜를 새로 찍으면, 이음이가 어르신께 <언제 확인한
  // 것인지>를 틀리게 말하게 됩니다. 이 프로젝트에서 출처와 날짜는 지어내면
  // 안 되는 것들입니다.
  //
  // A failed run used to set status='error' while carrying the old facts over —
  // but the kiosk only reads status='ok', so the carried facts reached nobody
  // and one bad night silently stripped every service back to "I'll pass it to
  // the staff member". The date is left alone for the same reason: claiming we
  // checked today when today's fetch failed would make Ieumi misstate its own
  // provenance, which is the one thing this layer exists to get right.
  const keepUsable = f.status === 'error' && f.facts;
  const status = keepUsable ? 'ok' : f.status;

  await db.query(
    `INSERT INTO service_sources
       (service_id, url, fetched_at, status, http_status, error, content_hash, raw_chars,
        facts, facts_en, fact_chars)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (service_id, url) DO UPDATE SET
       fetched_at = ${keepUsable ? 'service_sources.fetched_at' : 'now()'},
       status = excluded.status, http_status = excluded.http_status,
       error = excluded.error, content_hash = excluded.content_hash,
       raw_chars = excluded.raw_chars, facts = excluded.facts,
       facts_en = excluded.facts_en, fact_chars = excluded.fact_chars, updated_at = now()`,
    [service.id, url, status, f.http || null, f.error || null, f.hash || null,
     f.raw || 0, f.facts || null, f.facts_en || null, (f.facts || '').length]);
}

/** 링크가 있는 서비스 전부 — one at a time, so a slow government host cannot
 *  stack twenty open sockets against itself. */
async function refreshAll({ force = false, only = null, onProgress = () => {} } = {}) {
  const rows = await db.all(
    `SELECT id, code, sub, description, org, link FROM services
      WHERE active AND link IS NOT NULL AND link <> ''
      ${only ? 'AND code = ANY($1::text[])' : ''}
      ORDER BY code`, only ? [only] : []);
  const out = [];
  for (const s of rows) {
    const r = await refreshOne(s, { force });
    out.push(r);
    onProgress(r, out.length, rows.length);
  }
  return out;
}

module.exports = { fetchPage, extractText, tableToText, summarise, refreshOne, refreshAll };
