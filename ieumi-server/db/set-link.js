// 서비스 링크를 공지 게시판으로 바꿉니다 — 개별 공지(2홉)를 1홉으로 닿게 하기 위함.
// 변경 전 값을 백업 출력하므로 언제든 되돌릴 수 있습니다.
//   node db/set-link.js
const db = require('./index');

const CODE = 's30';   // 느티나무복지관 중복 서비스 (s17은 대문 그대로 둠)
const NEW_LINK = 'https://ntwelfare.org/bbs/board.php?bo_table=B33';   // 공지사항 게시판
const NEW_SUB = '느티나무복지관 공지·행사';   // 검색에 잡히도록 이름도 구체화

(async () => {
  if (!db.DATABASE_URL) { console.error('\n  ✖ DATABASE_URL 없음 (ieumi-server/.env)\n'); process.exit(1); }

  const [before] = await db.all(`SELECT code, sub, link FROM services WHERE code=$1`, [CODE]);
  if (!before) { console.error(`\n  ✖ ${CODE} 서비스를 찾을 수 없습니다.\n`); process.exit(1); }

  console.log('\n=== 변경 전 (❗ 되돌리려면 이 값을 적어두세요) ===');
  console.log(`  [${before.code}] sub: ${before.sub}`);
  console.log(`           link: ${before.link}`);

  await db.query(`UPDATE services SET link=$1, sub=$2 WHERE code=$3`, [NEW_LINK, NEW_SUB, CODE]);

  const [after] = await db.all(`SELECT code, sub, link FROM services WHERE code=$1`, [CODE]);
  console.log('\n=== 변경 후 ===');
  console.log(`  [${after.code}] sub: ${after.sub}`);
  console.log(`           link: ${after.link}`);

  console.log('\n  ✅ 완료. 이제 이 서비스만 재학습하세요 (크레딧 소량):');
  console.log('       npm run sync-sources -- ' + CODE + '\n');
  process.exit(0);
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
