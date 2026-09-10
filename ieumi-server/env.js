// Shared .env loader — used by server.js and the db scripts alike.
// Values already present in process.env win, so a real deployment can inject
// secrets without a file on disk.
const fs = require('fs');
const path = require('path');

const env = {};
const file = path.join(__dirname, '.env');

if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
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
