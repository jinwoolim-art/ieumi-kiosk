// 키오스크 주소 한 줄 — node tools/kiosk-url.js [복지관슬러그]
//
// 키오스크는 로그인하는 사람이 없으므로 주소의 ?c= 토큰으로 자기 복지관을
// 알립니다. 그 토큰은 데이터베이스에 있고, 손으로 옮겨 적기에는 깁니다.
// 한 글자만 틀려도 화면은 멀쩡히 뜨고 <다른 복지관의 안내>가 나옵니다 —
// 오류가 나지 않으므로 알아차리기 어렵습니다. 그래서 여기서 찍어 줍니다.
//
// A kiosk identifies its centre with the ?c= token in its URL. Mistyping it
// does not fail: the page loads and quietly serves another centre's catalogue.
// So the address is printed rather than copied by hand.
//
//   node tools/kiosk-url.js                 -> /kiosk?c=...      (서초, 기본값)
//   node tools/kiosk-url.js gangseo         -> /kiosk?c=...      (다른 복지관)
//   node tools/kiosk-url.js --full https://example.trycloudflare.com
const db = require('../db');

const args = process.argv.slice(2);
const fullAt = args.indexOf('--full');
const base = fullAt >= 0 ? (args[fullAt + 1] || '').replace(/\/+$/, '') : '';
const slug = args.filter((a) => !a.startsWith('--') && a !== base)[0] || 'seocho';

(async () => {
  const row = await db.one(
    'SELECT slug, name, kiosk_token FROM centers WHERE slug = $1 AND active', [slug]);
  if (!row) {
    const all = await db.all('SELECT slug FROM centers WHERE active ORDER BY slug');
    console.error(`no active centre with slug "${slug}". Have: ${all.map((c) => c.slug).join(', ')}`);
    await db.pool.end();
    process.exit(1);
  }
  console.log(`${base}/kiosk?c=${encodeURIComponent(row.kiosk_token)}`);
  await db.pool.end();
})().catch((e) => { console.error(e.message || e); process.exit(1); });
