// Postgres access layer. All SQL for the app lives here or in the api modules —
// nothing above this file talks to `pg` directly.
const { Pool } = require('pg');
const env = require('../env.js');

const DATABASE_URL = env.DATABASE_URL || '';

if (!DATABASE_URL) {
  console.error(`
  ✖ DATABASE_URL is not set.

    Ieumi now stores centers, rosters, priorities and requests in Postgres
    (PROJECT.md §6-P0). Put a connection string in ieumi-server/.env:

      DATABASE_URL=postgres://user:password@host:5432/ieumi

    A free hosted Postgres (Neon, Supabase, Railway) works; so does a local one.
    Then run:  npm run setup    (from ieumi-server/)
`);
}

// TLS. The certificate is verified by default: hosted Postgres (Neon, Supabase,
// RDS) presents a publicly-signed chain Node can check, and skipping the check
// would leave senior citizens' personal data open to interception in transit.
//   DB_SSL unset      verify the certificate (no TLS at all for localhost)
//   DB_SSL=off        no TLS — a plain local server with none configured
//   DB_SSL=no-verify  TLS without verification — self-signed certificates only
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const ssl =
  env.DB_SSL === 'off' || (!env.DB_SSL && isLocal) ? false
  : env.DB_SSL === 'no-verify' ? { rejectUnauthorized: false }
  : { rejectUnauthorized: true };

// 서버리스 Postgres(Neon)는 놀고 있으면 스스로 잠듭니다.
//
// 그러면 다음 연결은 <깨우는 시간>을 기다려야 합니다. 10초로는 모자랐습니다:
// 링크 수집처럼 오래 도는 작업은 한 페이지를 브라우저로 여는 데만 30초가 걸려,
// 그 사이 풀의 연결이 끊기고 다음 저장에서 새 연결을 잡다가 시간이 초과됐습니다.
// 오류 문구가 "Connection terminated due to connection timeout" 한 줄이라,
// 데이터베이스가 죽은 것처럼 보이지만 실은 자고 있었을 뿐입니다.
//
// Neon suspends when idle, and waking it can take longer than ten seconds. A
// long batch — one rendered page costs ~30s — leaves the pool idle long enough
// to be dropped, and the next write then pays the wake-up cost. The error is a
// single line that reads like a dead database rather than a sleeping one.
//
// 살아 있는 동안 연결을 붙잡아 두는 편이 낫습니다 (keepAlive).
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
  max: Number(env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(env.DB_IDLE_TIMEOUT_MS || 60_000),
  connectionTimeoutMillis: Number(env.DB_CONNECT_TIMEOUT_MS || 30_000),
  keepAlive: true,
});

pool.on('error', (err) => console.error('[db] idle client error:', err.message));

/** Run a parameterised query. Always use $1/$2 placeholders — never string concatenation. */
async function query(text, params = []) {
  return pool.query(text, params);
}

/** First row, or null. */
async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

/** All rows. */
async function all(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}

/** Run fn inside a transaction, rolling back on any throw. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** True when the database is reachable — used by /health. */
async function ping() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

module.exports = { pool, query, one, all, tx, ping, DATABASE_URL };
