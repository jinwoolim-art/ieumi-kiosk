// 이음이 QA 자동 평가 — 질문 뱅크를 이음이에 돌리고, 답변을 Haiku가 채점한다.
// 단순 키워드 평가의 오판(되묻기·정직한 안내를 구멍으로 치는 것)을 없애기 위함.
//   서버(start-kiosk)가 켜져 있어야 하고, .env에 ANTHROPIC_API_KEY 필요.
//   node db/qa-eval.js                  (기본: 서초 토큰)
//   node db/qa-eval.js <c토큰>          (다른 센터)
//   node db/qa-eval.js --failed         (구멍만: 직전 전체 회차의 부족·틀림만 다시, ~$0.3)
//   전체 결과는 회차마다 qa-runs/ 에 따로 남고(덮어쓰지 않음), 직전 회차와 비교해 보여줍니다.
//   --failed 는 보강 확인용이라 회차·정확도 로그에 넣지 않습니다(spot-*.csv 로만 저장).
//   배포 전에는 전체를 돌리세요 — 프롬프트는 140개 모두에 들어가서, 구멍만 보면 회귀를 못 봅니다.
const env = require('../env.js');
const fs = require('fs');
const crypto = require('crypto');

const AKEY = env.ANTHROPIC_API_KEY;
const EVAL_MODEL = env.QA_EVAL_MODEL || 'claude-haiku-4-5';   // 평가는 싼 모델로
const KIOSK = env.QA_KIOSK_URL || 'http://localhost:8791';
const args = process.argv.slice(2);
const FAILED_ONLY = args.includes('--failed');
const CTOKEN = args.find(a => !a.startsWith('--')) || 'I_qS8Kz79nnRApFP0k0lvs1xScOJBGQV';   // 서초

// 질문 뱅크는 db/qbank.json 에서 읽습니다 — 담당자가 질문만 추가하면 됩니다.
const QBANK = require('./qbank.json');

async function ask(q) {
  const r = await fetch(KIOSK + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ history: [{ role: 'user', content: q }], c: CTOKEN, lang: 'ko' }),
  });
  const d = await r.json();
  const reply = (d.parsed && d.parsed.reply) || d.raw || '';
  // 이음이가 답을 못 했으면 채점할 것이 없습니다. 빈 답을 "부족"으로 세면 장애가 품질 문제로 둔갑합니다.
  if (d.error || !reply) throw new ApiStop('이음이 답변 실패: ' + String(d.error || '빈 답변').slice(0, 200));
  return { reply, svc: d.serviceName || '-', usage: d.usage || {} };
}

// API가 거절하면(크레딧 소진·키 오류·과부하) 그 자리에서 멈춥니다. 2026-10-03 2회차에서
// 크레딧이 바닥난 뒤에도 27문항을 끝까지 돌며 빈 결과를 쌓았던 일을 막기 위함입니다.
// 이음이 서버도 같은 키를 쓰므로, 이 메시지가 나오면 운영 중인 키오스크도 답을 못 하고 있습니다.
class ApiStop extends Error {}

// 회차 기록 — 매번 새 파일로 남겨야 "정확도 추이"가 증명이 됩니다.
const RUNS = 'qa-runs';
const PRICE = {   // $/1M 토큰: [입력, 출력, 캐시읽기, 캐시쓰기(5분)]
  'claude-sonnet-5': [2, 10, 0.2, 2.5],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
};
const cost = (model, u) => {
  const p = PRICE[model]; if (!p) return null;
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1]
    + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6;
};
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const addUsage = (sum, u) => { for (const k of USAGE_KEYS) sum[k] = (sum[k] || 0) + ((u && u[k]) || 0); };
const readCsv = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split('\n').slice(1).filter(Boolean)
  .map(l => (l.match(/"((?:[^"]|"")*)"/g) || []).map(x => x.slice(1, -1).replace(/""/g, '"')));

// 채점 기준은 고정합니다. 바꾸면 점수가 "이음이가 좋아져서"인지 "채점이 관대해져서"인지
// 섞이므로, 기준 문구의 지문(버전)을 회차마다 기록하고 바뀌면 경고합니다.
const judgePrompt = (q, a) => `당신은 어르신용 복지 안내 키오스크 "이음이"의 답변을 평가하는 심사관입니다.
참고: 이음이는 기상청 실시간 날씨와 서초구 실제 구인 목록(일자리 이름·급여·문의처)을 받아서 답합니다. 오늘·내일 날씨나 구체적 구인 자리를 말하는 것 자체는 정상이며, 그것만으로 "틀림"·"부족"으로 보지 마세요. 확인할 수 없다는 이유만으로 "틀림"을 주지 말고, 명백히 사실과 다를 때만 "틀림"입니다. 이음이는 서초구청 홈페이지에서 확인한 자료로도 답하므로, 구 자체 사업(예: 서초SOS 긴급복지)의 금액·기준이 전국 제도 기준과 달라도 그 자체로 "틀림"이 아닙니다.

[질문] ${q}
[이음이 답변] ${a}

평가 기준:
- "충실": 질문에 맞는 구체적 정보를 주거나, 정보가 없을 땐 적절한 기관·전화번호로 안내함. (어르신께 되묻거나 "문자로 보내드릴까요" 하는 것은 정상이며 충실로 봅니다.)
- "부족": 아무 정보·안내 없이 모른다고만 하거나 질문과 동떨어짐.
- "틀림": 사실과 다른 정보를 말함.

반드시 JSON만 출력하세요(다른 말 금지): {"verdict":"충실|부족|틀림","reason":"15자 내외 이유"}`;
const JUDGE_VERSION = crypto.createHash('sha1')
  .update(EVAL_MODEL + '\n' + judgePrompt('{Q}', '{A}')).digest('hex').slice(0, 8);

async function evaluate(q, a) {
  const prompt = judgePrompt(q, a);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': AKEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
  });
  const d = await r.json();
  if (d.type === 'error' || d.error) throw new ApiStop('채점 API 실패: ' + JSON.stringify(d.error || d).slice(0, 200));
  const txt = (d.content && d.content[0] && d.content[0].text) || '';
  const usage = d.usage || {};
  try { return { ...JSON.parse(txt.match(/\{[\s\S]*\}/)[0]), usage }; }
  catch { return { verdict: '?', reason: (txt || JSON.stringify(d).slice(0, 60)).slice(0, 40), usage }; }
}

(async () => {
  if (!AKEY) { console.error('\n  ✖ ANTHROPIC_API_KEY 없음 (ieumi-server/.env)\n'); process.exit(1); }
  const kioskModel = await fetch(KIOSK + '/health').then(r => r.json()).then(h => h.model).catch(() => '?');
  if (!fs.existsSync(RUNS)) fs.mkdirSync(RUNS);
  const prevFiles = fs.readdirSync(RUNS).filter(f => /^qa-\d+-.*\.csv$/.test(f)).sort();
  const prevName = prevFiles[prevFiles.length - 1];
  const round = prevFiles.length + 1;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hm = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const when = `${ymd} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  // 구멍만: 직전 "전체" 회차에서 충실이 아니었던 질문만 다시 묻습니다.
  let bank = QBANK;
  if (FAILED_ONLY) {
    if (!prevName) { console.error('\n  ✖ --failed 는 전체 회차가 한 번 이상 있어야 합니다. 먼저 전체를 돌리세요.\n'); process.exit(1); }
    const holes = readCsv(`${RUNS}/${prevName}`).filter(r => r[5] !== '충실');
    bank = holes.map(r => [r[2], r[3]]);
    if (!bank.length) { console.log(`\n  ${prevName} 에 구멍이 없습니다. 다시 볼 것이 없어요.\n`); process.exit(0); }
  }

  // 직전 회차의 채점 기준과 다르면 경고 — 점수 비교가 공정하지 않습니다.
  const hist = `${RUNS}/history.csv`;
  const lastHist = fs.existsSync(hist) ? readCsv(hist).pop() : null;
  const prevJudge = lastHist && lastHist[11];
  if (prevJudge && prevJudge !== JUDGE_VERSION) {
    console.log(`\n  ⚠️  채점 기준이 직전 회차와 다릅니다 (${prevJudge} → ${JUDGE_VERSION}).`);
    console.log(`     점수 변화에 "채점이 바뀐 몫"이 섞입니다. 비교는 참고만 하세요.`);
  }

  const title = FAILED_ONLY ? `구멍만 재테스트 (기준: ${prevName})` : `${round}회차`;
  console.log(`\n  이음이 QA 자동 평가 ${title} — ${bank.length}개 질문 · 이음이 ${kioskModel} · 평가모델 ${EVAL_MODEL} · 채점기준 ${JUDGE_VERSION}\n`);
  const rows = [];
  const kioskUse = {}, evalUse = {};
  for (let i = 0; i < bank.length; i++) {
    const [cat, q] = bank[i];
    try {
      const { reply, svc, usage } = await ask(q);
      const ev = await evaluate(q, reply);
      addUsage(kioskUse, usage); addUsage(evalUse, ev.usage);
      rows.push({ cat, q, svc, verdict: ev.verdict, reason: ev.reason, reply });
      const mark = { '충실': '✅', '부족': '❌', '틀림': '🟥' }[ev.verdict] || '❓';
      console.log(`  ${String(i + 1).padStart(2)}/${bank.length} ${mark} ${cat.padEnd(14)} ${q.slice(0, 18)}  (${ev.reason})`);
    } catch (e) {
      if (e instanceof ApiStop) {
        console.error(`\n  ✖ ${i + 1}번째 문항에서 멈춥니다 — ${e.message}`);
        console.error(`    크레딧 소진이면 이음이 키오스크도 지금 답을 못 합니다. Console → Plans & Billing 확인.`);
        console.error(`    이번 실행은 회차로 기록하지 않습니다(부분 결과는 버림).\n`);
        process.exit(2);
      }
      rows.push({ cat, q, svc: '-', verdict: 'ERR', reason: String(e).slice(0, 40), reply: '' });
      console.log(`  ${String(i + 1).padStart(2)}/${bank.length} ❓ ERR ${q.slice(0, 18)}`);
    }
  }
  // CSV 저장 (엑셀용 BOM). 답변은 검수에 쓰이므로 자르지 않고 전부 남깁니다.
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const label = FAILED_ONLY ? '구멍만' : round;
  const csv = ['회차,일시,분류,질문,출처(참조서비스),평가,이유,답변,채점기준']
    .concat(rows.map(r => [label, when, r.cat, r.q, r.svc, r.verdict, r.reason, (r.reply || '').replace(/\n/g, ' '), JUDGE_VERSION].map(esc).join(',')))
    .join('\n');
  const runFile = FAILED_ONLY
    ? `${RUNS}/spot-${ymd.replace(/-/g, '')}-${hm}.csv`
    : `${RUNS}/qa-${String(round).padStart(3, '0')}-${ymd.replace(/-/g, '')}-${hm}.csv`;
  fs.writeFileSync(runFile, '﻿' + csv);
  if (!FAILED_ONLY) fs.writeFileSync('qa-eval-result.csv', '﻿' + csv);   // 최신본 (예전 경로 그대로)

  const c = {}; rows.forEach(r => c[r.verdict] = (c[r.verdict] || 0) + 1);
  const ok = c['충실'] || 0, bad = (c['부족'] || 0) + (c['틀림'] || 0);
  console.log(`\n  ===== 결과 =====`);
  console.log(`  ✅ 충실 ${ok} / ❌ 부족 ${c['부족'] || 0} / 🟥 틀림 ${c['틀림'] || 0} / ❓ ${c['?'] || 0} · ERR ${c['ERR'] || 0}`);
  if (ok + bad) console.log(`  → 정확도: ${ok}/${ok + bad} = ${Math.round(ok / (ok + bad) * 100)}%`);
  console.log(`\n  보강 필요(부족·틀림):`);
  rows.filter(r => r.verdict === '부족' || r.verdict === '틀림').forEach(r => console.log(`    [${r.verdict}] ${r.cat} | ${r.q}  →(${r.svc}) ${r.reason}`));

  // 직전 회차와 비교 — 이번에 새로 나빠진 것이 회귀(regression)입니다.
  if (prevName) {
    const prev = new Map(readCsv(`${RUNS}/${prevName}`).map(r => [r[3], r[5]]));
    const worse = rows.filter(r => prev.get(r.q) === '충실' && r.verdict !== '충실');
    // 직전에 측정 실패(?·ERR)였던 문항은 "좋아짐"이 아니라 이번에 처음 잰 것입니다.
    const better = rows.filter(r => ['부족', '틀림'].includes(prev.get(r.q)) && r.verdict === '충실');
    const fresh = rows.filter(r => !prev.has(r.q)).length;
    console.log(`\n  직전 회차(${prevName})와 비교:`);
    console.log(`    🔻 새로 나빠짐 ${worse.length} · 🔺 새로 좋아짐 ${better.length} · 🆕 새 질문 ${fresh}`);
    worse.forEach(r => console.log(`    🔻 [${prev.get(r.q)}→${r.verdict}] ${r.cat} | ${r.q}  (${r.reason})`));
    better.forEach(r => console.log(`    🔺 [${prev.get(r.q)}→충실] ${r.cat} | ${r.q}`));
  }

  // 비용 — 대부분 이음이 답변이고, 심사는 작습니다.
  const kc = cost(kioskModel, kioskUse), ec = cost(EVAL_MODEL, evalUse);
  const usd = (kc == null || ec == null) ? null : kc + ec;
  console.log(`\n  토큰: 이음이 입력 ${kioskUse.input_tokens || 0} · 캐시읽기 ${kioskUse.cache_read_input_tokens || 0} · 캐시쓰기 ${kioskUse.cache_creation_input_tokens || 0} · 출력 ${kioskUse.output_tokens || 0} / 심사 입력 ${evalUse.input_tokens || 0} · 출력 ${evalUse.output_tokens || 0}`);
  if (usd != null) console.log(`  추정 비용: $${usd.toFixed(2)} (이음이 $${kc.toFixed(2)} + 심사 $${ec.toFixed(2)})`);

  if (FAILED_ONLY) {
    // 구멍만 돌린 결과는 정확도가 아닙니다(부족한 것만 골랐으니). 로그에 넣지 않습니다.
    console.log(`\n  저장: ieumi-server/${runFile}`);
    console.log(`  다 고쳐졌으면 배포 전에 전체를 한 번 돌려 회귀를 확인하세요: node db/qa-eval.js\n`);
    process.exit(0);
  }

  // 정확도 로그 — 회차마다 한 줄씩 쌓입니다.
  if (!fs.existsSync(hist)) fs.writeFileSync(hist, '﻿회차,일시,질문수,충실,부족,틀림,기타,정확도(%),추정비용($),이음이모델,파일,채점기준\n');
  fs.appendFileSync(hist, [round, when, rows.length, ok, c['부족'] || 0, c['틀림'] || 0, (c['?'] || 0) + (c['ERR'] || 0),
    (ok + bad) ? Math.round(ok / (ok + bad) * 1000) / 10 : '', usd == null ? '' : usd.toFixed(2), kioskModel, runFile, JUDGE_VERSION]
    .map(esc).join(',') + '\n');

  console.log(`\n  매트릭스 저장: ieumi-server/${runFile} (엑셀로 열기)`);
  console.log(`  정확도 로그:   ieumi-server/${hist}\n`);
  process.exit(0);
})().catch(e => { console.error('\n  오류:', e.message, '\n'); process.exit(1); });
