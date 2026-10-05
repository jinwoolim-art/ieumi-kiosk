// QA 캐시 히트율 측정 — 그림자 모드(QA_CACHE_MODE=shadow)로 쌓인 기록을 읽어
// "어르신이 실제로 얼마나 반복 질문하는지"를 보여줍니다. 크레딧 0 (DB 읽기만).
//
//   node db/qa-cache-stats.js            (최근 30일)
//   node db/qa-cache-stats.js 7          (최근 7일)
//   node db/qa-cache-stats.js 30 prune   (90일보다 오래된 이벤트 로그 정리)
//
// 판단 기준(설계 8번): shadow 히트율이 의미 있게 높으면 Phase B(임베딩) 투자 가치가 있고,
// 낮으면 질문이 매번 달라 캐시 효과가 작다는 뜻 → 다른 비용 절감(질문별 자료 축소)이 우선.
const db = require('./db');

const days = Number(process.argv[2] || 30);
const doPrune = process.argv[3] === 'prune';

(async () => {
  if (!db.DATABASE_URL) { console.error('\n  ✖ DATABASE_URL 없음\n'); process.exit(1); }

  const ev = await db.all(
    `SELECT decision, reason, mode, count(*)::int n
       FROM qa_cache_event
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY decision, reason, mode
      ORDER BY n DESC`, [String(days)]);

  if (!ev.length) {
    console.log(`\n  최근 ${days}일 캐시 이벤트가 없습니다.`);
    console.log(`  → 측정하려면 .env 에 QA_CACHE_MODE=shadow 를 넣고 서버를 재시작하세요.`);
    console.log(`     (shadow 는 답을 늘 LLM 으로 내보내므로 안전하고, 크레딧을 더 쓰지 않습니다.)\n`);
    await db.pool.end(); return;
  }

  const sum = {};
  for (const r of ev) sum[r.decision] = (sum[r.decision] || 0) + r.n;
  const hit = sum.hit || 0, miss = sum.miss || 0, bypass = sum.bypass || 0;
  const looked = hit + miss;                 // 조회까지 간 것(=캐시 대상 질문)
  const total = looked + bypass;             // 전체 질문

  console.log(`\n  ===== QA 캐시 히트율 (최근 ${days}일, 모드 ${[...new Set(ev.map(e => e.mode))].join('/')}) =====`);
  console.log(`  전체 질문 ${total} = 캐시 대상 ${looked} + 우회 ${bypass}`);
  if (looked) {
    const rate = Math.round(hit / looked * 1000) / 10;
    console.log(`  → 히트율: ${hit}/${looked} = ${rate}%  (캐시 대상 질문 중 재사용 가능했던 비율)`);
    if (total) console.log(`  → 전체 대비: ${hit}/${total} = ${Math.round(hit / total * 1000) / 10}% (우회 포함)`);
  }

  console.log(`\n  우회 사유별 (캐시 안 한 이유):`);
  ev.filter(e => e.decision === 'bypass')
    .sort((a, b) => b.n - a.n)
    .forEach(e => console.log(`    ${String(e.n).padStart(5)}  ${e.reason || '(없음)'}`));

  const top = await db.all(
    `SELECT normalized_q, count(*)::int n,
            count(*) FILTER (WHERE decision='hit')::int hits
       FROM qa_cache_event
      WHERE created_at > now() - ($1 || ' days')::interval AND decision IN ('hit','miss')
      GROUP BY normalized_q ORDER BY n DESC LIMIT 15`, [String(days)]);
  if (top.length) {
    console.log(`\n  가장 많이 물은 질문(정규화형) Top ${top.length}:`);
    top.forEach(r => console.log(`    ${String(r.n).padStart(4)}회 (히트 ${r.hits})  ${r.normalized_q.slice(0, 40)}`));
  }

  const entries = await db.all(`SELECT count(*)::int n, sum(hit_count)::int hits FROM qa_cache`);
  console.log(`\n  캐시 적재 항목: ${entries[0].n}개 · 누적 히트 ${entries[0].hits || 0}`);

  if (doPrune) {
    const r = await db.query(`DELETE FROM qa_cache_event WHERE created_at < now() - interval '90 days'`);
    console.log(`\n  정리: 90일 지난 이벤트 로그 ${r.rowCount}건 삭제`);
  }
  console.log('');
  await db.pool.end();
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
