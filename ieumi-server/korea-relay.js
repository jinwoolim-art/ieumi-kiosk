// 한국 중계 서버 — node korea-relay.js
//
// 한국 공공기관 사이트 상당수가 해외 IP 를 거부합니다. 60개 링크 중 열두 개가
// 해외에서는 방화벽에 막히거나 응답이 없었고, 그중 하나는 아예 "방화벽 보안
// 정책에 의해 차단되었습니다" 라고 우리 IP 를 적어 돌려주었습니다.
//
// 이 작은 서버를 <한국에 있는 기기>에서 돌리면, 나머지는 어디에 있든 상관없어집니다.
// 페이지를 여는 일만 이 서버가 대신 해 주고, 읽은 내용을 그대로 돌려줍니다.
// cityIO 프로젝트에서 VWorld 를 이렇게 쓰고 있습니다 (Docs/SERVER_OPS.md).
//
// Korean government sites refuse foreign IPs. This relay runs on a machine in
// Korea and does nothing but fetch a page and hand back what it got, so the rest
// of the system can live anywhere. The same shape as the cityIO VWorld relay.
//
// 실행 (한국 기기에서):
//   KOREA_RELAY_TOKEN=아무거나-긴-문자열 node korea-relay.js
// 그리고 바깥에서 닿을 수 있게 터널을 엽니다 (cityIO 와 같은 방식):
//   cloudflared tunnel --url http://localhost:8799
// 마지막으로 앱 쪽 .env 에:
//   KOREA_RELAY_URL=https://<터널주소>
//   KOREA_RELAY_TOKEN=위와 같은 문자열
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const env = require('./env.js');
const render = require('./render');

// 껍데기인지 가늠하는 기준 — sources.js 와 같은 값입니다.
const THIN_CHARS = Number(env.RENDER_THIN_CHARS || 400);
const textLength = (html) => (html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

const PORT = Number(env.KOREA_RELAY_PORT || 8799);
const TOKEN = env.KOREA_RELAY_TOKEN || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 40_000;
const MAX_BYTES = 3_000_000;

// 아무 주소나 열어 주지 않습니다.
//
// 인터넷에 열린 "아무 URL 이나 가져다 주는" 서버는 공격 도구입니다 — 남의 서버를
// 두드리는 데도, 그 기기의 내부망을 들여다보는 데도 쓰입니다. 그래서 <카탈로그에
// 실제로 적혀 있는 도메인만> 열어 줍니다. 목록은 seed 파일에서 그때그때 읽으므로,
// 링크를 고치면 허용 목록도 같이 바뀝니다.
//
// An open URL-fetcher on the public internet is an attack tool — for reaching
// other people's servers and for reading the host's own private network. This
// only opens hosts that the catalogue itself names, read from the seed file, so
// the allow-list follows the links rather than having to be maintained beside
// them.
// 대시보드에서 링크를 고치면 seed 파일에는 안 남습니다.
//
// 그러면 중계는 그 새 주소를 모르는 채로 "허용 목록에 없다"며 거절합니다 —
// 담당자는 대시보드에서 분명히 고쳤는데 자료가 안 들어오는, 원인을 찾기 어려운
// 고장입니다. 그래서 relay-hosts.txt 에 도메인을 한 줄씩 적어 두면 함께 허용합니다.
// 코드를 고치거나 다시 배포할 필요 없이, 그 파일에 한 줄 추가하면 됩니다.
//
// A link edited in the dashboard never reaches the seed file, so the relay would
// refuse a host the staff had just configured — a failure with no visible cause.
// relay-hosts.txt (one hostname per line) is the escape hatch: add a line, no
// code change and no redeploy.
function extraHosts() {
  const f = path.join(__dirname, 'relay-hosts.txt');
  try {
    return fs.readFileSync(f, 'utf8').split('\n')
      .map((l) => l.replace(/#.*$/, '').trim().toLowerCase())
      .filter(Boolean);
  } catch { return []; }
}

function allowedHosts() {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'db/services.seed.json'), 'utf8'));
  const list = Array.isArray(seed) ? seed : seed.services;
  const hosts = new Set();
  for (const s of list) {
    if (!s.link) continue;
    try { hosts.add(new URL(s.link).hostname.toLowerCase()); } catch { /* 주소가 아니면 건너뜁니다 */ }
  }
  for (const h of extraHosts()) hosts.add(h);
  return hosts;
}
let HOSTS = allowedHosts();

// 같은 기기의 내부 주소로 향하는 요청은 막습니다 — 허용된 도메인이 사설 IP 로
// 풀리는 경우까지 포함해서(DNS rebinding).
const isPrivate = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  const s = ip.toLowerCase();
  return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
};

async function resolvesPublic(hostname) {
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivate(a.address));
  } catch { return false; }
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');

  if (u.pathname === '/health') {
    // 브라우저가 있는지도 함께 알려 줍니다.
    //
    // 없으면 자바스크립트로 그리는 페이지는 조용히 껍데기만 읽고 지나갑니다 —
    // 아무 소리도 나지 않으므로, 나중에 "왜 이 서비스는 자료가 없지" 하고
    // 한참을 찾게 됩니다. 여기서 한 줄로 보이는 편이 낫습니다.
    //
    // Without a browser, JavaScript-built pages are skipped in silence — which
    // later looks like "why does this service have no facts" and takes an hour
    // to trace. Better to see it here.
    return json(res, 200, {
      ok: true,
      hosts: HOSTS.size,
      token: !!TOKEN,
      renderer: render.available() ? (render.browserPath() || true) : false,
    });
  }
  if (u.pathname !== '/fetch' || req.method !== 'GET') {
    return json(res, 404, { error: 'not found' });
  }

  // 토큰이 설정되어 있으면 반드시 맞아야 합니다. 터널 주소는 짐작하기 어렵지만,
  // 짐작하기 어려운 것과 잠겨 있는 것은 다릅니다.
  if (TOKEN && (req.headers['x-relay-token'] || u.searchParams.get('token')) !== TOKEN) {
    return json(res, 403, { error: 'bad token' });
  }

  const target = u.searchParams.get('url') || '';
  let parsed;
  try { parsed = new URL(target); } catch { return json(res, 400, { error: 'bad url' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json(res, 400, { error: 'only http(s)' });
  }

  const host = parsed.hostname.toLowerCase();
  if (!HOSTS.has(host)) {
    // 카탈로그를 고쳤을 수도 있으니 한 번 다시 읽어 보고 판단합니다.
    try { HOSTS = allowedHosts(); } catch { /* 이전 목록을 그대로 씁니다 */ }
    if (!HOSTS.has(host)) return json(res, 403, { error: 'host not in catalogue: ' + host });
  }
  if (!await resolvesPublic(host)) return json(res, 403, { error: 'host resolves to a private address' });

  try {
    const r = await fetch(parsed.toString(), {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
    });
    let type = r.headers.get('content-type') || '';
    let buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) return json(res, 413, { error: 'too large' });

    // 껍데기만 왔으면 브라우저로 한 번 더 — <여기서> 해야 합니다.
    //
    // 자바스크립트로 그리는 데다 해외 IP 까지 막는 사이트가 있습니다. 그런 곳은
    // 브라우저도 한국에서 띄워야 열립니다. 바깥에서 아무리 렌더링해도 페이지
    // 자체에 닿지 못합니다.
    //
    // A page that is both JavaScript-built and geo-blocked can only be rendered
    // from here: rendering it abroad never reaches the page in the first place.
    if (u.searchParams.get('render') === '1' && /html|text/i.test(type)
        && textLength(buf.toString('utf8')) < THIN_CHARS && render.available()) {
      try {
        const html = await render.renderHtml(parsed.toString());
        if (textLength(html) > textLength(buf.toString('utf8'))) {
          buf = Buffer.from(html, 'utf8');
          type = 'text/html; charset=utf-8';   // 렌더링 결과는 언제나 UTF-8 입니다
        }
      } catch { /* 렌더링이 안 되면 받아온 것을 그대로 돌려줍니다 */ }
    }

    // 본문은 바이트 그대로 돌려줍니다 — 한국 공공기관 페이지에는 EUC-KR 이 남아
    // 있어서, 여기서 글자로 바꿔 버리면 원래 인코딩 정보가 사라집니다.
    // The body goes back as bytes with its content-type intact: some of these
    // pages are still EUC-KR, and decoding here would throw that away.
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'x-relay-status': String(r.status),
      'x-relay-content-type': type,
    });
    return res.end(buf);
  } catch (e) {
    const why = String((e.cause && (e.cause.code || e.cause.message)) || e.message || '');
    return json(res, 502, { error: why.slice(0, 120) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  한국 중계 — Korea fetch relay on http://localhost:${PORT}`);
  console.log(`  허용 도메인 ${HOSTS.size}개 (카탈로그에 적힌 것만)`);
  console.log(`  토큰 token          ${TOKEN ? '설정됨 set' : '없음 NOT SET'}`);
  console.log(`  브라우저 renderer   ${render.available()
    ? '있음 found — 자바스크립트 페이지도 읽습니다'
    : '없음 NOT FOUND — 자바스크립트로 그리는 페이지는 건너뜁니다 (install Chrome)'}`);
  if (!TOKEN) {
    console.log(`\n  ⚠ KOREA_RELAY_TOKEN 이 설정되지 않았습니다 — 누구나 쓸 수 있습니다.`);
    console.log(`    (not set: anyone who finds the address can use this relay)`);
  }
  console.log(`\n  확인:  curl http://localhost:${PORT}/health\n`);
});
