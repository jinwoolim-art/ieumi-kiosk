// QA 검수 페이지로 보낼 데이터 만들기 — qa-runs/ 의 회차 결과를 검수 페이지(claude.ai)
// 저장소에 넣을 문서 파일로 바꿉니다. 크레딧 0, 네트워크 0 (파일만 만듭니다).
//   node db/qa-review-export.js          (가장 최근 전체 회차)
//   node db/qa-review-export.js 2        (2회차)
//
// 만드는 것 (qa-runs/review/<rNNN>/):
//   runs/rNNN.json      — 모든 회차의 요약(추이·분류별 성공률). 회차마다 하나씩.
//   items/rNNN-qKKK.json — 검수 대상: 그 회차의 부족·틀림 전부 + 충실 중 무작위 20개.
//   writes.json         — 위 파일들을 한 번에 넣기 위한 목록(Claude가 ArtifactData batch로 보냅니다).
//
// 검수 결과(reviews)는 여기서 만들지 않습니다 — 담당자가 페이지에서 남긴 기록이므로,
// 이 스크립트를 다시 돌려도 지워지지 않습니다.
const fs = require('fs');
const path = require('path');

const RUNS = 'qa-runs';
const SAMPLE = 20;   // 충실 중 사람이 다시 볼 개수 — 사람-LLM 일치율의 표본

const readCsv = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split('\n').slice(1).filter(Boolean)
  .map(l => (l.match(/"((?:[^"]|"")*)"/g) || []).map(x => x.slice(1, -1).replace(/""/g, '"')));

// 회차 번호로 시드를 고정한 난수 — 다시 내보내도 같은 20개가 뽑혀야 검수가 흔들리지 않습니다.
function seeded(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

const runFiles = fs.readdirSync(RUNS).filter(f => /^qa-\d+-.*\.csv$/.test(f)).sort();
if (!runFiles.length) { console.error('\n  ✖ qa-runs/ 에 전체 회차가 없습니다. 먼저 node db/qa-eval.js\n'); process.exit(1); }
const hist = fs.existsSync(`${RUNS}/history.csv`) ? readCsv(`${RUNS}/history.csv`) : [];
const histBy = new Map(hist.map(h => [Number(h[0]), h]));

const roundOf = (f) => Number(f.match(/^qa-(\d+)-/)[1]);
const want = process.argv[2] ? Number(process.argv[2]) : roundOf(runFiles[runFiles.length - 1]);
const target = runFiles.find(f => roundOf(f) === want);
if (!target) { console.error(`\n  ✖ ${want}회차 파일이 없습니다.\n`); process.exit(1); }

const rid = (n) => 'r' + String(n).padStart(3, '0');
const out = path.join(RUNS, 'review', rid(want));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'runs'), { recursive: true });
fs.mkdirSync(path.join(out, 'items'), { recursive: true });
const writes = [];
const put = (collection, id, data) => {
  const file = path.join(out, collection, id + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  writes.push({ op: 'set', collection, doc_id: id, file_path: path.resolve(file) });
};

// 1) 회차 요약 — 전부 다시 씁니다(작고, 히스토리와 늘 같아야 하므로).
for (const f of runFiles) {
  const n = roundOf(f);
  const rows = readCsv(path.join(RUNS, f));
  const head = fs.readFileSync(path.join(RUNS, f), 'utf8').split('\n')[0];
  // 2회차까지는 답변을 앞 90자만 남겼습니다 — 검수 화면이 그걸 알려야 합니다.
  const truncated = !head.includes(',답변,');
  const byCat = {};
  let ok = 0, lack = 0, wrong = 0, other = 0;
  // 측정 실패(?·ERR)는 성공률에 넣지 않습니다 — 품질이 아니라 장애이므로 따로 셉니다.
  for (const r of rows) {
    const v = r[5];
    const c = byCat[r[2]] || (byCat[r[2]] = { ok: 0, total: 0, unmeasured: 0 });
    if (v === '충실') { ok++; c.ok++; c.total++; } else if (v === '부족') { lack++; c.total++; } else if (v === '틀림') { wrong++; c.total++; } else { other++; c.unmeasured++; }
  }
  const h = histBy.get(n) || [];
  put('runs', rid(n), {
    round: n, when: rows[0] ? rows[0][1] : (h[1] || ''), total: rows.length, ok, lack, wrong, other,
    accuracy: (ok + lack + wrong) ? Math.round(ok / (ok + lack + wrong) * 1000) / 10 : null,
    cost: h[8] ? Number(h[8]) : null, model: h[9] || '', judge: (rows[0] && rows[0][8]) || h[11] || '',
    truncated, byCat, file: f,
  });
}

// 2) 검수 대상 — 부족·틀림 전부 + 충실 중 무작위 SAMPLE개.
const rows = readCsv(path.join(RUNS, target));
const truncated = !fs.readFileSync(path.join(RUNS, target), 'utf8').split('\n')[0].includes(',답변,');
const indexed = rows.map((r, i) => ({ r, i: i + 1 }));
const holes = indexed.filter(x => x.r[5] === '부족' || x.r[5] === '틀림');
const good = indexed.filter(x => x.r[5] === '충실');
const rnd = seeded(want);
for (let i = good.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [good[i], good[j]] = [good[j], good[i]]; }
const sample = good.slice(0, SAMPLE).sort((a, b) => a.i - b.i);

for (const [kind, list] of [['hole', holes], ['sample', sample]]) {
  for (const { r, i } of list) {
    put('items', `${rid(want)}-q${String(i).padStart(3, '0')}`, {
      round: want, idx: i, kind, cat: r[2], q: r[3], svc: r[4], llm: r[5], reason: r[6], reply: r[7] || '', truncated,
    });
  }
}

fs.writeFileSync(path.join(out, 'writes.json'), JSON.stringify(writes, null, 1));
console.log(`\n  ${want}회차 검수 데이터: 회차 요약 ${runFiles.length}개 · 구멍 ${holes.length}개 · 표본 ${sample.length}개`);
if (truncated) console.log(`  ⚠️  이 회차는 답변이 앞 90자만 저장돼 있습니다. 표본 검수는 전체 답변이 남는 다음 회차부터 정확합니다.`);
console.log(`  → ${out}/writes.json (${writes.length}건)\n`);
