// 일자리 동기화 CLI — npm run sync-jobs
//
// Run it on a schedule (a cron job, or Render's scheduled jobs). Postings are
// only useful while they are open, so a daily run is about right.
const db = require('./index');
const jobs = require('../jobs');

(async () => {
  if (!db.DATABASE_URL) process.exit(1);
  if (!jobs.KEY) {
    console.error('\n  ✖ DATAGO_KEY is not set. Put your data.go.kr key in ieumi-server/.env\n');
    process.exit(1);
  }

  console.log('\n  일자리 동기화 — data.go.kr\n');
  const t0 = Date.now();
  try {
    const r = await jobs.sync({ log: console.log });
    console.log(`\n  ✔ 완료 — 수신 ${r.scanned} / 저장 ${r.stored} / 상세 ${r.detailed}  (${Math.round((Date.now() - t0) / 1000)}초)`);

    const centers = await db.all(`SELECT name, region FROM centers WHERE region <> '' ORDER BY name`);
    for (const c of centers) {
      const { jobs: list, scope, region } = await jobs.forCenterRegion(c.region);
      const how = scope === 'sigungu' ? '해당 구' : scope === 'sido' ? '같은 시·도로 확대' : '없음';
      console.log(`    ${c.name} → ${list.length}건 (${region || '-'}, ${how})`);
    }
    console.log('');
  } catch (e) {
    console.error(`\n  ✖ 동기화 실패: ${e.message}\n`);
    process.exitCode = 1;
  }
  await db.pool.end();
})();
