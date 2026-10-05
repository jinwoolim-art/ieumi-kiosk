// QA 캐시 수동 비우기 — 갱신 전략 [B] 안전망 (설계 7-2). 크레딧 0 (DB 쓰기만).
// 평소 갱신은 [A] 변경감지(sync 시 자동)와 TTL(기본 7일)이 처리합니다. 이 도구는
// 월 1회 전체 재검증이나, 제도·금액이 크게 바뀐 뒤 강제로 다시 받고 싶을 때 씁니다.
//
//   node db/qa-cache-clear.js all               (전체 비우기)
//   node db/qa-cache-clear.js service <서비스코드> (한 서비스를 쓰는 센터들)
//   node db/qa-cache-clear.js center  <센터id>     (한 복지관)
const db = require('./db');
const qc = require('../qa-cache');

(async () => {
  const [what, arg] = process.argv.slice(2);
  if (!what) {
    console.log('\n  사용법:\n    node db/qa-cache-clear.js all\n    node db/qa-cache-clear.js service <서비스코드>\n    node db/qa-cache-clear.js center <센터id>\n');
    process.exit(1);
  }
  let n = 0;
  if (what === 'all') {
    n = await qc.invalidateAll();
  } else if (what === 'service' && arg) {
    const s = await db.all('SELECT id, sub FROM services WHERE code = $1', [arg]);
    if (!s.length) { console.error(`\n  ✖ 서비스코드 ${arg} 없음\n`); process.exit(1); }
    n = await qc.invalidateForService(s[0].id);
    console.log(`  서비스: ${s[0].sub}`);
  } else if (what === 'center' && arg) {
    n = await qc.invalidateCenter(arg);
  } else {
    console.error('\n  ✖ 인자 확인: all | service <코드> | center <id>\n'); process.exit(1);
  }
  console.log(`\n  QA 캐시 ${n}건 비웠습니다. 다음 질문부터 새로 생성·저장됩니다.\n`);
  await db.pool.end();
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
