// Shared .env loader — used by server.js and the db scripts alike.
// Values already present in process.env win, so a real deployment can inject
// secrets without a file on disk.
const fs = require('fs');
const path = require('path');

const env = {};
const file = path.join(__dirname, '.env');

if (fs.existsSync(file)) {
  // 줄바꿈과 BOM — Windows 에서 메모장으로 저장하면 둘 다 생깁니다.
  //
  // This used to split on '\n' alone and strip a trailing '\r' from the value.
  // That cannot work: in JavaScript `.` does not match '\r' (it is a line
  // terminator), so `(.*)$` never reached the end of a CRLF line and the match
  // failed outright — every key silently vanished. A .env saved by Notepad is
  // CRLF, which is exactly what a centre following the launcher instructions
  // produces, so the file they were told to fill in would have loaded as empty.
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
}

// process.env takes precedence (cloud deploys, CI, `DATABASE_URL=… npm run migrate`)
for (const k of Object.keys(process.env)) {
  if (process.env[k] !== undefined && process.env[k] !== '') env[k] = process.env[k];
}

module.exports = env;
