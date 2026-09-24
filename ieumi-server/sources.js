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
const fs = require('fs');
const path = require('path');
const db = require('./db');
const env = require('./env.js');
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
// 무엇을 받아들일 것인가.
//
// 예전에는 'text/html,application/xhtml+xml' 만 보냈습니다. 그러면 JSON 만 내주는
// 서버가 <406 Not Acceptable> 로 거절합니다 — 서초 공공셔틀의 공지 API 가 그랬고,
// 페이지가 없는 것처럼 보였습니다. 실제로는 우리가 "JSON 은 안 받는다"고 말한
// 것이었습니다. HTML 을 먼저 원하되, 나머지도 받겠다고 알립니다.
//
// Sending only text/html made a JSON-only endpoint answer 406, which read like a
// dead page when in fact we had told it we would not accept what it had. Prefer
// HTML, but say we will take the rest.
const ACCEPT = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';
// 본문에 그림이 박혀 있는 페이지는 정직하게 큽니다.
//
// 서초 공공셔틀의 '효도버스 노선 시간표' 공지 <한 건>이 2.4MB 입니다 — 시간표
// PNG 가 base64 로 본문에 들어 있기 때문입니다. 3MB 로 막아 두면 그 공지가 통째로
// 'too large' 로 버려집니다. 글로 펴면 몇 백 자밖에 안 되는데도요.
//
// 그림 자체는 따로 제한합니다 (MAX_IMAGE_BYTES), 그러니 여기서는 넉넉해도 됩니다.
//
// A page with images embedded in its body is legitimately large: one shuttle
// notice is 2.4MB because the timetable PNG is inlined as base64. Capping at 3MB
// threw that whole notice away, though its text is a few hundred characters.
// Images are bounded separately, so this can afford to be generous.
const MAX_BYTES = Number(env.MAX_PAGE_BYTES || 12_000_000);
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

// 다시 시도할 만한 실패인가 — EAI_AGAIN 은 DNS 가 잠깐 안 되는 것이고, 나머지는
// 연결이 끊긴 것입니다. 둘 다 다음 번에는 되는 일이 흔합니다.
const TRANSIENT =
  /timeout|abort|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR|socket|network|fetch failed/i;

/**
 * 한 페이지를 받아옵니다. `tries` 로 몇 번까지 다시 해 볼지 정합니다.
 *
 * 카탈로그에 적힌 대문은 세 번까지 기다려 줍니다 — 그 한 장을 놓치면 그 서비스가
 * 그날 하루 통째로 비기 때문입니다. 반면 <따라간 페이지는 한 번만> 해 봅니다.
 * 없어도 대문이 답하고, 어제 읽어 둔 것도 그대로 남아 있습니다.
 *
 * 재어 보고 정한 값입니다. 처음에는 모든 페이지를 세 번씩 시도했는데, 느린
 * 기관 한 곳에서 한 서비스가 <11분 40초> 걸렸습니다. 하위 페이지 하나가 세 번씩
 * 시간 초과를 기다린 탓이었습니다. 대부분의 서비스는 22~52초입니다.
 *
 * The front door gets three attempts: losing it empties the service for the day.
 * A page we chose to follow gets one — the front door still answers without it,
 * and yesterday's copy is still on file. Measured: retrying everything three
 * times made one slow institution take 11m40s against a 22–52s norm.
 */
async function fetchPage(url, { tries = RETRIES } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url);
    } catch (e) {
      const why = String((e.cause && (e.cause.code || e.cause.message)) || e.message || '');
      if (attempt >= tries - 1 || !TRANSIENT.test(why)) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
    }
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

// 차단 안내문인지 보려고 앞부분만 글로 바꿔 봅니다 — check-links.js 와 같은 기준.
const plainStart = (html) => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
const BLOCKED = /web firewall|방화벽|보안 정책|Access Denied|차단되었습니다|접근이 거부/i;

// 2xx 가 아닌 응답에서 '이 정도면 진짜 페이지'로 볼 글자 수.
const SALVAGE_CHARS = Number(env.SALVAGE_CHARS || 400);

/**
 * 상태 코드가 2xx 가 아닌 응답의 본문을 그래도 읽을 것인가.
 *
 * 페이지 한 장만큼의 글이 들어 있고, 차단 안내문처럼 읽히지 않을 때만 읽습니다.
 * Only when it holds a page's worth of text and does not read like a refusal.
 */
function worthReadingAnyway(html) {
  return textLength(html) >= SALVAGE_CHARS && !BLOCKED.test(plainStart(html));
}

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
    headers: { 'user-agent': UA, accept: ACCEPT },
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
  const ok2xx = r.status >= 200 && r.status < 300;
  if (!ok2xx && !/html|text/i.test(type)) {
    return { httpStatus: r.status, html: '', error: 'HTTP ' + r.status };
  }
  // JSON 은 글로 펴서 읽습니다 (위 jsonToText). 자바스크립트 앱이 공개 REST 로
  // 내용을 내주는 경우가 있고, 그때는 그것이 유일하게 읽을 수 있는 형태입니다.
  if (/json/i.test(type)) {
    const body = r.buf.toString('utf8');
    try {
      const lines = jsonToText(JSON.parse(body));
      // raw 를 함께 돌려주는 것은, 본문 안에 박혀 있는 그림(data: 주소)을
      // pickImages 가 찾아야 하기 때문입니다. 글에서는 빼고, 그림으로는 읽습니다.
      return { httpStatus: r.status, html: '', raw: body,
               json: lines.join('\n'), error: null };
    } catch {
      return { httpStatus: r.status, html: '', error: 'bad json' };
    }
  }
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

  // 상태 코드가 2xx 가 아니어도, 본문이 멀쩡하면 읽습니다.
  //
  // 사랑의복지관(esarang.org)은 <모든> 페이지를 403 으로 돌려주면서 내용은 그대로
  // 보냅니다 — 이용안내 1,597자, 기관소개 2,413자가 그대로 들어 있습니다. 방화벽
  // 설정이 그럴 뿐, 페이지가 없는 것이 아닙니다. 상태 코드만 보고 버리면 서초구
  // 장애인복지관 한 곳이 영영 아무것도 답하지 못합니다.
  //
  // esarang.org answers 403 on every page while serving the real content.
  // Judging by the status code alone loses the whole centre. So a non-2xx reply
  // is still read — but only when it is long enough to be a page and does not
  // read like a refusal, or we would be summarising block notices as facts.
  if (!ok2xx && !worthReadingAnyway(html)) {
    return { httpStatus: r.status, html: '', error: 'HTTP ' + r.status };
  }

  return { httpStatus: r.status, html, error: null };
}

// ------------------------------------------------------------ ①-b 한 걸음 더
//
// 카탈로그의 주소는 대개 <대문>입니다. 대문에는 운영시간과 전화번호가 있고,
// 어르신이 실제로 물으시는 것 — 무슨 강좌가 있나, 몇 시에 하나, 얼마인가 — 은
// 한 번 더 눌러야 나오는 곳에 있습니다.
//
// 2026-09-18 클라이언트 지적이 정확히 이것이었습니다. 서초50플러스센터 강좌를
// 세 개 소개해 달라는 질문에 이음이가 답하지 못했는데, 원인은 수집이 고장난 것이
// 아니라 /sch/index.do (대문, 2,208자) 만 읽고 /sch/education.do (강좌표, 3,241자) 는
// 아무도 열어 보지 않았다는 것이었습니다. 강좌표 쪽은 <이미 있던 코드로> 멀쩡히
// 읽힙니다. 카탈로그 링크 일흔 개 중 스물다섯 개가 같은 모양입니다.
//
// The catalogue points at front doors. Hours and a phone number live there; what
// a senior actually asks — which courses, what time, how much — is one click
// deeper. Measured on the client's own example: the front door gave 2,208
// characters of opening hours, and the course table one link away gave 3,241
// characters of exactly what was asked for, through the code that already
// shipped. Nobody had ever followed the link.
//
// 한 걸음만 갑니다. 두 걸음부터는 기관 홈페이지 전체를 긁는 일이 되고, 그것은
// 공개 페이지를 하루 한 번 읽는 것과 다른 이야기입니다.
// One hop only. Two would be crawling the whole site, which is a different thing
// from reading a handful of public pages once a day.
const SUBPAGE_MAX = Number(env.SUBPAGE_MAX || 8);   // 탐 팀: 공지 많은 기관(느티나무 등)의 개별 글을 더 따라가도록 4→8. .env SUBPAGE_MAX로 조정 가능

// 어떤 링크를 따라갈 것인가 — 어르신이 물으시는 것이 있을 만한 곳.
// 점수가 높을수록 먼저 갑니다. 글자는 링크 이름에서, 그다음 주소에서 찾습니다.
const SUBPAGE_WORDS = [
  [3, /강좌|프로그램|시간표|교육과정|수강|커리큘럼|program|course|class|schedule|curriculum|lecture|education|edu\b/i],
  [2, /모집|접수|신청|이용안내|이용방법|사업안내|사업소개|행사|일정|apply|apply\.do|guide/i],
  [1, /안내|공지|서비스|지원|소식|알림|notice|board|bbs|news/i],
];

// 따라가도 얻을 것이 없는 곳 — 로그인, 약관, 사이트맵.
const SUBPAGE_SKIP =
  /로그인|회원가입|아이디|비밀번호|개인정보|이용약관|저작권|사이트맵|이메일무단|찾아오시는|오시는\s*길|login|logout|join|member|privacy|terms|sitemap|search/i;

// 글이 아닌 것은 이 길로 읽지 않습니다 (PDF·한글파일은 다른 일입니다).
const NOT_A_PAGE = /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|zip|rar|jpe?g|png|gif|webp|mp4|mp3)(\?|$)/i;

/** jsessionid 같은 세션 부스러기를 떼어 냅니다 — 같은 페이지가 여러 번 잡힙니다. */
function tidyUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    x.pathname = x.pathname.replace(/;jsessionid=[^/?]*/i, '');
    for (const k of ['jsessionid', 'JSESSIONID', 'PHPSESSID']) x.searchParams.delete(k);
    return x.toString();
  } catch { return null; }
}

/**
 * 대문에서 따라갈 만한 링크를 고릅니다.
 *
 * 같은 기관 안에서만 움직입니다. 중계 서버의 허용 목록이 도메인 단위라, 다른
 * 도메인으로 넘어가면 어차피 거절당합니다 — 그리고 그래야 맞습니다.
 */
/**
 * 저희가 따로 찾아 둔 자료 주소 (extra-sources.json).
 *
 * 자바스크립트 앱은 대문에 따라갈 링크가 없습니다 — 서초 공공셔틀의 대문은
 * 168자짜리 껍데기입니다. 그런 곳은 사람이 한 번 찾아서 적어 두는 수밖에 없습니다.
 * 카탈로그의 link 는 어르신께 문자로 가는 주소라 여기에 둘 수 없습니다.
 *
 * 파일이 없거나 망가져 있어도 수집은 그대로 돌아갑니다 — 없으면 없는 대로.
 */
function extraSources(code) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'extra-sources.json'), 'utf8'));
    const e = f[code];
    const urls = (e && e.urls) || [];
    return urls.filter((u) => /^https?:\/\//i.test(u));
  } catch { return []; }
}

function pickSubpages(html, baseUrl, { max = SUBPAGE_MAX } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const here = tidyUrl(baseUrl);
  const seen = new Map();

  for (const m of (html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const raw = m[1].trim();
    if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
    if (NOT_A_PAGE.test(raw)) continue;

    let abs;
    try { abs = tidyUrl(new URL(raw, base).toString()); } catch { continue; }
    if (!abs || abs === here) continue;

    const target = new URL(abs);
    if (target.hostname.toLowerCase() !== base.hostname.toLowerCase()) continue;
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;

    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if (SUBPAGE_SKIP.test(label) || SUBPAGE_SKIP.test(target.pathname + target.search)) continue;

    // 링크 이름이 본문, 주소는 거들 뿐 — 주소만 맞는 것은 대개 메뉴 찌꺼기입니다.
    let score = 0;
    for (const [w, re] of SUBPAGE_WORDS) {
      if (re.test(label)) score += w * 2;
      else if (re.test(decodeURIComponent(target.pathname + target.search))) score += w;
    }
    if (!score) continue;

    const prev = seen.get(abs);
    if (!prev || prev.score < score) seen.set(abs, { url: abs, title: label.slice(0, 120), score });
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

// ------------------------------------------------------------ ①-c 그림 읽기
//
// 어떤 것은 글로 존재하지 않습니다.
//
// 방배느티나무쉼터의 '프로그램 시간표' 페이지는 486자이고, 그 486자가 <전부
// 메뉴입니다.> 10월 시간표는 JPG 한 장으로만 있습니다 — 요일, 시간, 층, 과목이
// 전부 그림 안에 있습니다. 링크를 아무리 고쳐도, 브라우저로 아무리 잘 그려도
// 닿지 않습니다. 눈으로 보는 수밖에 없습니다.
//
// 클라이언트가 빨간 원으로 표시한 그 표입니다. 실제로 읽어 보았습니다: 월~금,
// 어울림터·배움터·나눔터 세 곳, 시간대별 과목이 그대로 나옵니다. 폐강 기준과
// 신청 전화번호까지 같이 나옵니다.
//
// Some of this exists only as a picture. Bangbae's timetable page is 486
// characters and every one is navigation; the October schedule is a single JPG.
// No link fix and no renderer reaches it. Read as an image it comes back whole —
// five days, three rooms, every slot, the cancellation rule and the phone number.
const IMAGE_MAX = Number(env.IMAGE_MAX || 4);
const MIN_IMAGE_BYTES = Number(env.MIN_IMAGE_BYTES || 25_000);
const MAX_IMAGE_BYTES = Number(env.MAX_IMAGE_BYTES || 3_500_000);   // base64 로 5MB 한도 안쪽

// 글이 이만큼도 안 되면 그림을 봅니다 — 방배느티나무쉼터는 대문 1,039자 +
// 시간표 페이지 486자 = 1,525자였고, 그 안에 시간표는 한 글자도 없었습니다.
const VISION_TEXT_FLOOR = Number(env.VISION_TEXT_FLOOR || 2500);

// 장식은 건너뜁니다. 로고가 52KB 인 곳이 있어서 크기만으로는 갈라지지 않습니다 —
// 어디에 놓여 있는지를 함께 봅니다.
// Size alone does not separate them: one site's logo is 52KB. Where the file sits
// says more than how big it is.
const IMAGE_SKIP =
  /\/(images\/site|images\/common|common|icon|icons|btn|button|layout|skin|quick_?menu)\//i;
const IMAGE_SKIP_NAME =
  /(icon|btn_|button|arrow|bullet|sprite|spacer|blank|logo|thumb|thumbnail|noimage|bg_|_bg|dot_|line_)/i;

// 본문·첨부 자리. webimage 를 <넣지 않는 것이> 중요합니다 — 이 CMS 에서는 그것이
// 모든 그림의 뿌리라서, 넣으면 로고도 퀵메뉴 아이콘도 포스터와 같은 점수를 받습니다.
// 실제로 그렇게 되어서, 방배느티나무쉼터에서 그림 예산 세 장을 퀵메뉴 아이콘으로
// 전부 쓰고 정작 시간표 포스터에는 닿지 못했습니다.
//
// Deliberately not /webimage/: in this CMS that is the root of every image, so
// including it scored the logo and the quick-menu icons level with the poster.
// Measured: the whole image budget went on menu icons and the timetable — the one
// thing on the site worth reading — was never reached.
const IMAGE_LIKELY =
  /\/(editor|upload|uploads|attach|attachment|files?|data|bbs|board|popup|photo|media|content)\//i;
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(\?|$)/i;

/**
 * 읽어 볼 만한 그림을 고릅니다.
 *
 * 크기는 여기서 거르지 않습니다 — 받아 봐야 알 수 있고, 받아 본 뒤에 거릅니다.
 * 여기서는 <놓인 자리와 이름>으로만 거릅니다.
 */
function pickImages(html, baseUrl, { max = IMAGE_MAX } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const seen = new Map();

  const consider = (raw, label) => {
    if (!raw || !IMAGE_EXT.test(raw)) return;
    let abs;
    try { abs = tidyUrl(new URL(raw.trim(), base).toString()); } catch { return; }
    if (!abs) return;
    const target = new URL(abs);
    if (target.hostname.toLowerCase() !== base.hostname.toLowerCase()) return;

    // 이름만 보아서는 모자랍니다 — 방배느티나무쉼터의 로고는 파일 이름이
    // '20210421150441000862.png' 이고, 'logo' 는 <폴더> 이름에만 있습니다.
    // 게다가 52KB 라 크기로도 걸러지지 않습니다. 길 전체를 봅니다.
    // The filename alone is not enough: one site's logo is called
    // 20210421150441000862.png and is 52KB — only its folder says "logo".
    const p = decodeURIComponent(target.pathname);
    if (IMAGE_SKIP.test(p) || IMAGE_SKIP_NAME.test(p)) return;

    // 본문·첨부 자리에 있는 그림을 먼저 봅니다. 그 밖의 것도 후보이긴 합니다.
    const score = IMAGE_LIKELY.test(p) ? 2 : 1;
    const prev = seen.get(abs);
    if (!prev || prev.score < score) {
      seen.set(abs, { url: abs, title: (label || '').replace(/\s+/g, ' ').trim().slice(0, 120), score });
    }
  };

  // 본문에 박혀 있는 그림 — data:image/png;base64,...
  //
  // 한국 관공서 게시판 편집기가 그림을 이렇게 넣는 일이 흔합니다. 주소가 따로
  // 없으니 받아올 것도 없습니다 — 바이트가 이미 손에 있습니다. 효도버스 노선
  // 시간표(s53)가 정확히 이 모양입니다: 2.4MB 짜리 공지 하나에 PNG 한 장.
  //
  // Korean CMS editors embed images inline like this. There is no URL to fetch —
  // the bytes are already in hand. Seocho's shuttle timetable is exactly this:
  // one notice, one embedded PNG.
  for (const m of (html || '').matchAll(/data:image\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]{2000,})/gi)) {
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch { continue; }
    if (!buf || buf.length < MIN_IMAGE_BYTES) continue;
    // 바이트로 이름을 만듭니다 — 같은 그림이면 같은 이름이라 다시 읽지 않고,
    // 그림이 바뀌면 이름도 바뀌어 새로 읽습니다.
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const key = 'embedded:' + id;
    if (!seen.has(key)) {
      seen.set(key, { url: key, title: '본문에 첨부된 안내문', score: 3,
                      data: buf, type: 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]) });
    }
  }

  for (const m of (html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1]
             || (tag.match(/\bdata-src=["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt=["']([^"']*)["']/i) || [])[1] || '';
    consider(src, alt);
  }
  // 포스터를 원본 크기로 여는 링크도 그림입니다.
  for (const m of (html || '').matchAll(/<a\b[^>]*href=["']([^"']+\.(?:jpe?g|png|gif|webp))["']/gi)) {
    consider(m[1], '');
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

/** 그림 한 장을 바이트 그대로 받아옵니다 — 중계도 그대로 통과시켜 줍니다. */
async function fetchBinary(url) {
  const r = RELAY ? await relayFetch(url) : await directFetch(url);
  const ok2xx = r.status >= 200 && r.status < 300;
  if (!ok2xx) return { httpStatus: r.status, buf: null, type: r.type, error: 'HTTP ' + r.status };
  if (!/^image\//i.test(r.type)) {
    return { httpStatus: r.status, buf: null, type: r.type, error: 'not an image (' + String(r.type).split(';')[0] + ')' };
  }
  return { httpStatus: r.status, buf: r.buf, type: r.type.split(';')[0].trim().toLowerCase(), error: null };
}

const VISION_SYSTEM = `You are looking at one image from a Korean public-service or senior-welfare website. It is usually a poster, a timetable, a price list or a notice.

Transcribe what it says. Write it out so that someone who cannot see the image knows everything it tells them.

Rules:
- Write in Korean, exactly as the image words it. Do not translate, do not paraphrase, do not summarise.
- A timetable is the whole point: give every day, every time slot, every room and every programme name. Write one line per entry, like "월 10:00-10:50 어울림터 전신스트레칭". Never write "etc." and never skip a row for brevity.
- EVERY line must repeat its own labels in full. Never write a heading followed by a bare list of values underneath it — write "양재노인종합복지관 08:35", "양재노인종합복지관 09:35" and so on, one line each, not "양재노인종합복지관: 08:35, 09:35, …". This is not stylistic. These lines get split apart later, and a time that has drifted away from its stop or its day is worse than no time at all: someone stands at the wrong stop at the wrong hour.
- Where a row and a column both name something (a stop and a direction, a day and a room), put both on every line.
- Keep every number exactly: times, fees, capacities, phone numbers, dates, deadlines.
- Keep footnotes and conditions — cancellation rules, who may apply, what to bring.
- If the image is decoration with no information in it (a logo, a photograph of people, a banner with only a slogan), reply with exactly: NOTHING

Begin with one line naming what the image is, then the contents. No commentary.`;

/**
 * 그림 한 장을 글로 옮깁니다.
 *
 * 요약이 아니라 <받아쓰기>입니다. 시간표를 요약하면 시간표가 아니게 됩니다 —
 * 어르신이 물으시는 것은 언제나 "목요일 두 시에 뭐 하나" 처럼 한 칸이기 때문에,
 * 어느 칸을 버릴지 미리 고를 수가 없습니다.
 *
 * Transcription, not summary: a summarised timetable stops being a timetable, and
 * the question is always about one cell of it.
 */
async function describeImage(service, img, buf, mediaType) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await pfetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
               'content-type': 'application/json' },
    timeoutMs: 180_000,
    body: JSON.stringify({
      model: env.VISION_MODEL || env.SOURCE_MODEL || 'claude-sonnet-5',
      max_tokens: 3000,
      system: VISION_SYSTEM,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
        { type: 'text', text: `기관: ${service.org || ''}\n서비스: ${service.sub || ''}`
          + (img.title ? `\n그림 설명: ${img.title}` : '') },
      ] }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  const out = ((j.content && j.content[0] && j.content[0].text) || '').trim();
  return /^NOTHING\b/i.test(out) ? '' : out;
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

// 자바스크립트로 그리는 앱이 <공개 JSON> 으로 내용을 내주는 경우.
//
// 서초 공공셔틀(s53)이 그렇습니다. 대문은 168자짜리 빈 껍데기이고, 효도버스 노선
// 시간표는 `/rest/api/v1/notice/notices` 가 돌려주는 JSON 안에 들어 있습니다.
// 브라우저로 그려도 잡히지 않아서 오래 '읽을 수 없는 서비스' 로 남아 있었습니다.
//
// 공개된 주소이고, 사람이 그 화면에서 보는 것과 같은 내용을, 하루 한 번 읽습니다.
// 로그인이 필요한 것(`/api/...` 는 401)은 읽지 않습니다 — 앞으로도 그렇습니다.
//
// Some JavaScript apps hand their content out as public JSON. Seocho's shuttle
// site is one: the front door is a 168-character shell and the timetable lives in
// what /rest/api/v1/notice/notices returns. Read once a day, same content a person
// sees on that screen. Anything behind a login (its /api/... returns 401) is not
// read, and will not be.
// raw* 는 대개 같은 내용을 한 번 더 담고 있습니다 (rawContentKo = contentKo).
// 그대로 두면 같은 글이 두 번 조각으로 들어가 검색 결과를 자기가 밀어냅니다.
const JSON_SKIP =
  /^(createdBy|lastModifiedBy|createdByUser|lastModifiedByUser|entityStatus|entityId|createdDate|lastModifiedDate|password|token|sort|pageable|_links|filePath|fileParentPath|raw[A-Z])/;

// 제목으로 쓸 만한 열쇠 — 값을 'key: value' 가 아니라 <한 줄 제목>으로 적습니다.
//
// 이게 왜 중요한가: 조각내기(chunkText)는 조각의 첫 줄을 제목으로 삼고, 검색은
// 제목에 본문의 세 배 점수를 줍니다. 모든 줄을 'titleKo: …' 로 적어 두었더니
// 공지 열여섯 건이 전부 <첫 번째 공지의 제목>을 뒤집어썼습니다. 문화버스 안내도,
// 챗봇 홍보도 제목이 '효도버스 노선 시간표' 가 되어, 정작 진짜 시간표를 밀어냈습니다.
//
// chunkText takes a chunk's first line as its heading and search weights headings
// triple. Emitting every field as "titleKo: …" made all sixteen notices inherit the
// first one's title, so the bus-timetable heading was attached to a chatbot advert
// — which then outranked the actual timetable.
const JSON_TITLE = /^(title|subject|name|typeName|heading)/i;

function jsonToText(value, depth = 0, out = []) {
  if (depth > 6 || out.length > 4000) return out;
  if (value === null || value === undefined) return out;

  if (Array.isArray(value)) {
    value.forEach((v) => {
      // 기록 하나가 끝나면 빈 줄 — chunkText 가 여기서 끊습니다.
      if (out.length && out[out.length - 1] !== '') out.push('');
      jsonToText(v, depth + 1, out);
    });
    return out;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([k, v]) =>
      !JSON_SKIP.test(k) && v !== null && v !== '' && v !== undefined);
    // 제목을 먼저, 그리고 제목답게.
    entries.sort((a, b) => (JSON_TITLE.test(b[0]) ? 1 : 0) - (JSON_TITLE.test(a[0]) ? 1 : 0));
    const seen = new Set();
    for (const [k, v] of entries) {
      if (typeof v === 'object') { jsonToText(v, depth + 1, out); continue; }
      const s = String(v);
      if (/^\d{10,}$/.test(s)) continue;                 // epoch 밀리초 — 읽을 것이 없습니다
      // 값 안에 HTML 이 들어 있는 경우가 흔합니다 (게시글 본문).
      const text = /<[a-z][\s\S]*>/i.test(s) ? extractText(stripDataUris(s)) : s;
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean || seen.has(clean)) continue;           // 같은 값이 여러 열쇠에 반복됩니다
      seen.add(clean);
      out.push(JSON_TITLE.test(k) ? clean : k + ': ' + clean);
    }
    return out;
  }
  const s = String(value).trim();
  if (s) out.push(s);
  return out;
}

// data: 주소는 글이 아니라 그림입니다 — 본문에 그대로 두면 2.4MB 짜리 base64 가
// 요약 프롬프트로 들어갑니다. 그림은 pickImages 가 따로 집어 갑니다.
const stripDataUris = (s) =>
  String(s || '').replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[그림]');

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
// 요약이 무엇을 남기고 무엇을 버리는지가, 이음이가 무엇에 답할 수 있는지를
// 그대로 정합니다.
//
// 2026-09-18 이전의 이 목록에는 <강좌와 프로그램이 없었습니다.> 금액·자격·신청
// 방법·운영시간·전화번호만 남기라고 되어 있었고, 게다가 "메뉴나 공지 목록이면
// NOTHING 이라고 답하라"고 했습니다. 강좌표는 공지 목록처럼 생겼습니다. 그래서
// 링크를 제대로 고쳐 강좌표를 읽어 와도, 이 단계에서 다시 버려졌을 것입니다.
//
// Until 2026-09-18 this list did not mention courses or programmes at all — and
// it told the model to answer NOTHING for "a notice list", which is exactly what
// a course table looks like. Fixing the links without fixing this would have
// thrown the courses away one step later, invisibly.
const SUMMARY_SYSTEM = `You read the public pages of one Korean public-service or senior-welfare organisation and write down what an elderly caller would act on.

The material may hold several pages and the transcription of posters or timetables. Treat it as one body of knowledge about one organisation.

Write TWO sections, in this exact format and nothing else:

[KO]
<Korean, 5-20 short lines>
[EN]
<the same lines in English>

What to keep, when the material states it:
- 강좌·프로그램 이름 / the names of courses and programmes actually on offer, with their day and time when given ("월 10:00 전신스트레칭"), their fee (수강료) and their capacity (정원)
- 모집기간·교육기간 / when applications open and close, when the course runs
- 지원금액 / amounts, including per-household-size tables (write them out: "1인 30만원, 2인 40만원, …")
- 자격 / who qualifies, income thresholds
- 신청 방법 / how to apply, what to bring
- 기간·횟수 / periods, deadlines, how many times
- 운영시간, 전화번호, 주소 / hours, phone, address
- 지원 종류 / what kinds of help exist

Rules:
- ONLY what the material actually says. Never infer, never round, never fill a gap. If it does not give amounts, do not mention amounts.
- Keep numbers exactly as written, with their units (만원, %, 세, 시).
- A list of courses is CONTENT, not navigation. When the material holds a course or programme list, name as many as you can fit — the specific ones, with fees and times — rather than writing "various programmes are offered". "여러 프로그램이 있습니다" is the single least useful thing you could write here.
- Where a course list is long, give the most useful ones and end with a line saying how many there are in total ("이 밖에도 2학기 강좌가 모두 32개 있습니다").
- But that instruction is about what to KEEP, never about what to SUPPLY. If the material mentions a timetable, a programme or a price list without giving its contents, write that it exists and that the contents are not stated. Do NOT reconstruct it. Never write a course name, a day, a time or a fee that is not written in the material in front of you — not even one you are confident about, not even one you have seen on this organisation's site before. A plausible invented timetable is worse than no timetable: it will be right often enough to be believed and wrong with no warning, and the person who finds out is standing outside a locked door.
- When a section of the material is a menu with no content behind it, that is a fact about the page, not a gap for you to close.
- No marketing sentences, no site navigation, no "click here".
- Each line must stand on its own when read aloud to someone in their 80s.
- If the material carries nothing a caller could act on (only a menu or a login wall), reply with exactly: NOTHING

Do not add commentary before or after the two sections.`;

// 한 서비스의 자료를 한 번에 봅니다 — 대문, 따라간 페이지들, 그림에서 옮겨 적은
// 글까지. 여러 장이 되었으니 예전 24,000자로는 강좌표 한 장에 다 먹힙니다.
const SUMMARY_CHARS = Number(env.SUMMARY_CHARS || 40_000);

async function summarise(service, text) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const head = `서비스: ${service.sub}\n설명: ${service.description || ''}\n기관: ${service.org || ''}\n\n---- 페이지 내용 ----\n`;
  const body = text.slice(0, SUMMARY_CHARS);

  // pfetch: 프록시 뒤에서도 닿아야 합니다 — node 의 fetch 는 HTTPS_PROXY 를
  // 무시합니다 (proxy-fetch.js 의 이유와 같습니다).
  const r = await pfetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01',
               'content-type': 'application/json' },
    timeoutMs: 180_000,
    body: JSON.stringify({
      model: env.SOURCE_MODEL || 'claude-sonnet-5',
      max_tokens: 2000,
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

// ------------------------------------------------------- ③-b 지어낸 줄 걸러내기
//
// 2026-09-18, 이 층을 처음 돌린 날 잡힌 것입니다.
//
// 방배느티나무쉼터 요약에 <주간 시간표 전체>가 들어왔습니다. 월요일 시니어발레,
// 화요일 요가교실, 수요일 K-트롯댄스… 그럴듯한 정도가 아니라 <실제 포스터와
// 거의 맞았습니다.> 그런데 읽어 온 3,211자 어디에도 '시니어발레' 는 없었습니다.
// 모델이 지어냈고, 지어낸 것이 맞았습니다.
//
// 맞았다는 점이 더 나쁩니다. 대부분 맞으면 믿게 되고, 틀린 날에는 아무 표시도
// 나지 않습니다. 어르신이 화요일 열 시에 헛걸음을 하고 나서야 압니다.
//
// Caught on the first real run of this layer: the summary of Bangbae came back
// holding a full weekly timetable — ballet on Monday, yoga on Tuesday — and it
// very nearly matched the real poster. The word 시니어발레 appears nowhere in the
// 3,211 characters that were actually read. The model invented it, and was right.
//
// Being right is the worse outcome. A fabrication that is usually correct earns
// trust and then fails silently, and the person who finds out is an 84-year-old
// standing outside a locked room on a Tuesday morning.
//
// 그래서 요약을 <읽어 온 글에 대고 검사합니다.> 한 줄의 낱말 대부분이 원문에
// 없으면 그 줄은 버립니다. 이 검사는 모델을 부르지 않습니다.
const GROUND_MIN = Number(env.GROUND_MIN || 0.6);

// 문법 부스러기는 세지 않습니다 — 어느 글에나 있어서 점수를 부풀립니다.
const GRAMMAR = /^(입니다|있습니다|합니다|됩니다|드립니다|이며|이고|하며|에서|으로|그리고|또는|등이|등은|등을|경우|가능|대해|대한|통해|위해|모두|각각|기타|안내|이용|운영|관련|제공|실시|진행|참여|신청|문의|확인|해당|다음|아래|이상|이하|정도|또한|하지만|따라|보다|만약|무엇|어떤|이런|그런|저런)$/;

/**
 * 이 낱말이 원문에 있는가 — 조사 한 글자까지만 떼고 봅니다.
 *
 * 처음에는 세 글자까지 떼어 가며 찾았습니다. 그랬더니 두 글자짜리 토막이 2,700자
 * 짜리 한국어 문서에서는 거의 언제나 어딘가에 걸렸고, 지어낸 시간표 한 줄이
 * 낱말 마흔넷 중 마흔이 '근거 있음' 으로 나와 그대로 통과했습니다. 느슨한 검사는
 * 검사가 아닙니다.
 *
 * Stripping up to three characters made the check useless: a two-character stem
 * lands somewhere in any 2,700-character Korean document, and the fabricated
 * timetable scored 40 of 44 words "grounded" and sailed through. A check that
 * loose is not a check.
 */
const grounded = (word, hay) =>
  hay.includes(word) || (word.length >= 3 && hay.includes(word.slice(0, -1)));

// 서술어 어미를 뗍니다.
//
// '안내입니다' 는 '안내' 에 '입니다' 가 붙은 것이고, 홈페이지에는 '안내' 로만
// 적혀 있습니다. 어미째로 찾으면 영영 못 만납니다. 떼고 남은 것이 두 글자
// 이하면 내용어가 아니므로 아예 세지 않습니다 — '운영됩니다' 의 '운영' 처럼
// 어느 기관 페이지에나 있는 말이 점수를 채우는 것을 막습니다.
const PREDICATE = /(입니다|습니다|합니다|됩니다|드립니다|십니다|합니까|됩니까|랍니다|답니다)$/;
function contentWord(w) {
  const m = w.match(PREDICATE);
  if (!m) return w;
  const stem = w.slice(0, -m[0].length);
  return stem.length >= 3 ? stem : null;
}

/**
 * 글에서 숫자 덩어리만 뽑습니다.
 *
 * 글자 그대로 맞춰 보면 안 됩니다. 요약은 숫자를 <다시 적습니다>: 홈페이지의
 * '2026.09.18 ~2026.10.07' 이 요약에서는 '09.18~10.07' 이 됩니다. 같은 날짜인데
 * 글자로는 다릅니다. 처음에 글자로 맞췄더니 서초50플러스센터 강좌 열 줄이
 * 전부 '근거 없음' 으로 잘려 나갔습니다 — 그 열 줄이야말로 이번에 새로 얻은
 * 것이었는데도요.
 *
 * 그래서 숫자를 덩어리로 쪼개 견줍니다. 09.18~10.07 → 09, 18, 10, 07. 구분
 * 기호와 연도 표기가 달라도 같은 날짜로 만납니다.
 *
 * Literal matching fails because a summary rewrites its numbers: the page's
 * "2026.09.18 ~2026.10.07" becomes "09.18~10.07". Matching by string dropped all
 * ten of the new course lines — exactly what this work was for. Comparing digit
 * groups lets the same date meet itself across different separators.
 */
function digitGroups(s) {
  const out = new Set();
  const flat = String(s || '').replace(/(?<=\d),(?=\d)/g, '');   // 30,000 → 30000
  for (const m of flat.matchAll(/\d+/g)) if (m[0].length >= 2) out.add(m[0]);
  return out;
}

/**
 * 한 줄이 읽어 온 글에 근거가 있는가.
 *
 * 두 가지를 봅니다.
 *
 * ① 숫자는 <전부> 맞아야 합니다. 금액과 시각이야말로 어르신이 그대로 믿고
 *    움직이시는 것이고, 하나만 틀려도 헛걸음이 됩니다.
 *
 * ② 낱말은 <흔치 않은 것만> 셉니다 — 세 글자 이상. '이용', '운영', '안내'
 *    같은 두 글자 말은 어느 기관 페이지에나 있어서, 세어 봐야 지어낸 줄과
 *    옮겨 적은 줄을 가르지 못합니다. 가르는 것은 이름입니다: '시니어발레',
 *    '보타니컬아트', '셔플댄스' 처럼 그 기관에만 있는 말이 원문에 있느냐.
 *
 * Only distinctive words count — three characters or more. Two-character words
 * like 이용/운영/안내 appear on every institutional page in Korea and separate
 * nothing. What separates a transcribed line from an invented one is the names:
 * 셔플댄스 is either written on the page or it is not.
 */
function lineIsGrounded(line, hay, hayNums) {
  const nums = hayNums || digitGroups(hay);
  const lineNums = digitGroups(line);
  for (const n of lineNums) if (!nums.has(n)) return false;

  const rare = (line.match(/[가-힣]{3,}/g) || [])
    .map(contentWord).filter(Boolean)
    .filter((w) => !GRAMMAR.test(w));
  for (const n of lineNums) if (n.length >= 3) rare.push(n);
  if (!rare.length) return true;                  // 숫자만 있는 줄은 ①에서 봤습니다

  const hits = rare.filter((w) => grounded(w, hay)).length;
  return hits / rare.length >= GROUND_MIN;
}

/**
 * 요약에서 근거 없는 줄을 걷어냅니다.
 *
 * 영어 줄은 한국어 줄과 <같은 순서>로 나오도록 프롬프트가 요구합니다. 줄 수가
 * 맞으면 같은 자리를 함께 버립니다. 맞지 않으면 영어는 숫자만 검사합니다 —
 * 숫자는 언어를 타지 않고, 가장 위험한 것도 숫자입니다.
 */
function dropUngrounded(facts, sourceText) {
  const hay = sourceText || '';
  const hayNums = digitGroups(hay);
  const ko = (facts.ko || '').split('\n');
  const en = (facts.en || '').split('\n');
  const keep = ko.map((l) => !l.trim() || lineIsGrounded(l, hay, hayNums));
  const dropped = keep.filter((k) => !k).length;

  const koOut = ko.filter((_, i) => keep[i]).join('\n').trim();
  const enOut = (ko.length === en.length
    ? en.filter((_, i) => keep[i])
    : en.filter((l) => [...digitGroups(l)].every((n) => hayNums.has(n))))
    .join('\n').trim();

  return { ko: koOut, en: enOut, dropped };
}

// ---------------------------------------------------------------- ④ 조각내기
//
// 요약은 <질문을 알기 전에> 무엇을 남길지 고르는 일입니다. 강좌가 서른 개 있는
// 표를 열 줄로 줄이면, 어느 열 줄을 고르든 스무 개는 사라집니다. 그런데 어르신이
// 어느 강좌를 물으실지는 그때 가야 압니다.
//
// 그래서 요약은 요약대로 두고 (언제나 프롬프트에 들어갑니다), 원문은 조각으로
// 잘라 두었다가 질문이 들어온 뒤에 겹치는 조각만 꺼내 씁니다.
//
// Summarising is choosing what to keep before the question exists. A thirty-row
// course table compressed to ten lines loses twenty courses, and which twenty
// matter is not knowable until someone asks. So the summary stays, and the page
// is also kept in pieces that can be fetched once the question is known.
const CHUNK_CHARS = Number(env.CHUNK_CHARS || 900);
const TABLE_ROWS = Number(env.CHUNK_TABLE_ROWS || 8);

// 여기서부터는 다른 이야기다 — 조각을 반드시 끊어야 하는 줄.
// 제목 표시(#), 그리고 '1호차'·'월요일'처럼 한 구획을 여는 말.
const SECTION = /^#{1,4}\s|^\*\*[^*]+\*\*\s*$|^\s*\d+\s*호차|^\s*[월화수목금토일]요일\s*$|^\s*\[[^\]]+\]\s*$/;

/**
 * 읽어 온 글을 조각으로 자릅니다.
 *
 * 표는 <줄 단위로> 자르되 머리글을 조각마다 다시 붙입니다. 머리글이 없는 표
 * 조각은 숫자만 늘어선 것이나 마찬가지입니다 — '30,000원' 이 수강료인지
 * 지원금인지 알 수 없게 됩니다. 되풀이되는 한 줄이 아깝지 않은 이유입니다.
 *
 * A table is cut by rows with its header repeated into every piece: a table
 * fragment without its header is a row of numbers with nothing saying what they
 * count, and "30,000원" could be a fee or a subsidy.
 */
function chunkText(text, { maxChars = CHUNK_CHARS, tableRows = TABLE_ROWS } = {}) {
  const out = [];
  const push = (heading, body, docTitle) => {
    const b = (body || '').trim();
    if (b.length < 20) return;                     // 부스러기는 담지 않습니다
    const h = (heading || '').trim();
    const d = (docTitle || '').trim();
    // 문서 제목과 그 안의 소제목을 함께 답니다 (둘이 같으면 한 번만).
    const full = d && h && !h.includes(d) && !d.includes(h) ? d + ' — ' + h : (h || d);
    out.push({ ord: out.length, heading: full.slice(0, 200) || null, body: b });
  };

  // [표] … [본문] 구분을 그대로 씁니다 (extractText 가 붙여 둔 것입니다).
  const tablePart = (text.match(/\[표\]\n([\s\S]*?)(?=\n\[본문\]|$)/) || [])[1] || '';
  const bodyPart = (text.match(/\[본문\]\n([\s\S]*)$/) || [])[1]
                || (tablePart ? '' : text);

  for (const block of tablePart.split(/\n\s*\n/)) {
    const rows = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!rows.length) continue;
    // 첫 줄에 값이 없으면 머리글로 봅니다 (제목 | 강사 | 수강료 …).
    const header = rows.length > 1 && !/\d/.test(rows[0]) ? rows[0] : null;
    const data = header ? rows.slice(1) : rows;
    for (let i = 0; i < data.length; i += tableRows) {
      const slice = data.slice(i, i + tableRows);
      push(header, (header ? header + '\n' : '') + slice.join('\n'));
    }
  }

  // 본문은 제목처럼 보이는 줄에서 끊습니다 — 짧고, 문장부호로 끝나지 않는 줄.
  const looksLikeHeading = (l) =>
    l.length <= 40 && !/[.。!?]$/.test(l) && !/\|/.test(l) && /\S/.test(l);

  // 문서 전체의 제목은 조각마다 함께 답니다.
  //
  // 표에 머리글을 조각마다 다시 붙이는 것과 같은 이유입니다. '효도버스 노선 안내'
  // 라는 제목의 글을 조각내면, 두 번째 조각부터는 '양재노인종합복지관 (22271)'
  // 같은 <소제목>만 남습니다. 그 조각에는 시각이 가득한데도 '효도버스' 라는 말이
  // 없어서, 어르신이 "효도버스 몇 시에 와요" 하고 물으시면 검색에서 밀려났습니다.
  //
  // Splitting "Hyodo Bus route guide" leaves later chunks headed only by a stop
  // name. Those chunks hold all the times, but no longer contain the words the
  // senior used, so they lost to a chunk that merely promised a timetable.
  let docTitle = null;
  let heading = null;
  let buf = [];
  let size = 0;
  const flush = () => { if (buf.length) push(heading, buf.join('\n')); buf = []; size = 0; };

  for (const line of bodyPart.split('\n')) {
    const l = line.trim();
    // 빈 줄은 기록의 경계입니다 — 공지 한 건, 강좌 한 묶음.
    //
    // 무시하고 이어 붙이면 서로 다른 공지가 한 조각에 섞이고, 그 조각의 제목은
    // 맨 앞 공지의 제목이 됩니다. 너무 잘게 끊기지 않도록, 어느 정도 쌓였을 때만
    // 끊습니다.
    //
    // A blank line is a record boundary. Ignoring it glued unrelated notices into
    // one chunk that then carried the first notice's title. Only break once the
    // buffer holds enough to stand on its own.
    if (!l) { if (size >= 200) flush(); continue; }

    // 구획이 바뀌면 <반드시> 끊습니다 — 크기와 상관없이.
    //
    // 한 조각이 1호차 끝과 2호차 머리를 함께 물고 있으면, 그 조각의 제목은
    // '1호차' 인데 본문에는 2호차 시각이 들어 있게 됩니다. 나중에 그 조각을 읽은
    // 모델은 2호차 시각을 1호차 것으로 말합니다 — 실제로 그렇게 됐습니다.
    // 어르신은 오지 않는 버스를 기다리십니다.
    //
    // A chunk straddling "1호차" and "2호차" is headed by one and filled with the
    // other's times, and the model then reads them out under the wrong bus.
    // Observed. The cost is someone waiting for a bus that is not coming.
    if (SECTION.test(l) && buf.length) flush();

    if (size && size + l.length > maxChars) flush();
    if (!buf.length && looksLikeHeading(l)) {
      heading = l;
      // 첫 제목, 또는 '#' 로 시작하는 줄을 문서 제목으로 봅니다.
      if (!docTitle || /^#/.test(l)) docTitle = l.replace(/^#+\s*/, '');
    }
    buf.push(l);
    size += l.length + 1;
  }
  flush();

  return out.map((c, i) => ({ ...c, ord: i }));
}

// ---------------------------------------------------------------- 한 건 갱신
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 다음 서비스에서도 똑같이 실패할 종류의 오류.
//
// 계정 한도나 크레딧이 떨어진 것은 '이 서비스만의 문제' 가 아닙니다. 그런데도
// 예전에는 남은 서비스를 끝까지 돌면서 실패할 것이 뻔한 호출을 계속 던졌습니다.
// 2026-09-18 실행에서 아홉 번이 그렇게 낭비되었습니다 — 시간도, 남은 한도도.
//
// An account limit is not a per-service problem, but the run used to keep going
// and fire eight more calls that could only fail. Stop at the first one.
const FATAL =
  /usage limit|credit balance|quota|billing|insufficient|invalid x-api-key|authentication_error|permission_error/i;

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

  // JSON 으로 온 것은 이미 글로 펴져 있습니다 (jsonToText). 그림을 찾을 때만
  // 원본을 봅니다 — 본문에 data: 주소로 박혀 있을 수 있습니다.
  const text = page.json || extractText(page.html);
  const src = page.html || page.raw || '';

  // 대문을 읽었으니, 거기서 한 걸음 더 — 강좌·시간표·신청 안내가 있을 만한 곳.
  // 실패는 한 장씩만 잃습니다. 하위 페이지 하나가 안 열린다고 그 서비스 전체가
  // 자료 없이 남으면, 고치기 전보다 나빠집니다.
  // raw 를 들고 다닙니다 — 그림은 글이 아니라 원본에서 찾아야 하고, 하위 페이지에
  // 붙어 있는 그림도 찾아야 하기 때문입니다.
  const pages = [{ url, title: null, kind: 'landing', parent: null, text,
                   http: page.httpStatus, raw: src }];
  const notes = [];

  // 네 장을 나란히 받아옵니다.
  //
  // 차례로 받으면 한 서비스가 그 기관의 느린 응답을 네 번 <이어서> 기다립니다.
  // 자바스크립트로 그리는 페이지는 한 장에 100초씩 걸리기도 해서, 서초50플러스
  // 센터 한 곳이 8분 23초였습니다. 같은 기관에 네 개의 요청을 동시에 보내는 것은
  // 브라우저가 그 페이지를 열 때 늘 하는 일이고, 네 개는 그보다 적습니다.
  //
  // In series, one service waits out the same slow host four times over — 8m23s
  // for a site whose pages each take ~100s to render. Four concurrent requests
  // to one host is fewer than a browser opens loading that same page.
  // 대문에서 고른 것 + 저희가 따로 찾아 둔 것 (extra-sources.json).
  const targets = [
    ...pickSubpages(src, url),
    ...extraSources(service.code).map((u) => ({ url: u, title: '자료 출처' })),
  ];

  const subs = await Promise.all(targets.map(async (sub) => {
    try {
      // 따라간 페이지는 한 번만 — 없어도 대문이 답합니다.
      const p = await get(sub.url, { tries: 1 });
      if (p.error) return { note: sub.url + ': ' + p.error };
      return { page: { url: sub.url, title: sub.title, kind: 'subpage', parent: url,
                       text: p.json || extractText(p.html), http: p.httpStatus,
                       raw: p.html || p.raw || '' } };
    } catch (e) { return { note: sub.url + ': ' + String(e.message || e).slice(0, 80) }; }
  }));
  for (const r of subs) {
    if (r.note) notes.push(r.note);
    else pages.push(r.page);
  }

  // 같은 메뉴를 다섯 번 세지 않습니다.
  //
  // extractText 는 <한 페이지 안에서> 되풀이되는 줄을 지웁니다. 그런데 한 기관의
  // 다섯 장은 머리글·메뉴·바닥글이 통째로 같습니다. 그것을 그대로 두면 방배
  // 느티나무쉼터가 3,211자를 가진 것처럼 보입니다 — 실제로 내용은 거의 없고
  // 메뉴만 네 번 더 있는 것인데도요. 그리고 그 부풀려진 숫자 때문에 "글이
  // 넉넉하다"고 판단해서, 정작 유일한 자료인 시간표 그림을 건너뛰었습니다.
  //
  // extractText drops lines repeated within one page, but five pages of one site
  // share their whole menu. Left in, Bangbae looked like it held 3,211 characters
  // when it held almost nothing and four more copies of its navigation — and that
  // inflated figure is what made the run skip the timetable poster, which was the
  // only thing on the site that answered anything.
  const seenLine = new Set();
  for (const p of pages) {
    p.text = p.text.split('\n')
      .filter((l) => {
        const k = l.trim();
        if (k.length < 4) return true;          // 짧은 줄은 표 칸일 수 있습니다
        if (seenLine.has(k)) return false;
        seenLine.add(k);
        return true;
      })
      .join('\n').trim();
  }

  // 겹치는 것을 걷어내고 나서 보니 남은 것이 없는 장은, 메뉴만 있던 장입니다.
  for (let i = pages.length - 1; i >= 1; i--) {
    if (pages[i].text.length < 200) {
      notes.push(pages[i].url + ': nav only (' + pages[i].text.length + ')');
      pages.splice(i, 1);
    }
  }

  // 그림은 <읽은 모든 장에서> 찾습니다.
  //
  // 예전에는 대문에서만 찾았습니다. 그러면 하위 페이지 본문에 붙어 있는 안내문은
  // 영영 안 보입니다 — 서초 공공셔틀의 시간표가 그 경우였습니다. 대문은 168자짜리
  // 껍데기이고, 시간표는 공지 JSON 안에 박혀 있습니다. 강좌 페이지에 붙은 포스터도
  // 같은 이유로 놓쳤을 것입니다.
  //
  // Images used to be picked from the front door only, so a notice embedded in a
  // sub-page was never seen — which is exactly where the shuttle timetable lives.
  const byUrl = new Map();
  for (const p of pages) {
    for (const i of pickImages(p.raw || '', p.url, { max: IMAGE_MAX })) {
      const prev = byUrl.get(i.url);
      if (!prev || prev.score < i.score) byUrl.set(i.url, i);
    }
  }
  const imgs = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, IMAGE_MAX);

  // 바뀌지 않았으면 여기서 멈춥니다 — <대문만이 아니라 따라간 장까지 함께> 보고
  // 판단합니다.
  //
  // 예전에는 대문 한 장의 해시만 봤습니다. 그러면 강좌표에 새 강좌가 열두 개
  // 올라와도 대문이 그대로면 '변경 없음' 으로 지나갑니다 — 이번 라운드에서 새로
  // 얻은 바로 그 페이지가, 첫날 이후로는 영영 다시 읽히지 않는 셈입니다.
  // 페이지를 받아오는 것은 값이 싸고, 비싼 것은 모델 호출입니다. 그러니 받아올
  // 것은 다 받아오고, 바뀐 것이 없을 때 모델을 부르지 않으면 됩니다.
  //
  // Hashing only the front door meant twelve new courses on the course page went
  // unnoticed whenever the homepage happened not to change — the very page this
  // round added would have been read once and then never again. Fetching is
  // cheap and the model call is not, so fetch everything and skip the model.
  const h = hash(pages.map((p) => p.url + '\n' + p.text).join('\n')
    + '\n' + imgs.map((i) => i.url).join('\n'));

  if (!force && before && before.content_hash === h && before.status === 'ok') {
    await db.query(
      'UPDATE service_sources SET fetched_at = now(), updated_at = now() WHERE service_id = $1',
      [service.id]);
    return { code: service.code, status: 'unchanged', chars: text.length };
  }

  // 그림은 <읽을 것이 없을 때만> 봅니다.
  //
  // 모델 호출이 한 장에 한 번씩 들고, 대부분의 그림은 장식입니다. 글이 이미
  // 넉넉한 페이지에서까지 포스터를 옮겨 적으면 하루치 비용이 쓸데없이 몇 배가
  // 됩니다. 반대로 글이 없는 곳에서는 그림이 유일한 자료입니다 — 방배느티나무
  // 쉼터의 시간표가 정확히 그런 경우입니다.
  //
  // Vision costs a model call per image and most images are decoration, so it is
  // taken only where the text came up short — which is exactly where the picture
  // is the only thing there is.
  const vis = deps.describeImage || describeImage;
  const bin = deps.fetchBinary || fetchBinary;
  // 그림을 볼 것인가.
  //
  // ① 글이 얼마 없으면 봅니다 — 그림이 유일한 자료인 경우입니다.
  // ② 글이 넉넉해도, <본문에 박혀 있는 그림>이 있으면 봅니다.
  //
  // ②가 필요한 이유: 게시판 편집기로 본문에 끼워 넣은 그림은 <내용>입니다.
  // 틀에 박힌 배너나 로고와 다릅니다 — 담당자가 그 자리에 일부러 붙인 것이고,
  // 한국 관공서 공지에서는 시간표·요금표가 대개 이 모양입니다. 글자 수만 보고
  // 건너뛰면, 공지 열여섯 건의 제목은 읽고 정작 시간표는 못 읽습니다.
  //
  // An image the editor embedded in the body is content, not furniture: in Korean
  // public notices a timetable or price list is usually exactly that. Judging by
  // character count alone would read sixteen notice titles and miss the timetable.
  const totalText = pages.reduce((n, p) => n + p.text.length, 0);
  const embedded = imgs.some((i) => i.data);
  const thinText = totalText < VISION_TEXT_FLOOR || embedded;

  if (thinText && env.ANTHROPIC_API_KEY) {
    // 전에 읽어 둔 그림은 다시 읽지 않습니다.
    //
    // 이 CMS 들은 올린 시각으로 파일 이름을 짓습니다 — 포스터가 바뀌면 주소도
    // 바뀝니다. 그러니 같은 주소면 같은 그림이고, 매일 밤 같은 시간표를 다시
    // 눈으로 읽는 것은 값만 치르는 일입니다. --force 는 이 아낌을 건너뜁니다.
    //
    // These systems name files by upload time, so a new poster is a new URL: the
    // same URL is the same picture, and re-reading it nightly buys nothing.
    const known = new Map((await db.all(
      `SELECT url, text, http_status FROM service_sources
        WHERE service_id = $1 AND kind = 'image' AND text IS NOT NULL`, [service.id]))
      .map((r) => [r.url, r]));

    for (const img of imgs) {
      const seen = !force && known.get(img.url);
      if (seen) {
        pages.push({ url: img.url, title: img.title || null, kind: 'image', parent: url,
                     text: seen.text, http: seen.http_status });
        continue;
      }
      try {
        // 본문에 박혀 있던 그림은 받아올 것이 없습니다 — 바이트가 이미 있습니다.
        const got = img.data
          ? { httpStatus: 200, buf: img.data, type: img.type, error: null }
          : await bin(img.url);
        if (got.error || !got.buf) { notes.push(img.url + ': ' + (got.error || 'no bytes')); continue; }
        if (got.buf.length < MIN_IMAGE_BYTES) { notes.push(img.url + ': decoration'); continue; }
        if (got.buf.length > MAX_IMAGE_BYTES) { notes.push(img.url + ': too large'); continue; }
        const said = await vis(service, img, got.buf, got.type);
        if (!said) { notes.push(img.url + ': nothing in it'); continue; }
        pages.push({ url: img.url, title: img.title || null, kind: 'image', parent: url,
                     text: said, http: got.httpStatus });
      } catch (e) { notes.push(img.url + ': ' + String(e.message || e).slice(0, 80)); }
    }
  }

  // 한 서비스의 자료를 한 덩어리로 묶어 한 번만 요약합니다 — 페이지마다 요약하면
  // 같은 전화번호를 네 번 적어 놓고 정작 강좌표는 자리가 없습니다.
  const merged = pages.map((p) =>
    `---- ${p.kind === 'image' ? '그림' : '페이지'}: ${p.title || p.url} (${p.url}) ----\n${p.text}`
  ).join('\n\n');

  let facts;
  try { facts = await sum(service, merged); }
  catch (e) {
    // 왜 실패했는지를 <화면에> 내보냅니다.
    //
    // 예전에는 여기서 'summary failed' 라는 말만 돌려주었습니다. 진짜 이유는
    // 데이터베이스에만 적혔고, 그것을 읽어 보기 전에는 아무도 알 수 없었습니다.
    // 실제로 2026-09-18 에 아홉 건이 이 문구로 실패했는데, 데이터베이스에 적힌
    // 진짜 이유는 "You have reached your specified API usage limits" 였습니다 —
    // 화면만 보고는 코드가 고장 난 것처럼 보였습니다.
    //
    // It used to return the words "summary failed" and put the real message in
    // the database, where nobody would look. Nine services failed this way and
    // the actual reason was an API usage limit — from the console it looked like
    // broken code.
    const why = String((e && e.message) || e || '').replace(/\s+/g, ' ').trim();
    await save(service, url, { status: 'error', http: page.httpStatus,
                               error: 'summary: ' + why.slice(0, 160),
                               hash: h, raw: text.length, kind: 'landing', text,
                               facts: before && before.facts, facts_en: before && before.facts_en });
    return { code: service.code, status: 'error', reason: why.slice(0, 120),
             fatal: FATAL.test(why) };
  }

  // 읽어 온 글에 근거가 없는 줄은 여기서 걷어냅니다 (③-b). 모델이 빈 곳을
  // 채우려 드는 것은 프롬프트로 완전히 막히지 않으므로, 기계로 한 번 더 봅니다.
  // 카탈로그 행도 근거입니다 — 기관 이름과 설명은 클라이언트가 직접 준 자료이고,
  // 요약 프롬프트에도 함께 들어갑니다. 여기서 빼면 '기관 이름을 지어냈다'고
  // 잘못 판정합니다.
  const checked = dropUngrounded(facts,
    [service.sub, service.description, service.org, merged].filter(Boolean).join('\n'));
  if (checked.dropped) notes.push(checked.dropped + ' ungrounded line(s) dropped');
  facts = checked;

  const empty = !facts.ko;
  // 요약은 대문 줄에만 답니다. 키오스크는 facts 가 있는 줄 하나를 읽으므로
  // (kiosk-context.js), 이 줄이 그 서비스를 대표합니다. 나머지 장은 글만 남겨
  // 두었다가 질문이 들어온 뒤에 꺼내 씁니다.
  await save(service, url, { status: empty ? 'empty' : 'ok', http: page.httpStatus,
                             error: notes.length ? notes.join(' · ').slice(0, 400) : null,
                             hash: h, raw: text.length, kind: 'landing', text,
                             facts: facts.ko, facts_en: facts.en });

  for (const p of pages.slice(1)) {
    await save(service, p.url, { status: 'ok', http: p.http, error: null,
                                 hash: hash(p.text), raw: p.text.length,
                                 kind: p.kind, title: p.title, parent: p.parent, text: p.text });
  }

  // 사이트에서 사라진 장은 우리 쪽에서도 지웁니다.
  //
  // 이 CMS 들은 올린 시각으로 파일 이름을 짓기 때문에, 포스터가 새것으로 바뀌면
  // <새 주소>가 생깁니다. 옛 줄을 그대로 두면 지난 분기 시간표와 이번 분기
  // 시간표가 나란히 남아, 어느 쪽이 어르신께 나갈지 알 수 없게 됩니다. 지나간
  // 시간표를 사실인 양 읽어 드리는 것이야말로 이 층이 막으려던 일입니다.
  //
  // 오늘 <못 읽은> 장은 지우지 않습니다 — 여전히 링크되어 있고 잠깐 안 열렸을
  // 뿐입니다. 지우는 것은 '링크에서 사라진' 장뿐입니다.
  //
  // A replaced poster gets a new URL, so leaving the old row behind keeps last
  // quarter's timetable alive beside this quarter's, with no way to say which a
  // senior will be read. A page that merely failed today is still linked and is
  // kept; only pages the site no longer points at are removed.
  const current = [url, ...targets.map((s) => s.url), ...imgs.map((i) => i.url),
                   ...pages.filter((p) => p.kind === 'image').map((p) => p.url)];
  const gone = await db.query(
    'DELETE FROM service_sources WHERE service_id = $1 AND url <> ALL($2::text[])',
    [service.id, current]);
  if (gone.rowCount) notes.push(gone.rowCount + ' page(s) no longer linked, removed');

  // 조각은 이 서비스가 지금 가진 <모든> 장에서 다시 만듭니다 — 이번에 못 읽은
  // 하위 페이지의 지난번 글도 그대로 들어갑니다. 대문은 열렸는데 하위 한 장이
  // 흔들렸다고 어제까지 답하던 강좌표가 사라지면, 고치기 전보다 나빠집니다.
  const chunks = await rechunk(service);

  return { code: service.code, status: empty ? 'empty' : 'ok',
           chars: merged.length, factChars: (facts.ko || '').length,
           pages: pages.length, subpages: pages.filter((p) => p.kind === 'subpage').length,
           images: pages.filter((p) => p.kind === 'image').length,
           chunks, notes };
}

/**
 * 이 서비스의 조각을 다시 만듭니다.
 *
 * 통째로 지우고 다시 넣습니다. 조각은 파생물이라 원본이 바뀌면 의미가 없고,
 * 맞춰 고치는 것보다 다시 만드는 편이 틀릴 구석이 없습니다. 한 번의 트랜잭션
 * 안에서 하므로, 그 사이에 질문이 들어와도 빈 상태를 보지 않습니다.
 *
 * Chunks are derived data: rebuilt, not reconciled. Doing it in one transaction
 * means a conversation landing mid-sync never sees an empty shelf.
 */
async function rechunk(service) {
  const rows = await db.all(
    `SELECT id, url, title, kind, text FROM service_sources
      WHERE service_id = $1 AND text IS NOT NULL AND text <> ''
      ORDER BY CASE kind WHEN 'landing' THEN 0 WHEN 'subpage' THEN 1 ELSE 2 END, url`,
    [service.id]);

  let n = 0;
  await db.tx(async (client) => {
    await client.query('DELETE FROM source_chunks WHERE service_id = $1', [service.id]);
    for (const row of rows) {
      for (const c of chunkText(row.text)) {
        await client.query(
          `INSERT INTO source_chunks
             (service_id, source_id, url, title, kind, ord, heading, body, chars)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [service.id, row.id, row.url, row.title, row.kind, n, c.heading, c.body, c.body.length]);
        n++;
      }
    }
  });
  return n;
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

  // 읽지 못했을 때는 지난번 글도 그대로 둡니다 (facts 와 같은 이유입니다) —
  // COALESCE 로, 넘겨받은 것이 없으면 이미 있던 것을 지키게 합니다.
  await db.query(
    `INSERT INTO service_sources
       (service_id, url, fetched_at, status, http_status, error, content_hash, raw_chars,
        facts, facts_en, fact_chars, kind, title, parent_url, text)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (service_id, url) DO UPDATE SET
       fetched_at = ${keepUsable ? 'service_sources.fetched_at' : 'now()'},
       status = excluded.status, http_status = excluded.http_status,
       error = excluded.error, content_hash = excluded.content_hash,
       raw_chars = excluded.raw_chars, facts = excluded.facts,
       facts_en = excluded.facts_en, fact_chars = excluded.fact_chars,
       kind = excluded.kind,
       title = COALESCE(excluded.title, service_sources.title),
       parent_url = COALESCE(excluded.parent_url, service_sources.parent_url),
       text = COALESCE(excluded.text, service_sources.text),
       updated_at = now()`,
    [service.id, url, status, f.http || null, f.error || null, f.hash || null,
     f.raw || 0, f.facts || null, f.facts_en || null, (f.facts || '').length,
     f.kind || 'landing', f.title || null, f.parent || null, f.text || null]);
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
    // 계정 한도에 걸렸으면 여기서 멈춥니다 — 남은 서비스도 똑같이 실패합니다.
    if (r.fatal) break;
  }
  return out;
}

module.exports = {
  fetchPage, fetchBinary, extractText, tableToText, summarise, worthReadingAnyway,
  pickSubpages, pickImages, describeImage, chunkText, tidyUrl, rechunk,
  extraSources, jsonToText,
  dropUngrounded, lineIsGrounded,
  refreshOne, refreshAll,
};
