// 프록시를 통과하는 fetch — proxy-aware fetch for the page-reading tools.
//
// Node 의 fetch 는 HTTPS_PROXY 를 <무시합니다.> curl 은 따릅니다. 그래서 같은
// 주소가 curl 로는 열리고 node 로는 ECONNREFUSED 로 막히는, 알아보기 어려운
// 차이가 생깁니다. 실제로 그 일이 있었습니다: 한국 중계 터널이 curl 로는 200 을
// 주는데 sync-sources 는 링크 쉰다섯 개 전부를 '연결되지 않음' 으로 적었습니다.
//
// Node's fetch ignores HTTPS_PROXY; curl obeys it. The same URL therefore opens
// under curl and fails with ECONNREFUSED under node — observed exactly that way,
// with the Korea relay answering curl while the sync marked all 55 links dead.
//
// 프록시가 설정되어 있지 않으면 그냥 평범한 fetch 입니다.
// With no proxy configured this is ordinary fetch, untouched.
//
// server.js 에도 같은 일을 하는 코드가 있습니다. 그쪽은 Claude 응답을 흘려보내는
// (streaming) 처리가 얽혀 있어 손대지 않았습니다 — 키오스크가 말을 멈추는 것보다
// 중복이 낫습니다. 언젠가 합치는 편이 좋습니다.
// server.js has its own copy, entangled with streaming Claude's reply; left
// alone deliberately, since duplication is cheaper than a kiosk that goes quiet.
const http = require('http');
const https = require('https');

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy
           || process.env.HTTP_PROXY || process.env.http_proxy || '';

// NO_PROXY 에 적힌 곳은 프록시를 거치지 않습니다 (localhost 등).
const NO_PROXY = (process.env.NO_PROXY || process.env.no_proxy || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const bypass = (hostname) => NO_PROXY.some((n) =>
  n === hostname || (n.startsWith('.') && hostname.endsWith(n)) || hostname.endsWith('.' + n));

/**
 * 프록시를 CONNECT 로 뚫고 요청합니다. 돌려주는 모양은 fetch 의 응답과 같게
 * 맞춰 두었습니다 — ok / status / headers.get / text / arrayBuffer.
 */
function viaProxy(url, opts = {}) {
  const u = new URL(url);
  const px = new URL(PROXY);
  const body = opts.body ? Buffer.from(opts.body) : null;

  return new Promise((resolve, reject) => {
    const c = http.request({
      host: px.hostname, port: px.port || 80, method: 'CONNECT',
      path: u.hostname + ':443', headers: { host: u.hostname + ':443' },
    });
    c.on('error', reject);
    c.setTimeout(opts.timeoutMs || 60_000, () => { c.destroy(new Error('proxy CONNECT timeout')); });
    c.on('connect', (pres, socket) => {
      if (pres.statusCode !== 200) return reject(new Error('proxy CONNECT ' + pres.statusCode));
      const headers = Object.assign({}, opts.headers);
      if (body) headers['content-length'] = body.length;
      const req = https.request({
        socket, servername: u.hostname, host: u.hostname, agent: false,
        path: u.pathname + u.search, method: opts.method || 'GET', headers,
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: { get: (k) => res.headers[String(k).toLowerCase()] || null },
            text: async () => buf.toString('utf8'),
            json: async () => JSON.parse(buf.toString('utf8')),
            arrayBuffer: async () => buf,
          });
        });
      });
      req.on('error', reject);
      req.setTimeout(opts.timeoutMs || 60_000, () => { req.destroy(new Error('request timeout')); });
      if (body) req.write(body);
      req.end();
    });
    c.end();
  });
}

/** fetch 와 같은 자리에 놓고 쓸 수 있습니다. */
function pfetch(url, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* fetch 가 알아서 실패합니다 */ }
  const useProxy = PROXY && host && !bypass(host) && url.startsWith('https:');
  return useProxy ? viaProxy(url, opts) : fetch(url, opts);
}

module.exports = { pfetch, PROXY, usingProxy: () => !!PROXY };
