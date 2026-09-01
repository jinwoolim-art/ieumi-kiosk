// 이음이 백엔드 (무의존성 Node) — STT(클로바) → Claude → TTS(클로바) + 정적 서빙
// 실행: node ieumi-server/server.js  →  http://localhost:8787/이음이-키오스크-프로토타입.html
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- .env 로드 ----
const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/\r$/, '').trim();
}
const AKEY = env.ANTHROPIC_API_KEY;
const CID = env.CLOVA_API_KEY_ID, CSEC = env.CLOVA_API_KEY;
// 문자발송 — 알리고(간편) 또는 네이버 SENS
const ALIGO_KEY = env.ALIGO_API_KEY, ALIGO_UID = env.ALIGO_USER_ID, ALIGO_SENDER = env.ALIGO_SENDER;
const ALIGO_READY = !!(ALIGO_KEY && ALIGO_UID && ALIGO_SENDER);
const SENS_AK = env.NCP_SENS_ACCESS_KEY, SENS_SK = env.NCP_SENS_SECRET_KEY,
      SENS_SVC = env.NCP_SENS_SERVICE_ID, SMS_FROM = env.SMS_FROM_NUMBER;
const SENS_READY = !!(SENS_AK && SENS_SK && SENS_SVC && SMS_FROM);
const SMS_READY = ALIGO_READY || SENS_READY;
const MODEL = env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const SPEAKER = env.CLOVA_SPEAKER || 'nara';   // 따뜻한 여성 음성
const SPEED = env.CLOVA_SPEED || '1';          // 0 기본, 양수=천천히(어르신용)
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8791;

const SYSTEM = `당신은 '이음이', 서초 어르신 행복이음 센터의 따뜻한 AI 말벗 도우미입니다.
규칙:
- 어르신께 항상 존댓말로, 짧고 쉽고 다정하게. 한 번에 1~2문장.
- 어려운 단어·영어·긴 설명 금지. 천천히 또박또박한 느낌.
- 어르신이 일자리를 원하면 목록의 자리를 하나씩 쉽게 소개합니다. 자리가 두 개 이상이면, 어르신이 비교하거나 고민하실 때 급여·근무시간·힘든 정도의 차이를 다정하게 짚어드리고, 재촉하지 말고 편하게 고르시도록 돕습니다.
- 절대 지어내지 마세요. 목록에 있는 항목만 말합니다. 어르신이 근무시간·자세한 조건 등 목록에 없는 것을 물으면, 모른다고 하지 말고 "그건 문자로 자세히 정리해서 보내드릴게요" 또는 "정확한 건 문자에 있는 담당 기관에 물어보시면 됩니다"라고 안내합니다.
- 서초구에 맞는 자리가 목록에 없으면 정직하게 "서초에는 지금 열린 자리가 없어서, 가까운 ○○구 자리를 알려드릴게요"라고 말합니다.
- 안내한 뒤에는 "정리해서 문자로 보내드릴까요?"처럼 문자 발송을 제안합니다.
- 준비 안 된 요청은 "담당 선생님께 꼭 전해드릴게요"로 받습니다.
반드시 아래 JSON 하나로만 답하세요(설명·코드블록 없이):
{"reply":"어르신께 할 말","category":"일자리|건강|복지|행정|기타|긴급","summary":"담당자용 한 줄 요약","offerSms":true|false,"pick":어르신이 관심·선택한 일자리 번호(1부터. 아직 없으면 0)}`;

const JLABEL = {gu:'지역',job:'하는 일',org:'기관/회사',pay:'급여',work:'근무시간·형태',age:'연령',to:'접수마감',place:'근무지',tel:'문의',note:'참고(비교용)'};
const jobsText = (jobs) => (!jobs || !jobs.length) ? '(일자리 목록 없음)'
  : jobs.map((j, i) => `${i + 1}. ` + Object.entries(j)
      .filter(([k, v]) => v && k !== 'link' && k !== 'id')
      .map(([k, v]) => `${JLABEL[k] || k}: ${v}`).join(' / ')).join('\n');

async function callClaude(history, jobs, model) {
  const sys = SYSTEM + '\n\n[일자리 목록]\n' + jobsText(jobs);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: model || MODEL, max_tokens: 400, system: sys, messages: history }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'claude error');
  const text = (j.content && j.content[0] && j.content[0].text) || '';
  let parsed = null;
  try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]); } catch (e) {}
  return { raw: text, parsed, usage: j.usage };
}

async function clovaTTS(text) {
  const body = new URLSearchParams({ speaker: SPEAKER, text, format: 'mp3', speed: SPEED });
  const r = await fetch('https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts', {
    method: 'POST',
    headers: { 'X-NCP-APIGW-API-KEY-ID': CID, 'X-NCP-APIGW-API-KEY': CSEC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error('TTS ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return Buffer.from(await r.arrayBuffer());
}

async function clovaSTT(audioBuf) {
  const r = await fetch('https://naveropenapi.apigw.ntruss.com/recog/v1/stt?lang=Kor', {
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
  const r = await fetch('https://apis.aligo.in/send/', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const j = await r.json().catch(() => ({}));
  return { sent: String(j.result_code) === '1', reason: String(j.result_code) === '1' ? '' : ('aligo:' + (j.message || r.status)) };
}
async function sendSENS(to, content) {
  const ts = Date.now().toString();
  const uri = `/sms/v2/services/${SENS_SVC}/messages`;
  const sig = crypto.createHmac('sha256', SENS_SK).update(`POST ${uri}\n${ts}\n${SENS_AK}`).digest('base64');
  const body = JSON.stringify({ type: content.length > 45 ? 'LMS' : 'SMS', from: SMS_FROM, content, messages: [{ to }] });
  const r = await fetch('https://sens.apigw.ntruss.com' + uri, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8',
      'x-ncp-apigw-timestamp': ts, 'x-ncp-iam-access-key': SENS_AK, 'x-ncp-apigw-signature-v2': sig }, body });
  const j = await r.json().catch(() => ({}));
  return { sent: r.ok && j.statusCode === '202', reason: r.ok ? '' : ('sens_' + r.status) };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webp': 'image/webp' };

function readBody(req) {
  return new Promise((res) => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => res(Buffer.concat(b))); });
}
const cors = (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); };
const json = (res, code, obj) => { cors(res); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  try {
    if (u.pathname === '/chat' && req.method === 'POST') {
      const { history, jobs, model } = JSON.parse((await readBody(req)).toString() || '{}');
      const out = await callClaude(history || [], jobs || [], model);
      return json(res, 200, out);
    }
    if (u.pathname === '/tts' && req.method === 'POST') {
      const { text } = JSON.parse((await readBody(req)).toString() || '{}');
      const audio = await clovaTTS(text || '');
      cors(res); res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(audio);
    }
    if (u.pathname === '/stt' && req.method === 'POST') {
      const text = await clovaSTT(await readBody(req));
      return json(res, 200, { text });
    }
    if (u.pathname === '/sms' && req.method === 'POST') {
      const { to, jobs, kind } = JSON.parse((await readBody(req)).toString() || '{}');
      const j = jobs && jobs[0];
      let content;
      if (kind === 'followup') {
        content = j
          ? `[서초 어르신 행복이음] 이음이 추가 안내\n아까 문의하신 자세한 내용입니다.\n▸ ${j.gu} · ${j.job}\n▸ 근무 ${j.work || '담당 기관 문의'}\n▸ 문의 ${j.tel || '-'}\n정확한 조건은 위 담당 기관에 확인해 주세요. 건강하세요!`
          : '[서초 어르신 행복이음] 이음이 추가 안내입니다.';
      } else {
        content = j
          ? `[서초 어르신 행복이음] 이음이 안내\n▸ ${j.gu} · ${j.job}\n▸ 급여 ${j.pay}\n▸ 근무 ${j.work || '-'}\n▸ 대상 ${j.age || '-'}\n▸ 접수 ${j.to || '-'}\n▸ 문의 ${j.tel || '-'}`
          : '[서초 어르신 행복이음] 이음이가 안내한 일자리 정보입니다.';
      }
      const out = await sendSMS(to || '', content);
      return json(res, 200, out);
    }
    if (u.pathname === '/health') return json(res, 200, { ok: true, model: MODEL, speaker: SPEAKER, sms: SMS_READY });

    // ---- 정적 파일 ----
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/이음이-키오스크-프로토타입.html';
    const fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    cors(res); res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    return fs.createReadStream(fp).pipe(res);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`이음이 백엔드 실행: http://localhost:${PORT}/이음이-키오스크-프로토타입.html  (model=${MODEL}, voice=${SPEAKER})`));
