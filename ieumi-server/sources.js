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

async function fetchOnce(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(FETCH_MS),
    redirect: 'follow',
  });
  const type = r.headers.get('content-type') || '';
  if (!r.ok) return { httpStatus: r.status, html: '', error: 'HTTP ' + r.status };
  if (!/html|text/i.test(type)) {
    // PDF·ZIP 은 이 경로로 읽지 않습니다 — a binary is a different job, and
    // guessing at one produces confident nonsense.
    return { httpStatus: r.status, html: '', error: 'not html (' + type.split(';')[0] + ')' };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) return { httpStatus: r.status, html: '', error: 'too large' };

  // 한국 공공기관 페이지는 아직 EUC-KR 이 남아 있습니다.
  const declared = (type.match(/charset=([\w-]+)/i) || [])[1]
    || (buf.slice(0, 2048).toString('latin1').match(/charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(declared.toLowerCase()).decode(buf); }
  catch { html = buf.toString('utf8'); }
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
  await db.query(
    `INSERT INTO service_sources
       (service_id, url, fetched_at, status, http_status, error, content_hash, raw_chars,
        facts, facts_en, fact_chars)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (service_id, url) DO UPDATE SET
       fetched_at = now(), status = excluded.status, http_status = excluded.http_status,
       error = excluded.error, content_hash = excluded.content_hash,
       raw_chars = excluded.raw_chars, facts = excluded.facts,
       facts_en = excluded.facts_en, fact_chars = excluded.fact_chars, updated_at = now()`,
    [service.id, url, f.status, f.http || null, f.error || null, f.hash || null,
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
