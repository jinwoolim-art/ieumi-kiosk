// 학습 상태 감사 — DB만 읽습니다(크레딧 0). 어떤 서비스가 학습됐고 어떤 게 비었는지 확인.
//   node db/audit.js
const db = require('./index');
const env = require('../env.js');

(async () => {
  if (!env.DATABASE_URL) { console.error('\n  ✖ DATABASE_URL 없음 (ieumi-server/.env 확인)\n'); process.exit(1); }

  const rows = await db.all(`
    SELECT s.code, s.sub, s.link,
           count(c.id)::int AS chunks,
           count(c.id) FILTER (WHERE c.kind='image')::int AS img_chunks,
           coalesce(sum(length(c.body)),0)::int AS chars
      FROM services s
      LEFT JOIN source_chunks c ON c.service_id = s.id
     WHERE s.active
     GROUP BY s.code, s.sub, s.link
     ORDER BY chunks ASC, s.code`);

  const zero = rows.filter(r => r.chunks === 0);
  const thin = rows.filter(r => r.chunks > 0 && r.chars < 300);
  const good = rows.filter(r => r.chunks > 0 && r.chars >= 300);

  console.log(`\n=================== 이음이 학습 상태 감사 ===================`);
  console.log(`  활성 서비스 총계 : ${rows.length}개`);
  console.log(`  ✔ 제대로 학습됨   : ${good.length}개  (chunk 있고 300자 이상)`);
  console.log(`  △ 빈약함          : ${thin.length}개  (chunk 있으나 300자 미만)`);
  console.log(`  ✖ 전혀 학습 안 됨 : ${zero.length}개  (chunk 0)`);

  console.log(`\n--- ✖/△ 학습 안 됐거나 빈약한 서비스 (이게 '답 못하는' 목록) ---`);
  [...zero, ...thin].forEach(r =>
    console.log(`  ${String(r.chunks).padStart(3)}chunk ${String(r.chars).padStart(6)}자  [${r.code}] ${r.sub}`));

  console.log(`\n--- 문제의 그 공지 (파크골프/IT페스티벌/느티나무/스마트) ---`);
  const hit = rows.filter(r =>
    /파크골프|페스티벌|IT|느티나무|스마트|시니어/i.test(String(r.sub||'')) ||
    /파크골프|페스티벌|느티나무/i.test(String(r.link||'')));
  if (!hit.length) console.log('  (이름에 매칭되는 서비스 없음 — 서비스 자체가 목록에 없을 수도)');
  hit.forEach(r =>
    console.log(`  ${String(r.chunks).padStart(3)}chunk ${String(r.chars).padStart(6)}자  [${r.code}] ${r.sub}\n       link: ${r.link||'(없음)'}`));

  console.log(`\n--- 전체 ${rows.length}개 서비스 목록 (파크골프/IT페스티벌이 여기 있나 확인) ---`);
  console.log('  (chunk=조각수 / 그림=포스터AI판독수 / 자=본문글자수)');
  [...rows].sort((a,b)=>String(a.code).localeCompare(String(b.code))).forEach(r =>
    console.log(`  [${r.code}] ${(r.sub||'').padEnd(20)} ${String(r.chunks).padStart(3)}chunk 그림${r.img_chunks} ${String(r.chars).padStart(6)}자  ${r.link||''}`));

  console.log(`\n============================================================\n`);
  process.exit(0);
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
