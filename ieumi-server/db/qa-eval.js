// 이음이 QA 자동 평가 — 질문 뱅크를 이음이에 돌리고, 답변을 Haiku가 채점한다.
// 단순 키워드 평가의 오판(되묻기·정직한 안내를 구멍으로 치는 것)을 없애기 위함.
//   서버(start-kiosk)가 켜져 있어야 하고, .env에 ANTHROPIC_API_KEY 필요.
//   node db/qa-eval.js                  (기본: 서초 토큰)
//   node db/qa-eval.js <c토큰>          (다른 센터)
const env = require('../env.js');
const fs = require('fs');

const AKEY = env.ANTHROPIC_API_KEY;
const EVAL_MODEL = env.QA_EVAL_MODEL || 'claude-haiku-4-5';   // 평가는 싼 모델로
const KIOSK = env.QA_KIOSK_URL || 'http://localhost:8791';
const CTOKEN = process.argv[2] || 'I_qS8Kz79nnRApFP0k0lvs1xScOJBGQV';   // 서초

// 질문 뱅크는 db/qbank.json 에서 읽습니다 — 담당자가 질문만 추가하면 됩니다.
const QBANK = require('./qbank.json');

async function ask(q) {
  const r = await fetch(KIOSK + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history: [{ role: 'user', content: q }], c: CTOKEN, lang: 'ko' }),
  });
  const d = await r.json();
  return { reply: (d.parsed && d.parsed.reply) || d.raw || '', svc: d.serviceName || '-' };
}

async function evaluate(q, a) {
  const prompt = `당신은 어르신용 복지 안내 키오스크 "이음이"의 답변을 평가하는 심사관입니다.
[질문] ${q}
[이음이 답변] ${a}

평가 기준:
- "충실": 질문에 맞는 구체적 정보를 주거나, 정보가 없을 땐 적절한 기관·전화번호로 안내함. (어르신께 되묻거나 "문자로 보내드릴까요" 하는 것은 정상이며 충실로 봅니다.)
- "부족": 아무 정보·안내 없이 모른다고만 하거나 질문과 동떨어짐.
- "틀림": 사실과 다른 정보를 말함.

반드시 JSON만 출력하세요(다른 말 금지): {"verdict":"충실|부족|틀림","reason":"15자 내외 이유"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  const txt = (d.content && d.content[0] && d.content[0].text) || '';
  try { return JSON.parse(txt.match(/\{[\s\S]*\}/)[0]); }
  catch { return { verdict: '?', reason: (txt || JSON.stringify(d).slice(0, 60)).slice(0, 40) }; }
}

(async () => {
  if (!AKEY) { console.error('\n  ✖ ANTHROPIC_API_KEY 없음 (ieumi-server/.env)\n'); process.exit(1); }
  console.log(`\n  이음이 QA 자동 평가 — ${QBANK.length}개 질문 · 평가모델 ${EVAL_MODEL}\n`);
  const rows = [];
  for (let i = 0; i < QBANK.length; i++) {
    const [cat, q] = QBANK[i];
    try {
      const { reply, svc } = await ask(q);
      const ev = await evaluate(q, reply);
      rows.push({ cat, q, svc, verdict: ev.verdict, reason: ev.reason, reply: reply.slice(0, 90) });
      const mark = { '충실': '✅', '부족': '❌', '틀림': '🟥' }[ev.verdict] || '❓';
      console.log(`  ${String(i + 1).padStart(2)}/${QBANK.length} ${mark} ${cat.padEnd(14)} ${q.slice(0, 18)}  (${ev.reason})`);
    } catch (e) {
      rows.push({ cat, q, svc: '-', verdict: 'ERR', reason: String(e).slice(0, 40), reply: '' });
      console.log(`  ${String(i + 1).padStart(2)}/${QBANK.length} ❓ ERR ${q.slice(0, 18)}`);
    }
  }
  // CSV 저장 (엑셀용 BOM)
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const csv = ['분류,질문,출처(참조서비스),평가,이유,답변요약']
    .concat(rows.map(r => [r.cat, r.q, r.svc, r.verdict, r.reason, (r.reply || '').replace(/\n/g, ' ')].map(esc).join(',')))
    .join('\n');
  fs.writeFileSync('qa-eval-result.csv', '﻿' + csv);

  const c = {}; rows.forEach(r => c[r.verdict] = (c[r.verdict] || 0) + 1);
  const ok = c['충실'] || 0, bad = (c['부족'] || 0) + (c['틀림'] || 0);
  console.log(`\n  ===== 결과 =====`);
  console.log(`  ✅ 충실 ${ok} / ❌ 부족 ${c['부족'] || 0} / 🟥 틀림 ${c['틀림'] || 0} / ❓ ${c['?'] || 0} · ERR ${c['ERR'] || 0}`);
  if (ok + bad) console.log(`  → 정확도: ${ok}/${ok + bad} = ${Math.round(ok / (ok + bad) * 100)}%`);
  console.log(`\n  보강 필요(부족·틀림):`);
  rows.filter(r => r.verdict === '부족' || r.verdict === '틀림').forEach(r => console.log(`    [${r.verdict}] ${r.cat} | ${r.q}  →(${r.svc}) ${r.reason}`));
  console.log(`\n  매트릭스 저장: ieumi-server/qa-eval-result.csv (엑셀로 열기)\n`);
  process.exit(0);
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
