// 실무자용 QA 리포트 — 회차 결과와 담당자 검수를 HTML 한 장으로 만듭니다.
// 실무자는 claude.ai 계정이 없으므로, 데이터를 파일 안에 넣어 메일·메신저로 보내면
// 더블클릭만으로 열리게 합니다(서버·인터넷 불필요). 크레딧 0.
//   node db/qa-report.js                       (가장 최근 전체 회차)
//   node db/qa-report.js 3 "연금 신청 창구 안내 추가"   (회차, 이번 보강 내용)
//
// 담당자 검수(사람-LLM 일치율)는 qa-runs/review/pulled/reviews/*.json 에서 읽습니다.
// 검수 페이지의 기록을 Claude가 그 자리로 내려받습니다("검수 결과 내려받아줘").
// 검수가 없으면 일치율 칸은 "검수 대기"로 나갑니다 — LLM 숫자만으로 내보내지 않습니다.
const fs = require('fs');
const path = require('path');

const RUNS = 'qa-runs';
const readCsv = (file) => fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split('\n').slice(1).filter(Boolean)
  .map(l => (l.match(/"((?:[^"]|"")*)"/g) || []).map(x => x.slice(1, -1).replace(/""/g, '"')));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const runFiles = fs.readdirSync(RUNS).filter(f => /^qa-\d+-.*\.csv$/.test(f)).sort();
if (!runFiles.length) { console.error('\n  ✖ qa-runs/ 에 회차가 없습니다.\n'); process.exit(1); }
const roundOf = (f) => Number(f.match(/^qa-(\d+)-/)[1]);
const want = process.argv[2] ? Number(process.argv[2]) : roundOf(runFiles[runFiles.length - 1]);
const note = process.argv[3] || '';

// 회차별 요약 (측정 실패는 성공률에서 뺍니다)
const runs = runFiles.map(f => {
  const rows = readCsv(path.join(RUNS, f));
  const s = { round: roundOf(f), when: rows[0] ? rows[0][1] : '', ok: 0, lack: 0, wrong: 0, other: 0, byCat: {} };
  for (const r of rows) {
    const c = s.byCat[r[2]] || (s.byCat[r[2]] = { ok: 0, total: 0 });
    if (r[5] === '충실') { s.ok++; c.ok++; c.total++; } else if (r[5] === '부족') { s.lack++; c.total++; }
    else if (r[5] === '틀림') { s.wrong++; c.total++; } else s.other++;
  }
  s.measured = s.ok + s.lack + s.wrong;
  s.acc = s.measured ? Math.round(s.ok / s.measured * 1000) / 10 : null;
  return s;
});
const run = runs.find(r => r.round === want);
if (!run) { console.error(`\n  ✖ ${want}회차가 없습니다.\n`); process.exit(1); }

// 담당자 검수
const pulled = path.join(RUNS, 'review', 'pulled', 'reviews');
const reviews = fs.existsSync(pulled) ? fs.readdirSync(pulled).filter(f => f.endsWith('.json'))
  .map(f => { const o = JSON.parse(fs.readFileSync(path.join(pulled, f), 'utf8')); return o.data || o; })
  .filter(r => r.round === want) : [];
const sample = reviews.filter(r => r.kind === 'sample');
const agree = sample.filter(r => r.human === r.llm).length;
const holes = reviews.filter(r => r.kind === 'hole');
const realHoles = holes.filter(r => r.human !== '충실').length;
const agreeTxt = sample.length ? `${Math.round(agree / sample.length * 1000) / 10}%` : '검수 대기';
const agreeSub = sample.length ? `무작위 ${sample.length}문항 중 ${agree}문항 일치 · 탐 검수` : '담당자가 아직 표본을 확인하지 않았습니다';

// 추이 그래프 (SVG, 파일 안에 그림)
const pts = runs.filter(r => r.acc != null);
const W = 560, H = 190, L = 40, R = 16, T = 18, B = 28;
const lo = Math.max(0, Math.floor((Math.min(...pts.map(r => r.acc)) - 3) / 5) * 5);
const X = (i) => pts.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (pts.length - 1);
const Y = (v) => T + (100 - v) * (H - T - B) / (100 - lo);
let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="회차별 정확도">`;
for (let v = lo; v <= 100; v += 5) svg += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d9e0dd"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end" class="ax">${v}</text>`;
if (pts.length > 1) svg += `<path d="${pts.map((r, i) => `${i ? 'L' : 'M'}${X(i)},${Y(r.acc)}`).join(' ')}" fill="none" stroke="#1d6670" stroke-width="2.5"/>`;
pts.forEach((r, i) => {
  svg += `<circle cx="${X(i)}" cy="${Y(r.acc)}" r="${r.round === want ? 5.5 : 4}" fill="${r.round === want ? '#1d6670' : '#fff'}" stroke="#1d6670" stroke-width="2"/>`;
  svg += `<text x="${X(i)}" y="${H - B + 18}" text-anchor="middle" class="ax">${r.round}회</text>`;
  svg += `<text x="${X(i)}" y="${Y(r.acc) - 10}" text-anchor="middle" class="ax val">${r.acc}%</text>`;
});
svg += '</svg>';

const cats = Object.entries(run.byCat).map(([k, v]) => ({ k, ...v, p: v.total ? Math.round(v.ok / v.total * 100) : null }))
  .sort((a, b) => (a.p == null) - (b.p == null) || a.p - b.p || a.k.localeCompare(b.k));
const catRows = cats.map(c => `<div class="cat"><span>${esc(c.k)}</span>${c.p == null
  ? '<span class="na">측정 못 함</span><span class="n">—</span>'
  : `<span class="bar"><i style="width:${c.p}%;background:${c.p < 100 ? '#a96b12' : '#1d6670'}"></i></span><span class="n">${c.ok}/${c.total}</span>`}</div>`).join('');

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>이음이 QA 리포트 ${want}회차</title>
<style>
body{margin:0;background:#f4f6f5;color:#18211f;font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:15px;line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:28px 16px 48px;display:grid;gap:18px}
h1{font-size:22px;margin:0}h2{font-size:15px;margin:0 0 8px}.muted{color:#5d6b67}
.m{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}@media(max-width:640px){.m{grid-template-columns:1fr}}
.k{background:#fff;border:1px solid #d9e0dd;border-radius:8px;padding:14px;display:grid;gap:2px}.k.hl{border-color:#1d6670}
.k .l{font-size:12px;letter-spacing:.04em;color:#5d6b67}.k .v{font-size:28px;font-variant-numeric:tabular-nums;font-weight:600}.k .s{font-size:12.5px;color:#5d6b67}
.p{background:#fff;border:1px solid #d9e0dd;border-radius:8px;padding:14px}svg{width:100%;height:auto}.ax{fill:#5d6b67;font-size:11px}.val{fill:#18211f;font-weight:600}
.cat{display:grid;grid-template-columns:9em minmax(0,1fr) 3.5em;gap:8px;align-items:center;font-size:13.5px;margin:5px 0}
.bar{height:8px;background:#e3e8e6;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%}.n{text-align:right;color:#5d6b67;font-variant-numeric:tabular-nums}.na{color:#5d6b67;font-size:12px}
.note{background:#e2eff0;border-radius:8px;padding:12px 14px}.warn{background:#f8eedc;border-radius:8px;padding:12px 14px}
footer{font-size:12.5px;color:#5d6b67}
</style></head><body><div class="wrap">
<div><h1>이음이 QA 리포트 · ${want}회차</h1><div class="muted">서초 어르신 음성 복지 키오스크 · ${esc(run.when)} 측정 · 어르신 예상 질문 ${run.measured + run.other}문항</div></div>
<section class="m">
 <div class="k"><span class="l">AI 채점 정확도</span><span class="v">${run.acc ?? '—'}%</span><span class="s">충실 ${run.ok} · 부족 ${run.lack} · 틀림 ${run.wrong}${run.other ? ` · 측정 못 함 ${run.other}` : ''}</span></div>
 <div class="k hl"><span class="l">사람 확인 일치율</span><span class="v">${agreeTxt}</span><span class="s">${esc(agreeSub)}</span></div>
 <div class="k"><span class="l">확인된 보강 대상</span><span class="v">${holes.length ? realHoles : '—'}</span><span class="s">${holes.length ? `AI가 찾은 ${holes.length}건 중 담당자도 부족하다고 본 수` : '담당자 확인 전'}</span></div>
</section>
${run.other ? `<div class="warn">이번 회차는 ${run.other}문항을 측정하지 못했습니다(시스템 문제로 답변을 받지 못함). 정확도는 측정된 ${run.measured}문항 기준입니다.</div>` : ''}
${note ? `<div class="note"><b>이번 회차 보강 내용</b><br>${esc(note)}</div>` : ''}
<div class="p"><h2>회차별 정확도</h2>${svg}</div>
<div class="p"><h2>분류별 성공률</h2>${catRows}</div>
<footer>읽는 법: “AI 채점 정확도”는 AI가 이음이 답변을 채점한 결과입니다. “사람 확인 일치율”은 그 채점을 담당자가 무작위로 골라 직접 확인했을 때 같은 판단이 나온 비율로, 이 숫자가 높을수록 첫 번째 숫자를 믿을 수 있습니다.</footer>
</div></body></html>`;

const out = path.join(RUNS, `QA-리포트-${String(want).padStart(3, '0')}.html`);
fs.writeFileSync(out, html);
console.log(`\n  ${want}회차 리포트: 정확도 ${run.acc}% · 일치율 ${agreeTxt} · 검수 ${reviews.length}건`);
console.log(`  → ieumi-server/${out} (실무자에게 이 파일을 보내면 됩니다)\n`);
