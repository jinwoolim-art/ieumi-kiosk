// 링크가 열리는지만 확인합니다 — npm run check-links
//
// 이것은 <어디에서 실행하느냐>를 알아보기 위한 도구입니다.
//
// 한국 공공기관 사이트 상당수가 해외 IP 를 막습니다. 해외에서 돌려 보면 60개 중
// 열여섯 개가 방화벽에 막히거나 응답이 없었는데, 같은 주소를 한국에서 열면
// 멀쩡한 경우가 많습니다. 어느 쪽인지는 <한국에서 한 번 돌려 보면> 바로 압니다.
//
// Whether a link is broken or merely unreachable from abroad looks identical in
// the database, and the two need opposite fixes: one is ours to repair, the
// other is solved by running from Korea. Run this on both sides and compare.
//
// 이 도구는 <모델도 데이터베이스도 쓰지 않습니다.> 페이지를 열어 보기만 합니다.
// 그래서 API 크레딧이 없어도, 데이터베이스 접속 정보가 없어도 돌아갑니다.
// Deliberately free of both the model and the database: it only opens pages, so
// it runs with no API credit and no DATABASE_URL — just node and a network.
//
//   node check-links.js            카탈로그의 모든 링크 (여기에서 직접)
//   node check-links.js --relay    한국 중계를 거쳐서 (.env 의 KOREA_RELAY_URL)
//   node check-links.js --json     결과를 JSON 으로 (두 곳의 결과를 비교할 때)
const fs = require('fs');
const path = require('path');
const env = require('./env');
const { pfetch } = require('./proxy-fetch');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 40_000;
const BLOCKED = /web firewall|방화벽|보안 정책|Access Denied|차단되었습니다|접근이 거부/i;

// 링크는 데이터베이스가 있으면 데이터베이스에서 (대시보드에서 고친 것이 반영되므로),
// 없으면 seed 파일에서 읽습니다.
async function catalogue() {
  if (process.env.DATABASE_URL) {
    try {
      const db = require('./db');
      const rows = await db.all(
        `SELECT code, sub, link FROM services
          WHERE active AND link IS NOT NULL AND link <> '' ORDER BY code`);
      await db.pool.end();
      if (rows.length) return { from: 'database', rows };
    } catch { /* seed 로 넘어갑니다 */ }
  }
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'db/services.seed.json'), 'utf8'));
  const list = Array.isArray(seed) ? seed : seed.services;
  return {
    from: 'services.seed.json',
    rows: list.filter((s) => s.link).map((s) => ({ code: s.id, sub: s.sub, link: s.link })),
  };
}

// --relay 를 붙이면 한국 중계를 거쳐서 확인합니다.
//
// 기본은 <직접> 입니다. 이 도구의 본래 쓰임이 "여기서 열리는가"를 재어 두 곳을
// 비교하는 것이라, 아무 말 없이 중계를 타 버리면 그 비교가 무의미해집니다.
// 그래서 거치려면 분명하게 --relay 라고 말해야 합니다.
//
// Direct by default: this tool exists to be run in two places and diffed, and
// silently routing through the relay would destroy that comparison. Going
// through it has to be asked for.
const VIA_RELAY = process.argv.includes('--relay');
const RELAY = (env.KOREA_RELAY_URL || '').replace(/\/+$/, '');
const RELAY_TOKEN = env.KOREA_RELAY_TOKEN || '';

// 한 번만 열어 봅니다 — 재시도는 하지 않습니다. 여기서 알고 싶은 것은
// "이 자리에서 이 사이트가 우리를 받아 주는가" 이지, 오늘 운이 좋았는가가 아닙니다.
async function probe(url) {
  const t0 = Date.now();
  let r;
  try {
    r = VIA_RELAY
      ? await pfetch(`${RELAY}/fetch?url=${encodeURIComponent(url)}`, {
          headers: RELAY_TOKEN ? { 'x-relay-token': RELAY_TOKEN } : {},
          timeoutMs: TIMEOUT_MS + 20_000,
        })
      : await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'follow',
        });
  } catch (e) {
    const code = String((e.cause && (e.cause.code || e.cause.message)) || e.message || '');
    return { verdict: /timeout|abort/i.test(code) ? 'timeout' : 'unreachable',
             detail: code.slice(0, 44), ms: Date.now() - t0 };
  }
  if (!r.ok) {
    // 중계가 거절한 것과 사이트가 거절한 것은 다른 이야기입니다.
    if (VIA_RELAY) {
      const why = await r.json().catch(() => ({}));
      return { verdict: 'unreachable', detail: 'relay: ' + String(why.error || r.status).slice(0, 38), ms: Date.now() - t0 };
    }
    return { verdict: 'http', detail: 'HTTP ' + r.status, ms: Date.now() - t0 };
  }
  if (VIA_RELAY) {
    const up = Number(r.headers.get('x-relay-status')) || 200;
    if (up < 200 || up >= 300) return { verdict: 'http', detail: 'HTTP ' + up, ms: Date.now() - t0 };
  }

  const body = (await r.text().catch(() => '')) || '';
  const text = body.replace(/<script[\s\S]*?<\/script>/gi, '')
                   .replace(/<style[\s\S]*?<\/style>/gi, '')
                   .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (BLOCKED.test(text.slice(0, 800))) return { verdict: 'firewall', detail: 'refused by firewall', ms: Date.now() - t0 };
  if (text.length < 400) return { verdict: 'thin', detail: text.length + ' chars of text', ms: Date.now() - t0 };
  return { verdict: 'ok', detail: text.length + ' chars of text', ms: Date.now() - t0 };
}

const MARK = { ok: '✔', thin: '○', firewall: '⛔', timeout: '⏱', unreachable: '✖', http: '✖' };
const MEANING = {
  ok: '열리고 글도 충분합니다',
  thin: '열리지만 글이 거의 없습니다 (대문 페이지이거나 자바스크립트로 그리는 화면)',
  firewall: '방화벽이 막았습니다 — 한국에서 돌리면 열릴 가능성이 높습니다',
  timeout: '응답이 없습니다 — 해외 차단일 수 있습니다',
  unreachable: '연결되지 않습니다',
  http: '주소가 잘못되었거나 사라졌습니다',
};

(async () => {
  const { from, rows } = await catalogue();
  const json = process.argv.includes('--json');
  if (!json) {
    console.log(`\n  링크 열림 확인 — can these pages be read from here?`);
    console.log(`  ${rows.length}개 주소 (출처: ${from})`);
    console.log(`  경로 route: ${VIA_RELAY ? 'via the Korea relay — ' + RELAY : 'direct from here'}\n`);
  }

  const out = [];
  for (const s of rows) {
    const p = await probe(s.link);
    out.push({ ...s, ...p });
    if (!json) {
      console.log(`  ${MARK[p.verdict] || '?'} ${s.code.padEnd(4)} ${String(s.sub).slice(0, 22).padEnd(24)}`
        + `${p.verdict.padEnd(12)} ${p.detail}`);
    }
  }

  if (json) { console.log(JSON.stringify(out, null, 2)); return; }

  const by = {};
  for (const o of out) by[o.verdict] = (by[o.verdict] || 0) + 1;
  console.log('\n  ---');
  for (const k of ['ok', 'thin', 'firewall', 'timeout', 'unreachable', 'http']) {
    if (by[k]) console.log(`  ${MARK[k]} ${String(by[k]).padStart(3)}  ${k.padEnd(12)} ${MEANING[k]}`);
  }
  const reachable = (by.ok || 0) + (by.thin || 0);
  console.log(`\n  열린 주소: ${reachable} / ${out.length}`);
  console.log(`  (한국에서 돌린 결과와 해외에서 돌린 결과를 비교해 보십시오 —`);
  console.log(`   차이 나는 것이 곧 '해외에서 막힌' 것입니다.)\n`);
})().catch((e) => { console.error(String(e.message)); process.exit(1); });
