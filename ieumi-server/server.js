// 이음이 백엔드 — STT(클로바) → Claude → TTS(클로바) + 멀티테넌트 API + 정적 서빙
// 실행: node ieumi-server/server.js  →  http://localhost:8791/로그인.html
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const env = require('./env');
const db = require('./db');
const auth = require('./auth');
const api = require('./api');
const kioskContext = require('./kiosk-context');
const jobs = require('./jobs');

const AKEY = env.ANTHROPIC_API_KEY;
const CID = env.CLOVA_API_KEY_ID, CSEC = env.CLOVA_API_KEY;
// 문자발송 — 알리고(간편) 또는 네이버 SENS
const ALIGO_KEY = env.ALIGO_API_KEY, ALIGO_UID = env.ALIGO_USER_ID, ALIGO_SENDER = env.ALIGO_SENDER;
const ALIGO_READY = !!(ALIGO_KEY && ALIGO_UID && ALIGO_SENDER);
const SENS_AK = env.NCP_SENS_ACCESS_KEY, SENS_SK = env.NCP_SENS_SECRET_KEY,
      SENS_SVC = env.NCP_SENS_SERVICE_ID, SMS_FROM = env.SMS_FROM_NUMBER;
const SENS_READY = !!(SENS_AK && SENS_SK && SENS_SVC && SMS_FROM);
const SMS_READY = ALIGO_READY || SENS_READY;
const MODEL = env.CLAUDE_MODEL || 'claude-sonnet-5';   // 최신·저렴·빠름 (§3-6)
const SPEAKER = env.CLOVA_SPEAKER || 'nara';   // 따뜻한 여성 음성
const SPEED = env.CLOVA_SPEED || '1';          // 0 기본, 양수=천천히(어르신용)
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8791;

// ---- Proxy support: Node ignores HTTPS_PROXY, unlike curl. Where the API is only
// reachable through a local proxy, tunnel via CONNECT. No proxy set = plain fetch.
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
function proxyFetch(url, opts = {}) {
  const u = new URL(url), px = new URL(PROXY);
  const body = opts.body ? Buffer.from(opts.body) : null;
  return new Promise((resolve, reject) => {
    const c = http.request({ host: px.hostname, port: px.port || 80, method: 'CONNECT',
      path: u.hostname + ':443', headers: { host: u.hostname + ':443' } });
    c.on('error', reject);
    c.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) return reject(new Error('proxy CONNECT ' + pres.statusCode));
      const headers = Object.assign({}, opts.headers);
      if (body) headers['content-length'] = body.length;
      const req = https.request({ socket, servername: u.hostname, host: u.hostname, agent: false,
        path: u.pathname + u.search, method: opts.method || 'GET', headers }, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;

        // Streaming callers get the response as it arrives. Buffering it here
        // would silently turn a streamed reply back into a blocking one for
        // anyone behind a proxy — the delay §3-6 is about, reintroduced.
        if (opts.stream) {
          return resolve({ ok, status: res.statusCode, body: res,
            text: async () => { let s = ''; for await (const c of res) s += c; return s; } });
        }

        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => { const buf = Buffer.concat(chunks); resolve({
          ok, status: res.statusCode,
          json: async () => JSON.parse(buf.toString('utf8')),
          text: async () => buf.toString('utf8'),
          arrayBuffer: async () => buf }); });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    c.end();
  });
}
const pfetch = (url, opts) => PROXY ? proxyFetch(url, opts) : fetch(url, opts);
// 프롬프트 구성은 prompt.js 로, 문자 본문은 sms.js 로 분리했습니다 (테스트 가능하도록).
const { DEFAULT_PERSONA, systemBlocks, parseModelOutput } = require('./prompt');
const { smsContent } = require('./sms');

// A kiosk identifies its center with a token in its URL; without one the server
// falls back to the neutral default persona. Cached — see kiosk-context.js.
const personaFor = (kioskToken) => kioskContext.forToken(kioskToken);

/**
 * 이 복지관에 안내할 일자리 — the postings for one centre.
 *
 * Synced from data.go.kr into the database (jobs.js): the API has no region
 * filter and takes tens of seconds per call, so neither could happen while a
 * senior waits. `fallback` is whatever the page sent, used only when the kiosk
 * has no centre — the static demo — so that still works with no database.
 */
async function jobsForCenter(persona, fallback, history) {
  const centerRegion = persona && persona.region;
  try {
    // 어르신이 지역을 말씀하셨으면 그 지역이 우선입니다.
    //
    // A senior standing in a Seocho kiosk may well be asking about 강남 — where a
    // son lives, where the bus goes. Answering with the centre's own district
    // regardless is the failure the client's next test is aimed at. The named
    // district wins over the centre's whenever there is one.
    const asked = jobs.detectRegion(history, await jobs.regionVocabulary());
    if (asked) {
      const found = await jobs.forRegion(asked);
      return { jobs: found.jobs.map(jobs.toPromptJob), scope: found.scope,
               region: found.region, centerRegion: centerRegion || '', asked: asked.said };
    }
  } catch (e) {
    console.error('[jobs] region lookup failed:', e.message);
  }

  if (centerRegion) {
    try {
      const found = await jobs.forCenterRegion(centerRegion);
      if (found.jobs.length) {
        return { jobs: found.jobs.map(jobs.toPromptJob), scope: found.scope,
                 region: found.region, centerRegion };
      }
      return { jobs: [], scope: 'none', region: found.region, centerRegion };
    } catch (e) {
      console.error('[jobs] lookup failed:', e.message);
    }
  }
  const list = Array.isArray(fallback) ? fallback : [];
  return { jobs: list, scope: list.length ? 'sigungu' : 'none', region: '', centerRegion: '' };
}

// Anthropic Messages API: history must begin with a user turn, and same-role
// turns must not repeat. The kiosk seeds history with Ieumi's spoken greeting and
// can queue two assistant lines in a row, so normalise before sending.
function toMessages(history) {
  const out = [];
  for (const m of history || []) {
    if (!m || !m.content) continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    if (!out.length && role !== 'user') continue;              // drop the leading greeting
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n' + m.content;  // merge repeats
    else out.push({ role, content: String(m.content) });
  }
  return out;
}

// 생각 끄기 — thinking off (§3-6).
// Some current models reason before answering unless told not to. For a spoken
// conversation that is dead air: measured on Sonnet 5, leaving it on pushed the
// first token from 1.2s to 4.0s. A senior asking where the night clinic is does
// not need deliberation, so the chat path asks for none.
//
// Not every model accepts the parameter, so a rejection falls back to sending
// the request without it rather than failing the call.
const THINKING_OFF = { type: 'disabled' };

const chatBody = (history, jobsInfo, model, persona, stream, opts = {}) => {
  const { thinking = true, cache = true } = opts;
  const msgs = toMessages(history);
  if (!msgs.length) throw new Error('no user message yet');
  return JSON.stringify({
    model: model || MODEL,
    max_tokens: 400,
    system: systemBlocks(persona, jobsInfo, { cache }),
    messages: msgs,
    ...(thinking ? { thinking: THINKING_OFF } : {}),
    ...(stream ? { stream: true } : {}),
  });
};
const CLAUDE_HEADERS = {
  'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
};
/**
 * 거절당한 기능만 빼고 다시 보냅니다 — drop one rejected feature and retry.
 *
 * A model that will not take `thinking`, or an account that will not take
 * `cache_control`, must cost us that feature and never the conversation. Each
 * flag only ever goes off, so this cannot loop.
 */
const degrade = (status, detail, opts) => {
  if (status !== 400) return null;
  const d = String(detail || '');
  if (/thinking/i.test(d) && opts.thinking !== false) return { ...opts, thinking: false };
  if (/cache/i.test(d) && opts.cache !== false) return { ...opts, cache: false };
  return null;
};

async function callClaude(history, jobsInfo, model, persona) {
  let opts = {};
  for (;;) {
    const r = await pfetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: CLAUDE_HEADERS,
      body: chatBody(history, jobsInfo, model, persona, false, opts),
    });
    const j = await r.json();
    if (j.error) {
      const next = degrade(r.status, j.error.message, opts);
      if (next) { opts = next; continue; }
      throw new Error(j.error.message || 'claude error');
    }
    const text = (j.content && j.content[0] && j.content[0].text) || '';
    const { reply, meta } = parseModelOutput(text);
    return { raw: text, parsed: { ...meta, reply }, usage: j.usage };
  }
}

/**
 * 응답 스트리밍 (§3-6 ①) — stream the reply as it is written.
 *
 * `onText` is called with each new piece of what Ieumi will say, so the kiosk
 * can start synthesising the first sentence while the rest is still being
 * written. The trailing JSON line is withheld: it is data for the dashboards,
 * not something to read aloud.
 *
 * Returns the same shape as callClaude so both paths stay interchangeable.
 */
async function callClaudeStream(history, jobsInfo, model, persona, onText) {
  // Both transports expose an async-iterable body: WHATWG fetch a ReadableStream,
  // the proxy tunnel a Node IncomingMessage. The loop below reads either.
  const open = (opts) => pfetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: CLAUDE_HEADERS, stream: true,
    body: chatBody(history, jobsInfo, model, persona, true, opts),
  });

  let opts = {};
  let r = await open(opts);
  while (!r.ok) {
    const detail = await r.text().catch(() => '');
    const next = degrade(r.status, detail, opts);
    if (!next) throw new Error('claude stream ' + r.status + ' ' + detail.slice(0, 200));
    opts = next;
    r = await open(opts);
  }
  if (!r.body) throw new Error('claude stream ' + r.status + ' (no body)');

  let acc = '';        // everything the model has written
  let sent = 0;        // how much of it we have handed to onText
  let inMeta = false;  // true once the trailing JSON line has begun
  let usage = null;
  let buf = '';
  const decoder = new TextDecoder();

  const flush = () => {
    if (inMeta) return;
    const at = acc.indexOf('\n{');
    if (at >= 0) {
      if (at > sent) onText(acc.slice(sent, at));
      sent = at;
      inMeta = true;
      return;
    }
    // Hold back a trailing newline: it may be the start of "\n{", and emitting
    // it would leak the first character of the metadata line into the speech.
    const safe = acc.endsWith('\n') ? acc.length - 1 : acc.length;
    if (safe > sent) { onText(acc.slice(sent, safe)); sent = safe; }
  };

  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }

      if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
        acc += ev.delta.text;
        flush();
      } else if (ev.type === 'message_delta' && ev.usage) {
        usage = { ...(usage || {}), ...ev.usage };
      } else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
        usage = { ...(usage || {}), ...ev.message.usage };
      } else if (ev.type === 'error') {
        throw new Error((ev.error && ev.error.message) || 'claude stream error');
      }
    }
  }

  const { reply, meta } = parseModelOutput(acc);
  // Whatever the parser recovered but streaming did not emit (a model that
  // ignored the format, say) still has to be spoken.
  if (reply.length > sent) onText(reply.slice(sent));

  return { raw: acc, parsed: { ...meta, reply }, usage };
}

async function clovaTTS(text, speaker, speed) {
  const body = new URLSearchParams({
    speaker: speaker || SPEAKER, text, format: 'mp3', speed: speed || SPEED,
  });
  const r = await pfetch('https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts', {
    method: 'POST',
    headers: { 'X-NCP-APIGW-API-KEY-ID': CID, 'X-NCP-APIGW-API-KEY': CSEC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error('TTS ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

async function clovaSTT(audioBuf) {
  const r = await pfetch('https://naveropenapi.apigw.ntruss.com/recog/v1/stt?lang=Kor', {
    method: 'POST',
    headers: { 'X-NCP-APIGW-API-KEY-ID': CID, 'X-NCP-APIGW-API-KEY': CSEC, 'Content-Type': 'application/octet-stream' },
    body: audioBuf,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('STT ' + r.status);
  return j.text || '';
}

// ---- 문자발송 ----
async function sendSMS(to, content) {
  to = (to || '').replace(/\D/g, '');
  if (ALIGO_READY) return sendAligo(to, content);
  if (SENS_READY) return sendSENS(to, content);
  return { sent: false, reason: 'no_sms_key' };
}
async function sendAligo(to, content) {
  const form = new URLSearchParams({ key: ALIGO_KEY, user_id: ALIGO_UID, sender: ALIGO_SENDER,
    receiver: to, msg: content, msg_type: content.length > 45 ? 'LMS' : 'SMS', title: '이음이 일자리 안내' });
  const r = await pfetch('https://apis.aligo.in/send/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const j = await r.json().catch(() => ({}));
  return { sent: String(j.result_code) === '1', reason: String(j.result_code) === '1' ? '' : ('aligo:' + (j.message || r.status)) };
}
async function sendSENS(to, content) {
  const ts = Date.now().toString();
  const uri = `/sms/v2/services/${SENS_SVC}/messages`;
  const sig = crypto.createHmac('sha256', SENS_SK).update(`POST ${uri}\n${ts}\n${SENS_AK}`).digest('base64');
  const body = JSON.stringify({ type: content.length > 45 ? 'LMS' : 'SMS', from: SMS_FROM, content, messages: [{ to }] });
  const r = await pfetch('https://sens.apigw.ntruss.com' + uri, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8',
      'x-ncp-apigw-timestamp': ts, 'x-ncp-iam-access-key': SENS_AK, 'x-ncp-apigw-signature-v2': sig }, body });
  const j = await r.json().catch(() => ({}));
  return { sent: r.ok && j.statusCode === '202', reason: r.ok ? '' : ('sens_' + r.status) };
}

// Doubles as the allow-list for static serving: an extension that is not here
// is not served at all. Add a type only when a page genuinely loads it.
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

function readBody(req) {
  return new Promise((res) => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => res(Buffer.concat(b))); });
}
const cors = (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); };
const json = (res, code, obj) => { cors(res); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  try {
    // /api/* — multi-tenant REST layer (cookie auth, same-origin only).
    if (await api.handle(req, res, u)) return;

    if (u.pathname === '/chat' && req.method === 'POST') {
      const { history, jobs, model, c, stream } = JSON.parse((await readBody(req)).toString() || '{}');
      const persona = await personaFor(c || u.searchParams.get('c'));
      const chosen = model || persona.chat_model;

      // 일자리는 서버가 이 복지관 지역으로 직접 찾습니다 (§6-P2).
      // The postings come from the database, scoped to the centre's own region —
      // not from whatever the browser sends. A kiosk opened without a token (the
      // static demo) still falls back to the list it was given.
      const jobsInfo = await jobsForCenter(persona, jobs, history);

      // Claude answers with a 1-based index into the service list we sent it —
      // an index it cannot get wrong the way it could invent a code. Resolve it
      // here so the kiosk only ever handles the stable code.
      const attachService = (out) => {
        const picked = Number(out.parsed && out.parsed.service);
        const svc = Number.isInteger(picked) && picked > 0 ? persona.services[picked - 1] : null;
        if (svc) { out.serviceCode = svc.code; out.serviceName = svc.sub; }
        return out;
      };

      // `pick` is the same kind of index, into the job list — and it has to be
      // resolved in the same place, for the same reason. It used to be resolved
      // in the browser against a hardcoded demo array, so a senior asking about
      // a real posting was texted a different, invented one. The list the
      // prompt was built from is the only list that can answer this.
      const attachJobs = (out) => {
        out.jobs = jobsInfo.jobs;
        const picked = Number(out.parsed && out.parsed.pick);
        if (Number.isInteger(picked) && picked > 0 && jobsInfo.jobs[picked - 1]) {
          out.job = jobsInfo.jobs[picked - 1];
        }
        return out;
      };
      const attach = (out) => attachJobs(attachService(out));

      if (stream) {
        cors(res);
        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',   // ask intermediaries not to hold the chunks
        });
        if (res.socket) res.socket.setNoDelay(true);

        const line = (obj) => res.write(JSON.stringify(obj) + '\n');
        try {
          const out = await callClaudeStream(history || [], jobsInfo, chosen, persona,
            (text) => line({ t: text }));
          line({ done: true, ...attach(out) });
        } catch (e) {
          line({ done: true, error: String(e.message || e) });
        }
        return res.end();
      }

      return json(res, 200, attach(
        await callClaude(history || [], jobsInfo, chosen, persona)));
    }
    if (u.pathname === '/tts' && req.method === 'POST') {
      const { text, c } = JSON.parse((await readBody(req)).toString() || '{}');
      const persona = await personaFor(c || u.searchParams.get('c'));
      const audio = await clovaTTS(text || '', persona.voice_speaker, persona.voice_speed);
      cors(res); res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(audio);
    }
    if (u.pathname === '/stt' && req.method === 'POST') {
      const text = await clovaSTT(await readBody(req));
      return json(res, 200, { text });
    }
    if (u.pathname === '/sms' && req.method === 'POST') {
      const { to, jobId, serviceCode, summary, kind, c } =
        JSON.parse((await readBody(req)).toString() || '{}');
      // 문자 머리말도 복지관마다 다릅니다 — 어느 복지관이 보낸 문자인지 알 수 있어야 합니다.
      const persona = await personaFor(c || u.searchParams.get('c'));
      const content = await smsContent(persona, { jobId, serviceCode, summary, kind });
      if (!content) return json(res, 200, { sent: false, reason: 'nothing_to_send' });
      const out = await sendSMS(to || '', content);
      return json(res, 200, { ...out, content });
    }
    if (u.pathname === '/health') {
      return json(res, 200, {
        ok: true, model: MODEL, speaker: SPEAKER, sms: SMS_READY,
        db: db.DATABASE_URL ? (await db.ping() ? 'connected' : 'unreachable') : 'not configured',
      });
    }

    // ---- 정적 파일 ----
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/이음이-키오스크-프로토타입.html';
    const fp = path.resolve(ROOT, '.' + p);
    const rel = path.relative(ROOT, fp);
    const seg = rel.split(path.sep);
    // Never serve outside the project, hidden files (.env / .git), or the server source dir.
    // Never serve outside the project, hidden files (.env / .git), or the server
    // source directory — and beyond that, serve only the file types the app is
    // actually made of. An allow-list rather than a block-list: the repository
    // also holds PROJECT.md (the business and revenue model), deployment config
    // and SQL, none of which the browser needs and none of which should be one
    // guessed URL away once this is public.
    const blocked = !rel || rel.startsWith('..') || path.isAbsolute(rel)
      || seg.some(x => x.startsWith('.')) || seg[0] === 'ieumi-server'
      || !MIME[path.extname(fp).toLowerCase()];
    if (blocked || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    cors(res); res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    return fs.createReadStream(fp).pipe(res);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, async () => {
  const base = `http://localhost:${PORT}`;
  console.log(`\n이음이 백엔드 실행  (model=${MODEL}, voice=${SPEAKER})`);
  console.log(`  로그인       ${base}/로그인.html`);
  console.log(`  프로토타입    ${base}/이음이-키오스크-프로토타입.html`);
  if (!db.DATABASE_URL) {
    console.log(`\n  ⚠ DATABASE_URL 미설정 — 대시보드와 로그인은 동작하지 않습니다.`);
    console.log(`    (not set — the dashboards and login will not work; see README)`);
  } else {
    console.log(`  DB           ${await db.ping() ? '연결됨 connected' : '연결 실패 unreachable'}`);

    // 지역 사전 미리 채우기 — the DISTINCT over the postings table takes a couple
    // of seconds, and a conversation must never be the thing that pays for it
    // (§3-6). Warming it here means it is ready before the first caller, and it
    // refreshes in the background from then on.
    jobs.warmRegionVocabulary()
      .then((v) => console.log(`  지역 사전      ${v.length}개 지역 (job regions ready)`))
      .catch(() => {});
  }
});

// 배포·재시작 시 SIGTERM 을 받습니다 — 처리 중인 요청을 끝내고 DB 연결을 닫습니다.
// Hosts send SIGTERM on every deploy and scale-down. Without this, in-flight
// requests are cut off mid-response and pooled connections are dropped rather
// than returned, which Postgres only cleans up on its own timeout.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} — 종료합니다 (finishing in-flight requests)…`);

    server.close(() => {
      db.pool.end()
        .catch(() => {})
        .finally(() => process.exit(0));
    });

    // A hung request must not keep the process alive past the host's patience.
    setTimeout(() => {
      console.log('  강제 종료 (forced after 10s)');
      process.exit(0);
    }, 10_000).unref();
  });
}
