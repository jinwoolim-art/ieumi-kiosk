// 링크 내용 동기화 — npm run sync-sources
//
// 하루 한 번 예약해 두는 작업입니다. 내용이 그대로인 페이지는 요약을 건너뛰므로,
// 두 번째 실행부터는 대부분 네트워크 비용만 듭니다.
//
// Run it on a daily schedule. Pages whose content has not changed skip the model
// call entirely, so after the first run this costs little more than the fetches.
//
//   npm run sync-sources              모든 링크
//   npm run sync-sources -- s61 s2    특정 서비스만
//   npm run sync-sources -- --force   내용이 같아도 다시 요약
const db = require('./index');
const sources = require('../sources');
const env = require('../env.js');

(async () => {
  if (!env.DATABASE_URL) {
    console.error('\n  ✖ DATABASE_URL is not set. See ieumi-server/.env\n');
    process.exit(1);
  }
  if (!env.ANTHROPIC_API_KEY) {
    console.error('\n  ✖ ANTHROPIC_API_KEY is not set — the facts are extracted by the model.\n');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const only = args.filter((a) => !a.startsWith('--'));

  console.log('\n  링크 내용 동기화 — reading the pages behind the catalogue\n');
  if (only.length) console.log('  대상: ' + only.join(', '));
  if (force) console.log('  --force: 내용이 같아도 다시 요약합니다\n');

  const t0 = Date.now();
  const out = await sources.refreshAll({
    force,
    only: only.length ? only : null,
    onProgress: (r, i, n) => {
      const mark = { ok: '✔', unchanged: '·', empty: '○', error: '✖', skipped: '–' }[r.status] || '?';
      // 몇 장을 따라갔고 그림을 몇 장 읽었는지 함께 보여 줍니다. "읽었다" 와
      // "강좌표까지 읽었다" 는 다르고, 그 차이가 이번 작업의 전부입니다.
      const depth = [
        r.subpages ? '+' + r.subpages + 'p' : '',
        r.images ? '+' + r.images + 'img' : '',
        r.chunks ? r.chunks + ' chunks' : '',
      ].filter(Boolean).join(' ');
      console.log('  ' + mark + ' ' + String(i).padStart(3) + '/' + n + '  ' + r.code.padEnd(5)
        + r.status.padEnd(11)
        + (r.reason || (r.factChars ? String(r.factChars).padStart(5) + ' chars  ' : '')).padEnd(16)
        + depth);
    },
  });

  const by = {};
  out.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
  const sum = (k) => out.reduce((n, r) => n + (r[k] || 0), 0);
  console.log('\n  ' + Object.entries(by).map(([k, v]) => k + ' ' + v).join(' · ')
    + '   (' + Math.round((Date.now() - t0) / 1000) + 's)');
  console.log('  따라간 페이지 ' + sum('subpages') + ' · 읽은 그림 ' + sum('images')
    + ' · 조각 ' + sum('chunks'));

  // 근거 없는 줄이 얼마나 잘렸는지 — 많으면 요약 프롬프트가 잘못된 것입니다.
  // How many lines failed the grounding check. A large number here is not a
  // success, it is a sign the extraction prompt is pushing the model to invent.
  const cut = out.reduce((n, r) => n
    + Number(((r.notes || []).join(' ').match(/(\d+) ungrounded/) || [])[1] || 0), 0);
  if (cut) console.log('  ✂ 근거 없어 버린 줄 ' + cut + '개 (ungrounded lines dropped)');

  const bad = out.filter((r) => r.status === 'error');
  if (bad.length) {
    console.log('\n  읽지 못한 링크 — these keep their previous facts, if any:');
    bad.forEach((r) => console.log('    ' + r.code.padEnd(5) + r.reason));
  }
  console.log('');
  await db.pool.end();
})().catch((e) => { console.error('\n  ✖ ' + (e.message || e) + '\n'); process.exit(1); });
