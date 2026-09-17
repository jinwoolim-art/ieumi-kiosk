// Shared .env loader — used by server.js and the db scripts alike.
// Values already present in process.env win, so a real deployment can inject
// secrets without a file on disk.
const fs = require('fs');
const path = require('path');

const env = {};
const file = path.join(__dirname, '.env');

if (fs.existsSync(file)) {
  // 줄바꿈은 \r\n 도 함께 끊습니다 — 윈도우에서 메모장으로 .env 를 만들면
  // 줄 끝에 \r 이 붙습니다.
  //
  // 예전에는 '\n' 으로만 끊었고, 그러면 줄 끝의 \r 이 값에 남습니다. 그런데
  // 아래 정규식의 `.` 은 \r 에 걸리지 않으므로 <매칭 자체가 실패해서>, 그 줄은
  // 조용히 버려졌습니다. 아래 replace(/\r$/) 는 도달하지도 못했습니다.
  //
  // 조용히 버려지는 것이 이 버그의 고약한 점입니다: 중계 서버를 토큰과 함께
  // 띄웠다고 생각했는데 실제로는 토큰 없이 떠 있었고, 터널로 열린 채였습니다.
  // 실제로 그렇게 되는 것을 확인했습니다.
  //
  // Split on CRLF too: a .env written by Notepad on Windows ends its lines with
  // \r, and `.` in the pattern below does not match \r — so the line failed to
  // match at all and was dropped in silence, never reaching the \r strip. The
  // silence is what makes it dangerous: the relay came up with no token while
  // appearing configured, on a public tunnel. Observed, not theorised.
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].replace(/\r$/, '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
}

// process.env takes precedence (cloud deploys, CI, `DATABASE_URL=… npm run migrate`)
for (const k of Object.keys(process.env)) {
  if (process.env[k] !== undefined && process.env[k] !== '') env[k] = process.env[k];
}

module.exports = env;
