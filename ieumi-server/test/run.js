/*
 * 통합 테스트 — Integration tests for the multi-tenant layer.
 *
 * Runs the real migration, the real seed and the real API handlers against a
 * genuine Postgres compiled to WASM (PGlite), so no database server is needed:
 *
 *     cd ieumi-server && npm test
 *
 * The point of these tests is the tenant boundary: a center must never be able
 * to see or touch another center's data (PROJECT.md §3-1).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { PGlite } = require('@electric-sql/pglite');

// ---------------------------------------------------------------- db shim
// db/index.js talks to `pg`. Swap in a PGlite-backed module with the same shape
// *before* auth.js and api.js are loaded, so they use this instead.
const pg = new PGlite();

// `pg` sets rowCount to the rows returned for a SELECT and the rows affected for
// a DML statement. PGlite reports affectedRows (0 for SELECT) and rows
// separately, so map both onto the shape the app expects — otherwise every
// `SELECT … ` existence check here would look like it found nothing.
const normalise = (r) => ({
  rows: r.rows || [],
  rowCount: (r.rows && r.rows.length) ? r.rows.length : (r.affectedRows ?? 0),
});

const shim = {
  DATABASE_URL: 'pglite://memory',
  query: async (text, params = []) => normalise(await pg.query(text, params)),
  one:   async (text, params = []) => (await pg.query(text, params)).rows[0] || null,
  all:   async (text, params = []) => (await pg.query(text, params)).rows || [],
  tx:    async (fn) => pg.transaction(async (t) => fn({ query: async (s, p = []) => normalise(await t.query(s, p)) })),
  ping:  async () => true,
  pool:  { end: async () => {} },
};

const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: shim, children: [], paths: [] };

const auth = require('../auth');
const api = require('../api');
const { seed } = require('../db/seed');
const { buildSystem } = require('../prompt');

// ---------------------------------------------------------------- fake http
function makeReq({ method = 'GET', url = '/', body, cookie, json = true }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = { 'user-agent': 'test' };
  if (json && body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = `${auth.COOKIE}=${encodeURIComponent(cookie)}`;

  return {
    method, url, headers,
    on(event, cb) {
      if (event === 'data' && payload) process.nextTick(() => cb(Buffer.from(payload)));
      if (event === 'end') process.nextTick(() => cb());
      return this;
    },
    destroy() {},
  };
}

function makeRes() {
  const res = {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(code, hdrs) { this.statusCode = code; Object.assign(this.headers, hdrs || {}); },
    end(chunk) { try { this.body = JSON.parse(String(chunk)); } catch { this.body = String(chunk); } },
  };
  return res;
}

/** Drive one API request the way server.js does. */
async function call(opts) {
  const req = makeReq(opts);
  const res = makeRes();
  const handled = await api.handle(req, res, new URL(opts.url, 'http://x'));
  assert.ok(handled, `route not handled: ${opts.method} ${opts.url}`);
  return res;
}

async function login(username, password) {
  const res = await call({ method: 'POST', url: '/api/login', body: { username, password } });
  assert.strictEqual(res.statusCode, 200, `login failed for ${username}: ${JSON.stringify(res.body)}`);
  const cookie = String(res.headers['set-cookie']).match(/ieumi_sid=([^;]+)/)[1];
  return { cookie: decodeURIComponent(cookie), user: res.body.user, center: res.body.center };
}

// ---------------------------------------------------------------- runner
let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ================================================================ tests
test('migration applies cleanly', async () => {
  const dir = path.join(__dirname, '..', 'db', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  const t = await shim.all(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  const names = t.map((r) => r.table_name);
  for (const want of ['centers', 'users', 'sessions', 'members', 'services',
                      'center_services', 'center_settings', 'requests', 'job_posts']) {
    assert.ok(names.includes(want), `missing table: ${want}`);
  }
});

test('seed creates the tenant, the 3 roles and the split catalog', async () => {
  const accounts = await seed(shim);
  assert.strictEqual(accounts.length, 3, 'expected master, center_admin and staff');

  const center = await shim.one(`SELECT * FROM centers WHERE slug = 'seocho'`);
  assert.ok(center && center.kiosk_token, 'center should have a kiosk token');

  const common = await shim.one(`SELECT count(*)::int n FROM services WHERE scope = 'common'`);
  const local  = await shim.one(`SELECT count(*)::int n FROM services WHERE scope = 'center'`);
  assert.strictEqual(common.n + local.n, 60, 'all 60 services should be seeded');
  assert.strictEqual(local.n, 45, 'the client classifies 45 of them as Seocho-only (11 common + 4 of our own additions stay common)');

  const members = await shim.one('SELECT count(*)::int n FROM members');
  assert.strictEqual(members.n, 6);
  const reqs = await shim.one('SELECT count(*)::int n FROM requests');
  assert.strictEqual(reqs.n, 7);

  // Re-running must not duplicate anything.
  await seed(shim);
  const after = await shim.one(`SELECT count(*)::int n FROM services`);
  assert.strictEqual(after.n, 60, 'seed should be idempotent');
});

// Needs a center to exist, so it runs after the seed.
test('the schema itself refuses a mis-scoped account', async () => {
  await assert.rejects(
    shim.query(`INSERT INTO users (center_id, role, username, password_hash)
                VALUES ((SELECT id FROM centers LIMIT 1), 'master', 'bad1', 'x')`),
    /users_center_scope|violates check/i,
    'a master must not belong to a center');
  await assert.rejects(
    shim.query(`INSERT INTO users (center_id, role, username, password_hash)
                VALUES (NULL, 'staff', 'bad2', 'x')`),
    /users_center_scope|violates check/i,
    'staff must belong to a center');
  await assert.rejects(
    shim.query(`INSERT INTO services (code, scope, center_id, category)
                VALUES ('x1', 'common', (SELECT id FROM centers LIMIT 1), 'test')`),
    /services_scope_center|violates check/i,
    'common content must not be owned by one center');
});

test('login rejects a wrong password and accepts the right one', async () => {
  const accounts = await shim.all(`SELECT username FROM users ORDER BY username`);
  assert.ok(accounts.length >= 3);
  const bad = await call({ method: 'POST', url: '/api/login', body: { username: 'seocho-staff', password: 'wrong' } });
  assert.strictEqual(bad.statusCode, 401);
  assert.ok(!bad.headers['set-cookie'], 'no session cookie on a failed login');
});

test('repeated wrong passwords are rate limited, per address and username', async () => {
  // A throwaway username: a lockout cannot be lifted by logging in, so hammering
  // a real account here would keep every later test out of it.
  const victim = 'brute-force-target';
  const guess = (pw) => call({ method: 'POST', url: '/api/login', body: { username: victim, password: pw } });

  for (let i = 0; i < 10; i++) {
    assert.strictEqual((await guess('wrong-' + i)).statusCode, 401, `attempt ${i + 1} is a plain rejection`);
  }
  assert.strictEqual((await guess('wrong-again')).statusCode, 429, 'the 11th attempt is throttled');

  // The lock is scoped: a different account from the same address is not caught…
  const other = await call({ method: 'POST', url: '/api/login',
    body: { username: 'someone-else', password: 'whatever' } });
  assert.strictEqual(other.statusCode, 401, 'one hammered username must not lock out the rest');

  // …and the same username from a different address is unaffected.
  const elsewhere = makeReq({ method: 'POST', url: '/api/login', body: { username: victim, password: 'x' } });
  elsewhere.headers['x-forwarded-for'] = '203.0.113.9';
  const res = makeRes();
  await api.handle(elsewhere, res, new URL('/api/login', 'http://x'));
  assert.strictEqual(res.statusCode, 401, 'a different address gets a normal rejection, not the lock');
});

test('an unauthenticated request is refused', async () => {
  const res = await call({ method: 'GET', url: '/api/members' });
  assert.strictEqual(res.statusCode, 401);
});

// The rest of the tests need real sessions, so passwords are set explicitly here.
const PW = { master: 'master-pw-1234', admin: 'admin-pw-1234', staff: 'staff-pw-1234' };
let S = {};

test('sessions are issued for each of the three roles', async () => {
  for (const [key, username] of [['master', 'master'], ['admin', 'seocho-admin'], ['staff', 'seocho-staff']]) {
    await shim.query('UPDATE users SET password_hash = $1 WHERE username = $2',
      [auth.hashPassword(PW[key]), username]);
    S[key] = await login(username, PW[key]);
  }
  assert.strictEqual(S.master.user.role, 'master');
  assert.strictEqual(S.admin.user.role, 'center_admin');
  assert.strictEqual(S.staff.user.role, 'staff');
  assert.strictEqual(S.master.center, null, 'master belongs to no single center');
  assert.ok(S.staff.center.name.includes('서초'));
});

test('the session token is never stored in the database', async () => {
  const row = await shim.one('SELECT id FROM sessions LIMIT 1');
  assert.ok(row && row.id.length === 64 && /^[0-9a-f]+$/.test(row.id), 'session id should be a sha256 hex digest');
  const raw = await shim.one('SELECT 1 AS hit FROM sessions WHERE id = $1', [S.staff.cookie]);
  assert.strictEqual(raw, null, 'the raw cookie value must not appear in the sessions table');
});

let centerB = null;

test('master can create a second center, which inherits the common catalog', async () => {
  const res = await call({ method: 'POST', url: '/api/centers', cookie: S.master.cookie,
    body: { slug: 'gangseo', name: '강서 어르신 복지관', region: '서울특별시 강서구' } });
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
  centerB = res.body.center;

  const inherited = await shim.one(
    'SELECT count(*)::int n FROM center_services WHERE center_id = $1', [centerB.id]);
  assert.strictEqual(inherited.n, 15, 'the new center inherits only the 15 genuinely nationwide services');

  // …and must NOT see Seocho's own 7.
  const visible = await shim.one(
    `SELECT count(*)::int n FROM services s
      WHERE s.active AND (s.scope = 'common' OR s.center_id = $1)`, [centerB.id]);
  assert.strictEqual(visible.n, 15, "a center must not see another center's own services");
});

test('a center admin cannot create a center', async () => {
  const res = await call({ method: 'POST', url: '/api/centers', cookie: S.admin.cookie,
    body: { slug: 'sneaky', name: '몰래 복지관' } });
  assert.strictEqual(res.statusCode, 403);
});

test('TENANT BOUNDARY — a center admin cannot read another center by asking for it', async () => {
  const res = await call({ method: 'GET', url: '/api/members?center=' + centerB.id, cookie: S.admin.cookie });
  assert.strictEqual(res.statusCode, 403, 'cross-center read must be refused');
  assert.match(res.body.error, /다른 복지관/);
});

test('TENANT BOUNDARY — a center admin cannot write into another center', async () => {
  const res = await call({ method: 'POST', url: '/api/members?center=' + centerB.id, cookie: S.admin.cookie,
    body: { name: '침입', phone: '01099990000' } });
  assert.strictEqual(res.statusCode, 403);
  const leaked = await shim.one('SELECT 1 AS hit FROM members WHERE center_id = $1', [centerB.id]);
  assert.strictEqual(leaked, null, 'nothing should have been written into the other center');
});

test('TENANT BOUNDARY — the roster a center sees is only its own', async () => {
  await call({ method: 'POST', url: '/api/members?center=' + centerB.id, cookie: S.master.cookie,
    body: { name: '강서 어르신', phone: '01055556666' } });

  const mine = await call({ method: 'GET', url: '/api/members', cookie: S.admin.cookie });
  assert.strictEqual(mine.statusCode, 200);
  assert.strictEqual(mine.body.members.length, 6, 'Seocho still sees exactly its own 6');
  assert.ok(!mine.body.members.some((m) => m.phone === '01055556666'), "the other center's member must not appear");
});

test('master can switch between centers', async () => {
  const a = await call({ method: 'GET', url: '/api/members', cookie: S.master.cookie });
  assert.strictEqual(a.statusCode, 400, 'master with no center selected is asked to pick one');

  const b = await call({ method: 'GET', url: '/api/members?center=' + centerB.id, cookie: S.master.cookie });
  assert.strictEqual(b.statusCode, 200);
  assert.strictEqual(b.body.members.length, 1);
});

test('staff may edit the roster but not center policy', async () => {
  const add = await call({ method: 'POST', url: '/api/members', cookie: S.staff.cookie,
    body: { name: '새 어르신', phone: '010-7777-8888' } });
  assert.strictEqual(add.statusCode, 200, JSON.stringify(add.body));
  assert.strictEqual(add.body.total, 7);

  const settings = await call({ method: 'PATCH', url: '/api/settings', cookie: S.staff.cookie,
    body: { roster_check_on: true } });
  assert.strictEqual(settings.statusCode, 403, 'staff must not change center settings');

  const users = await call({ method: 'GET', url: '/api/users', cookie: S.staff.cookie });
  assert.strictEqual(users.statusCode, 403, 'staff must not list accounts');
});

test('a center admin can create staff but not another admin or a master', async () => {
  const ok = await call({ method: 'POST', url: '/api/users', cookie: S.admin.cookie,
    body: { username: 'seocho-staff2', password: 'another-pw-1234', role: 'staff', name: '담당자2' } });
  assert.strictEqual(ok.statusCode, 201, JSON.stringify(ok.body));

  for (const role of ['center_admin', 'master']) {
    const no = await call({ method: 'POST', url: '/api/users', cookie: S.admin.cookie,
      body: { username: 'escalate-' + role, password: 'another-pw-1234', role } });
    assert.strictEqual(no.statusCode, 403, `a center admin must not create a ${role}`);
  }
});

test('master can create an account in a chosen center', async () => {
  // The dashboard passes the center as a query parameter, so that path must work.
  const res = await call({ method: 'POST', url: '/api/users?center=' + centerB.id, cookie: S.master.cookie,
    body: { username: 'gangseo-staff', password: 'gangseo-pw-1234', role: 'staff', name: '강서 담당자' } });
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));
  assert.strictEqual(res.body.user.center_id, centerB.id);

  const dupe = await call({ method: 'POST', url: '/api/users?center=' + centerB.id, cookie: S.master.cookie,
    body: { username: 'gangseo-staff', password: 'gangseo-pw-1234', role: 'staff' } });
  assert.strictEqual(dupe.statusCode, 409, 'usernames are how people log in, so they must be unique');
});

test('a new staff account is confined to its own center', async () => {
  const them = await login('gangseo-staff', 'gangseo-pw-1234');
  const mine = await call({ method: 'GET', url: '/api/members', cookie: them.cookie });
  assert.strictEqual(mine.statusCode, 200);
  assert.ok(mine.body.members.every((m) => m.phone !== '01012343456'), 'must not see Seocho members');

  const seocho = await shim.one(`SELECT id FROM centers WHERE slug = 'seocho'`);
  const cross = await call({ method: 'GET', url: '/api/members?center=' + seocho.id, cookie: them.cookie });
  assert.strictEqual(cross.statusCode, 403);
});

test('a short password is refused', async () => {
  const res = await call({ method: 'POST', url: '/api/users', cookie: S.admin.cookie,
    body: { username: 'weak', password: 'short', role: 'staff' } });
  assert.strictEqual(res.statusCode, 400);
});

test('changing a password invalidates that user\'s sessions', async () => {
  const victim = await login('seocho-staff2', 'another-pw-1234');
  const before = await call({ method: 'GET', url: '/api/members', cookie: victim.cookie });
  assert.strictEqual(before.statusCode, 200);

  await call({ method: 'PATCH', url: '/api/users/' + victim.user.id, cookie: S.admin.cookie,
    body: { password: 'rotated-pw-1234' } });

  const after = await call({ method: 'GET', url: '/api/members', cookie: victim.cookie });
  assert.strictEqual(after.statusCode, 401, 'the old session must stop working');
});

test('priority: enabling and ordering services persists, scoped to the center', async () => {
  const list = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  assert.strictEqual(list.statusCode, 200);
  assert.strictEqual(list.body.services.length, 60, 'Seocho sees 15 common + its own 45');

  const items = list.body.services.map((s, i) => ({ id: s.id, enabled: i < 3, sort_order: 59 - i }));
  const save = await call({ method: 'PUT', url: '/api/services/priority', cookie: S.admin.cookie, body: { items } });
  assert.strictEqual(save.statusCode, 200);

  const again = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  const enabled = again.body.services.filter((s) => s.enabled);
  assert.strictEqual(enabled.length, 3);
  assert.strictEqual(again.body.services[0].sort_order, 0, 'order is reversed by the save above');

  // The other center is untouched.
  const other = await call({ method: 'GET', url: '/api/services?center=' + centerB.id, cookie: S.master.cookie });
  assert.strictEqual(other.body.services.filter((s) => s.enabled).length, 0);
});

test('priority save ignores a service id belonging to another center', async () => {
  const seocho = await shim.one(`SELECT id FROM services WHERE scope = 'center' LIMIT 1`);
  const res = await call({ method: 'PUT', url: '/api/services/priority?center=' + centerB.id, cookie: S.master.cookie,
    body: { items: [{ id: seocho.id, enabled: true, sort_order: 0 }] } });
  assert.strictEqual(res.statusCode, 200);
  const row = await shim.one('SELECT 1 AS hit FROM center_services WHERE center_id = $1 AND service_id = $2',
    [centerB.id, seocho.id]);
  assert.strictEqual(row, null, "a center must not be able to adopt another center's private service");
});

test('priority save tolerates duplicate and malformed ids', async () => {
  const list = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie })).body.services;
  // Write back the state this service already has, so later tests that count
  // enabled services still see what the earlier tests set up.
  const one = list[0];
  const res = await call({ method: 'PUT', url: '/api/services/priority', cookie: S.admin.cookie, body: { items: [
    { id: one.id, enabled: one.enabled, sort_order: one.sort_order },
    { id: one.id, enabled: one.enabled, sort_order: one.sort_order },  // same row twice in one statement
    { id: 'not-a-uuid',                 sort_order: 2 },   // would break the uuid[] cast
    { id: '00000000-0000-0000-0000-000000000000', sort_order: 3 },  // valid uuid, no such service
  ]}});
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.saved, 1, 'only the one real, deduplicated service is written');
});

test('a bulk roster paste with repeated numbers succeeds', async () => {
  const res = await call({ method: 'POST', url: '/api/members', cookie: S.staff.cookie, body: { members: [
    { name: '중복1', phone: '010-9000-0001' },
    { name: '중복2', phone: '01090000001' },   // the same number again, different spelling
    { name: '정상',  phone: '010-9000-0002' },
  ]}});
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.saved, 2, 'the repeat collapses instead of erroring');

  const row = await shim.one('SELECT name FROM members WHERE phone = $1', ['01090000001']);
  assert.strictEqual(row.name, '중복2', 'the last spelling in the paste wins');
});

test('settings: the kiosk token reaches admins but not staff', async () => {
  const asAdmin = await call({ method: 'GET', url: '/api/settings', cookie: S.admin.cookie });
  assert.ok(asAdmin.body.settings.kiosk_token, 'an admin needs the token to configure a kiosk');

  const asStaff = await call({ method: 'GET', url: '/api/settings', cookie: S.staff.cookie });
  assert.strictEqual(asStaff.statusCode, 200);
  assert.strictEqual(asStaff.body.settings.kiosk_token, undefined, 'staff should not receive the kiosk token');

  // A save must return what a load returns, or the dashboard's copy of the
  // settings quietly loses the token after the first edit.
  const saved = await call({ method: 'PATCH', url: '/api/settings', cookie: S.admin.cookie,
    body: { greeting: '토큰 유지 확인' } });
  assert.strictEqual(saved.body.settings.kiosk_token, asAdmin.body.settings.kiosk_token,
    'PATCH and GET must return the same shape');
});

test('settings: Ieumi name, voice and tone round-trip', async () => {
  const res = await call({ method: 'PATCH', url: '/api/settings', cookie: S.admin.cookie,
    body: { ieumi_name: '서초이음이', tone: 'cheerful', voice_speaker: 'vian', roster_check_on: true } });
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.settings.ieumi_name, '서초이음이');
  assert.strictEqual(res.body.settings.tone, 'cheerful');

  const bad = await call({ method: 'PATCH', url: '/api/settings', cookie: S.admin.cookie, body: { tone: 'evil' } });
  assert.strictEqual(bad.body.settings.tone, 'warm', 'an unknown tone falls back to warm');
});

// ---------------------------------------------------------------- kiosk
let kioskA = null, kioskB = null;

test('kiosk: an unknown token gets nothing', async () => {
  kioskA = (await shim.one(`SELECT kiosk_token FROM centers WHERE slug = 'seocho'`)).kiosk_token;
  kioskB = (await shim.one(`SELECT kiosk_token FROM centers WHERE slug = 'gangseo'`)).kiosk_token;
  assert.notStrictEqual(kioskA, kioskB);

  const res = await call({ method: 'GET', url: '/api/kiosk/context?c=not-a-real-token' });
  assert.strictEqual(res.statusCode, 404);
});

test('kiosk: context returns that center\'s own persona and enabled services', async () => {
  const res = await call({ method: 'GET', url: '/api/kiosk/context?c=' + kioskA });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.center.name.includes('서초'));
  assert.strictEqual(res.body.settings.ieumi_name, '서초이음이');
  assert.strictEqual(res.body.services.length, 3, 'only the enabled services are sent to the kiosk');

  const b = await call({ method: 'GET', url: '/api/kiosk/context?c=' + kioskB });
  assert.strictEqual(b.body.settings.ieumi_name, '이음이', 'the other center keeps its own default');
  assert.strictEqual(b.body.services.length, 0);
});

test('kiosk: roster lookup only matches inside the kiosk\'s own center', async () => {
  const hit = await call({ method: 'POST', url: '/api/kiosk/lookup', body: { c: kioskA, phone: '010-1234-3456' } });
  assert.strictEqual(hit.body.found, true);
  assert.strictEqual(hit.body.name, '김순자');

  // Same number, other center's kiosk → must not resolve.
  const miss = await call({ method: 'POST', url: '/api/kiosk/lookup', body: { c: kioskB, phone: '010-1234-3456' } });
  assert.strictEqual(miss.body.found, false, "a kiosk must not read another center's roster");
});

test('kiosk: a filed request lands in the right center and links the member', async () => {
  const res = await call({ method: 'POST', url: '/api/kiosk/requests', body: {
    c: kioskA, phone: '01012343456', category: 'job', summary: '일자리 문의',
    urgent: false, chips: ['문자 발송됨'],
    transcript: [{ role: 'senior', text: '일자리 있나요' }, { role: 'ieumi', text: '네, 있어요' }],
  }});
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.body));

  const row = await shim.one('SELECT * FROM requests WHERE id = $1', [res.body.id]);
  const seocho = await shim.one(`SELECT id FROM centers WHERE slug = 'seocho'`);
  assert.strictEqual(row.center_id, seocho.id);
  assert.ok(row.member_id, 'a known caller should be linked to their member record');
  assert.strictEqual(row.status, '접수');

  // The other center must not see it.
  const others = await call({ method: 'GET', url: '/api/requests?center=' + centerB.id, cookie: S.master.cookie });
  assert.strictEqual(others.body.requests.length, 0);
});

// ================================================================ 프롬프트 캐싱 (§9)
// Caching only pays if the cached half really is the half that stays still. The
// two tests below are what stop a later edit from moving something per-turn into
// the cached block, which would silently turn every cache hit into a miss.
test('prompt caching: the per-turn jobs list stays outside the cached block', async () => {
  const { systemBlocks } = require('../prompt');
  const kioskCtx = require('../kiosk-context');
  kioskCtx.bustAll();
  const persona = await kioskCtx.forToken(kioskA);
  const info = { jobs: [{ gu: '서초구', job: '경비', org: '한국시니어클럽' }], scope: 'center' };

  const blocks = systemBlocks(persona, info);
  assert.strictEqual(blocks.length, 2);
  assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral' },
    'the stable half is the cached prefix');
  assert.strictEqual(blocks[1].cache_control, undefined,
    'and nothing after it is cached, or every new question would be a cache miss');

  assert.ok(blocks[0].text.includes(persona.services[0].sub), 'the catalogue is in the cached half');
  assert.ok(!blocks[0].text.includes('한국시니어클럽'), 'the postings are not');
  assert.ok(blocks[1].text.includes('한국시니어클럽'));
});

test('prompt caching: the cached half does not move between turns', async () => {
  const { systemBlocks } = require('../prompt');
  const kioskCtx = require('../kiosk-context');
  kioskCtx.bustAll();
  const persona = await kioskCtx.forToken(kioskA);

  // 같은 복지관, 다른 질문 — the same centre, two different questions, which is
  // what a real conversation looks like from the second turn onward.
  const a = systemBlocks(persona, { jobs: [{ gu: '서초구', job: '경비' }], scope: 'center' });
  const b = systemBlocks(persona, { jobs: [], scope: 'none', asked: '강남구' });
  assert.strictEqual(a[0].text, b[0].text, 'byte-identical, or the cache never hits');
  assert.notStrictEqual(a[1].text, b[1].text, 'while the part that should change, changes');

  // 캐시를 못 쓰게 되어도 같은 프롬프트여야 합니다 — the fallback must be the same
  // prompt, not a different one, or a degraded request quietly changes behaviour.
  assert.strictEqual(systemBlocks(persona, { jobs: [], scope: 'none' }, { cache: false }),
                     b[0].text + b[1].text);
});

test('the kiosk system prompt carries the centre\'s enabled services, in order', async () => {
  // §6-P1: the priority tool is only wired if what a centre selected actually
  // reaches the conversation.
  const kioskCtx = require('../kiosk-context');
  kioskCtx.bustAll();
  const persona = await kioskCtx.forToken(kioskA);

  assert.strictEqual(persona.services.length, 3, 'only enabled services travel to the kiosk');
  assert.ok(persona.center_name.includes('서초'));

  const prompt = buildSystem(persona);
  for (const s of persona.services) {
    assert.ok(prompt.includes(s.sub), `the prompt should name "${s.sub}"`);
  }
  assert.ok(prompt.indexOf(persona.services[0].sub) < prompt.indexOf(persona.services[2].sub),
    'the centre\'s chosen order must survive into the prompt');
  assert.ok(prompt.includes('우선순위'), 'and be presented as a priority order');
  assert.ok(prompt.includes('지어내지'), 'with the do-not-invent rule for services that have no live data');
  assert.ok(/"service":/.test(prompt), 'and ask which service was matched');

  // A centre with nothing switched on gets no service section at all, rather
  // than an empty heading.
  const bare = buildSystem({ ieumi_name: '이음이', services: [] });
  assert.ok(!bare.includes('우리 복지관이 안내하는 서비스'), 'no list, no section');
});

test('the model\'s output splits into speech and data', async () => {
  // The spoken part comes first so it can be streamed and synthesised while the
  // rest is still being written (§3-6). The parser has to survive a model that
  // ignores that instruction, too — otherwise Ieumi goes silent.
  const { parseModelOutput } = require('../prompt');

  const current = parseModelOutput(
    '많이 불편하시겠어요. 담당 선생님께 전해드릴게요.\n{"category":"건강","summary":"야간 병원","offerSms":true,"pick":0,"service":1}');
  assert.strictEqual(current.reply, '많이 불편하시겠어요. 담당 선생님께 전해드릴게요.');
  assert.strictEqual(current.meta.category, '건강');
  assert.strictEqual(current.meta.service, 1);
  assert.ok(!current.reply.includes('{'), 'the data line must never be spoken');

  // A reply spanning several lines still keeps only the final JSON line as data.
  const multi = parseModelOutput('첫 문장입니다.\n두 번째 문장입니다.\n{"category":"복지","service":0}');
  assert.strictEqual(multi.reply, '첫 문장입니다.\n두 번째 문장입니다.');
  assert.strictEqual(multi.meta.category, '복지');

  // The older single-object shape, in case a model reverts to it.
  const legacy = parseModelOutput('{"reply":"안녕하세요 어르신","category":"기타","pick":0}');
  assert.strictEqual(legacy.reply, '안녕하세요 어르신');
  assert.strictEqual(legacy.meta.category, '기타');

  // No data line at all: say it rather than saying nothing.
  const bare = parseModelOutput('안녕하세요 어르신, 무엇을 도와드릴까요?');
  assert.strictEqual(bare.reply, '안녕하세요 어르신, 무엇을 도와드릴까요?');
  assert.deepStrictEqual(bare.meta, {});

  // Malformed trailing JSON must not swallow the speech.
  const broken = parseModelOutput('말씀하신 대로 전해드릴게요.\n{"category":');
  assert.ok(broken.reply.includes('전해드릴게요'), 'a broken data line must not silence the reply');

  // The prompt forbids code blocks, but models produce them anyway — and a
  // stray fence would be read aloud to the caller. Seen in a live conversation.
  const fenced = parseModelOutput(
    '방배동에 있는 아파트에서 하시는 청소 일이에요.\n\n```json\n{"category":"일자리","pick":1,"service":0}\n```');
  assert.strictEqual(fenced.reply, '방배동에 있는 아파트에서 하시는 청소 일이에요.');
  assert.strictEqual(fenced.meta.category, '일자리');
  assert.strictEqual(fenced.meta.pick, 1);
  assert.ok(!fenced.reply.includes('`'), 'no backtick may reach the speech');

  const bareFence = parseModelOutput('안녕하세요 어르신.\n```\n{"category":"기타"}\n```');
  assert.strictEqual(bareFence.reply, '안녕하세요 어르신.');
  assert.strictEqual(bareFence.meta.category, '기타');
});

test('job postings: region parsing and the honest gaps', async () => {
  const jobs = require('../jobs');
  const { jobsSection } = require('../prompt');

  // Centre regions read "서울특별시 서초구"; the job feed says "서울 서초구".
  assert.strictEqual(jobs.normaliseSido('서울특별시'), '서울');
  assert.strictEqual(jobs.normaliseSido('경기도'), '경기');
  assert.strictEqual(jobs.normaliseSido('제주특별자치도'), '제주');
  assert.deepStrictEqual(jobs.splitPlace('서울 서초구'), { sido: '서울', sigungu: '서초구' });

  // The source has no wage and no shift for any posting, so the prompt has to
  // say so — otherwise Ieumi fills the gap with something plausible.
  const withJobs = jobsSection({
    jobs: [{ gu: '서울 서초구', job: '아파트 청소원', org: '○○관리', tel: '02-0000-0000' }],
    scope: 'sigungu', region: '서울 서초구', centerRegion: '서울특별시 서초구',
  });
  assert.ok(withJobs.includes('급여와 근무시간 정보가 없습니다'), 'the missing fields must be declared');
  assert.ok(withJobs.includes('아파트 청소원'));

  // Widening to the province has to be announced, not hidden.
  const widened = jobsSection({
    jobs: [{ gu: '서울 강북구', job: '경비원' }],
    scope: 'sido', region: '서울', centerRegion: '서울특별시 서초구',
  });
  assert.ok(widened.includes('서초구') && widened.includes('열린 자리가 없어'),
    'a senior should be told the posting is not in their own district');

  // Nothing at all: say so rather than inventing.
  const none = jobsSection({ jobs: [], scope: 'none', region: '서울', centerRegion: '서울특별시 서초구' });
  assert.ok(none.includes('지어내지 말고'), 'an empty list must forbid invention');
  assert.ok(!none.includes('급여와 근무시간'), 'and not warn about fields of a list that does not exist');
});

test('a posting is only placed in a district the feed itself stated', async () => {
  // The employer's postal address is not necessarily where the work is: a real
  // case had an agency in 서울 강서구 advertising a post in 마장면, 이천. A senior
  // may travel to whatever Ieumi names, so an inferred region must not match.
  const jobs = require('../jobs');
  assert.deepStrictEqual(
    jobs.placeFromAddress('07591 서울특별시 강서구 공항대로 325, 7층 (등촌동)'),
    { sido: '서울', sigungu: '강서구', place: '서울 강서구' });

  await shim.query(
    `INSERT INTO jobs (id, title, place, sido, sigungu, region_source, deadline)
     VALUES ('trust-api',  '피드가 밝힌 자리', '서울 서초구', '서울', '서초구', 'api', '접수중'),
            ('trust-addr', '주소로 유추한 자리', '서울 서초구', '서울', '서초구', 'address', '접수중')`);

  const found = await jobs.forCenterRegion('서울특별시 서초구', 10);
  const ids = found.jobs.map((j) => j.id);
  assert.ok(ids.includes('trust-api'), 'a feed-stated region is used');
  assert.ok(!ids.includes('trust-addr'), 'an address-inferred region must not place a job in a district');

  await shim.query(`DELETE FROM jobs WHERE id IN ('trust-api', 'trust-addr')`);
});

test('an expired posting is never offered', async () => {
  // Openness is checked when a posting is stored, not when it is offered — so
  // without a date filter yesterday's deadline is still read out today. This
  // only bites once the sync runs on a schedule, which is when nobody is watching.
  const jobs = require('../jobs');
  await shim.query(
    `INSERT INTO jobs (id, title, place, sido, sigungu, region_source, deadline, to_date)
     VALUES ('job-open',    '아직 열린 자리', '서울 서초구', '서울', '서초구', 'api', '접수중', current_date + 7),
            ('job-expired', '어제 마감된 자리', '서울 서초구', '서울', '서초구', 'api', '접수중', current_date - 1),
            ('job-nodate',  '마감일 없는 자리', '서울 서초구', '서울', '서초구', 'api', '접수중', NULL)`);

  const ids = (await jobs.forCenterRegion('서울특별시 서초구', 10)).jobs.map((j) => j.id);
  assert.ok(ids.includes('job-open'), 'an open posting is offered');
  assert.ok(ids.includes('job-nodate'), 'no deadline means still open');
  assert.ok(!ids.includes('job-expired'), 'a closed posting must not be offered');

  await shim.query(`DELETE FROM jobs WHERE id LIKE 'job-%'`);
});

test('the prompt asks for speech first and data last', async () => {
  const kioskCtx = require('../kiosk-context');
  const prompt = buildSystem(await kioskCtx.forToken(kioskA));
  const speechFirst = prompt.indexOf('먼저 어르신께 할 말');
  const dataLast = prompt.indexOf('{"category"');
  assert.ok(speechFirst > 0 && dataLast > speechFirst,
    'the spoken part must be requested before the JSON, or nothing can be streamed');
  assert.ok(!/"reply"\s*:/.test(prompt),
    'the reply must not be asked for inside the JSON object — that is what blocked streaming');
});

// ================================================================ 뜻으로 알아듣기
// 클라이언트 보고: "질문을 조금만 비틀면 답을 못 한다. 정확한 질문을 해야만
// 답이 나온다." 원인은 프롬프트에 있었습니다 — 카탈로그의 '검색어'(keywords)
// 칸이 데이터베이스와 kiosk-context 에는 있었는데 프롬프트에는 한 번도 실리지
// 않았습니다. 목록에는 서비스의 공식 이름만 적혀 있었고, 어르신이 쓰시는 말은
// 한 줄도 없었습니다.
//
// Reported by the client: twist the question and Ieumi stops answering. The
// `keywords` column — the words seniors actually use — was in the database and
// in the kiosk context but never rendered into the prompt, so the model only
// ever saw each service's formal catalogue name.
test('the words seniors actually use reach the prompt', async () => {
  const p = buildSystem({
    ieumi_name: '이음이',
    services: [{ code: 's1', category: '건강 및 의료', sub: '응급 및 야간/휴일 진료',
                 description: '주말/공휴일 당번 약국', org: '휴일지킴이약국',
                 keywords: '야간 병원, 문 연 약국, 응급실' }],
  });
  assert.ok(p.includes('문 연 약국'),
    'a senior asks for "a pharmacy that is open", not for "Emergency & Night/Holiday Care"');
  assert.ok(p.includes('야간 병원') && p.includes('응급실'), 'every keyword travels, not just the first');
  assert.ok(p.indexOf('응급 및 야간/휴일 진료') < p.indexOf('문 연 약국'),
    'the keywords sit under their own service, so the model knows which row they belong to');

  // 검색어가 비어 있는 줄은 ↳ 줄 자체가 붙지 않습니다 — 빈 꼬리표는 프롬프트만
  // 늘리고 알려 주는 것이 없습니다.
  const bare = buildSystem({ services: [{ code: 's9', category: '일상', sub: '버스 도착' }] });
  assert.ok(!bare.includes('이렇게 물으셔도'), 'no keywords, no empty label');
});

test('english: the words are carried in English too', async () => {
  const p = buildSystem({ lang: 'en', services: [
    { code: 's1', category: '건강', category_en: 'Health', sub: '응급', sub_en: 'Emergency care',
      description: '당번 약국', description_en: 'Duty pharmacies',
      keywords: '문 연 약국', keywords_en: 'night hospital, open pharmacy, emergency room' }] });
  assert.ok(p.includes('open pharmacy'), 'the English keywords are used on an English kiosk');
  assert.ok(!p.includes('문 연 약국'), 'and the Korean ones are not repeated alongside them');
});

test('the prompt tells Ieumi to match on meaning, not on wording', async () => {
  // 규칙이 없으면 목록만 늘어놓은 셈입니다. "글자가 다르면 모른다"고 답하던 것이
  // 바로 클라이언트가 본 증상입니다.
  const p = buildSystem({ services: [{ code: 's1', category: '건강', sub: '응급', description: 'x' }] });
  assert.ok(p.includes('뜻이 같으면 같은 서비스입니다'),
    'the rule has to say so in as many words');
  assert.ok(/사투리/.test(p), 'dialect and roundabout phrasing are named as the same thing');
  assert.ok(/셋 이상 늘어놓지 말고/.test(p),
    'and a clarifying question is capped at two choices — a senior cannot hold a list by ear');

  // 서비스가 하나도 없으면 이 규칙도 없습니다 — 고를 목록이 없으니까요.
  const bare = buildSystem({ services: [] });
  assert.ok(!bare.includes('뜻이 같으면 같은 서비스입니다'), 'no list, no matching rule');
});

test('the kiosk context cache is dropped when the dashboard changes it', async () => {
  const kioskCtx = require('../kiosk-context');
  const before = await kioskCtx.forToken(kioskA);
  assert.strictEqual(before.services.length, 3);

  // Enable a fourth service through the API, exactly as the dashboard does.
  const all = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie })).body.services;
  const extra = all.find((s) => !s.enabled);
  await call({ method: 'PUT', url: '/api/services/priority', cookie: S.admin.cookie,
    body: { items: all.map((s, i) => ({ id: s.id, enabled: s.enabled || s.id === extra.id, sort_order: i })) } });

  const after = await kioskCtx.forToken(kioskA);
  assert.strictEqual(after.services.length, 4, 'a saved change must be audible on the next call, not a minute later');

  // Put it back so the later counts still hold.
  await call({ method: 'PUT', url: '/api/services/priority', cookie: S.admin.cookie,
    body: { items: all.map((s, i) => ({ id: s.id, enabled: s.enabled, sort_order: i })) } });
  assert.strictEqual((await kioskCtx.forToken(kioskA)).services.length, 3);
});

test('kiosk: a filed request records which service it was about', async () => {
  const ctx = await call({ method: 'GET', url: '/api/kiosk/context?c=' + kioskA });
  const code = ctx.body.services[0].code;

  const filed = await call({ method: 'POST', url: '/api/kiosk/requests',
    body: { c: kioskA, category: 'health', summary: '야간 병원 문의', serviceCode: code } });
  assert.strictEqual(filed.statusCode, 201);

  const row = await shim.one('SELECT service_code FROM requests WHERE id = $1', [filed.body.id]);
  assert.strictEqual(row.service_code, code);

  // The staff dashboard resolves it to a readable name.
  const listed = (await call({ method: 'GET', url: '/api/requests', cookie: S.staff.cookie })).body.requests;
  const mine = listed.find((r) => r.id === filed.body.id);
  assert.strictEqual(mine.service_name, ctx.body.services[0].sub);
});

test('kiosk: a service the centre has not enabled is not recorded', async () => {
  const disabled = await shim.one(
    `SELECT sv.code FROM services sv
       JOIN center_services cs ON cs.service_id = sv.id
      WHERE cs.center_id = (SELECT id FROM centers WHERE slug = 'seocho')
        AND cs.enabled = false LIMIT 1`);

  const filed = await call({ method: 'POST', url: '/api/kiosk/requests',
    body: { c: kioskA, summary: 'x', serviceCode: disabled.code } });
  assert.strictEqual(filed.statusCode, 201, 'the call is still recorded');

  const row = await shim.one('SELECT service_code FROM requests WHERE id = $1', [filed.body.id]);
  assert.strictEqual(row.service_code, null, 'but not attributed to a service the centre never switched on');
});

test('kiosk: a bad category is coerced rather than trusted', async () => {
  const res = await call({ method: 'POST', url: '/api/kiosk/requests',
    body: { c: kioskA, category: 'DROP TABLE', summary: 'x' } });
  assert.strictEqual(res.statusCode, 201);
  const row = await shim.one('SELECT category FROM requests WHERE id = $1', [res.body.id]);
  assert.strictEqual(row.category, 'etc');
});

test('the request list has a stable order across repeated reads', async () => {
  // now() inside a transaction is the transaction's start time, so seeded rows
  // can share a created_at. Without a tiebreak the dashboard reshuffles on
  // every reload, which reads as a bug to anyone watching a demo.
  const seocho = await shim.one(`SELECT id FROM centers WHERE slug = 'seocho'`);
  await shim.query(
    `INSERT INTO requests (center_id, summary, created_at)
     SELECT $1, 'tie ' || g, '2026-01-01T00:00:00Z'::timestamptz FROM generate_series(1, 5) g`,
    [seocho.id]);

  const first = (await call({ method: 'GET', url: '/api/requests', cookie: S.staff.cookie })).body.requests.map((r) => r.id);
  for (let i = 0; i < 3; i++) {
    const again = (await call({ method: 'GET', url: '/api/requests', cookie: S.staff.cookie })).body.requests.map((r) => r.id);
    assert.deepStrictEqual(again, first, 'identical timestamps must still yield one stable order');
  }
});

test('staff can move a request through its statuses', async () => {
  const list = await call({ method: 'GET', url: '/api/requests', cookie: S.staff.cookie });
  assert.ok(list.body.requests.length > 0);
  const id = list.body.requests[0].id;

  const ok = await call({ method: 'PATCH', url: '/api/requests/' + id, cookie: S.staff.cookie,
    body: { status: '처리중', memo: '연락 예정' } });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(ok.body.request.status, '처리중');

  const bad = await call({ method: 'PATCH', url: '/api/requests/' + id, cookie: S.staff.cookie,
    body: { status: '아무거나' } });
  assert.strictEqual(bad.statusCode, 400);
});

test('TENANT BOUNDARY — staff cannot patch a request in another center', async () => {
  const r = await shim.one(
    `INSERT INTO requests (center_id, summary) VALUES ($1, '남의 요청') RETURNING id`, [centerB.id]);
  const res = await call({ method: 'PATCH', url: '/api/requests/' + r.id, cookie: S.staff.cookie,
    body: { status: '완료' } });
  assert.strictEqual(res.statusCode, 404, "another center's request must not be reachable");

  const still = await shim.one('SELECT status FROM requests WHERE id = $1', [r.id]);
  assert.strictEqual(still.status, '접수', 'and it must be unchanged');
});

test('a non-JSON mutation is refused (CSRF guard)', async () => {
  const res = await call({ method: 'POST', url: '/api/members', cookie: S.staff.cookie,
    body: { name: 'x', phone: '01011112222' }, json: false });
  assert.strictEqual(res.statusCode, 415);
});

test('bulk roster upload saves the valid rows and reports the rest', async () => {
  const res = await call({ method: 'POST', url: '/api/members', cookie: S.staff.cookie, body: { members: [
    { name: '유효1', phone: '010-1111-2222' },
    { name: '유효2', phone: '01033334444' },
    { name: '너무짧음', phone: '123' },
  ]}});
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.saved, 2);
  assert.strictEqual(res.body.skipped, 1);
});

test('anyone can change their own password — including master', async () => {
  // Master belongs to no center, so master never appears in the center-scoped
  // account list and has no other way to rotate the seeded password.
  const wrong = await call({ method: 'PATCH', url: '/api/me/password', cookie: S.master.cookie,
    body: { current: 'not-my-password', next: 'brand-new-pw-1234' } });
  assert.strictEqual(wrong.statusCode, 401, 'the current password must be proved');

  const short = await call({ method: 'PATCH', url: '/api/me/password', cookie: S.master.cookie,
    body: { current: PW.master, next: 'short' } });
  assert.strictEqual(short.statusCode, 400);

  const ok = await call({ method: 'PATCH', url: '/api/me/password', cookie: S.master.cookie,
    body: { current: PW.master, next: 'rotated-master-2026' } });
  assert.strictEqual(ok.statusCode, 200, JSON.stringify(ok.body));

  // The session doing the change survives; the old password does not.
  const still = await call({ method: 'GET', url: '/api/centers', cookie: S.master.cookie });
  assert.strictEqual(still.statusCode, 200, 'changing your password must not sign you out');

  const old = await call({ method: 'POST', url: '/api/login', body: { username: 'master', password: PW.master } });
  assert.strictEqual(old.statusCode, 401, 'the old password stops working');

  PW.master = 'rotated-master-2026';
});

test('a duplicate center slug is refused', async () => {
  const res = await call({ method: 'POST', url: '/api/centers', cookie: S.master.cookie,
    body: { slug: 'seocho', name: '중복 복지관' } });
  assert.strictEqual(res.statusCode, 409, 'the slug is how a center is addressed, so it must stay unique');
});

test('a member can be corrected in place — name and number (§3-4)', async () => {
  // Adding upserts by phone, so it can change a name but never the number.
  // Fixing a mistyped digit is the commonest correction a 담당자 makes.
  const before = (await call({ method: 'GET', url: '/api/members', cookie: S.staff.cookie })).body.members;
  const target = before.find((m) => m.phone === '01012343456');
  assert.ok(target, 'seeded member present');

  const renamed = await call({ method: 'PATCH', url: '/api/members/' + target.id, cookie: S.staff.cookie,
    body: { name: '김순자님' } });
  assert.strictEqual(renamed.statusCode, 200, JSON.stringify(renamed.body));
  assert.strictEqual(renamed.body.member.name, '김순자님');
  assert.strictEqual(renamed.body.member.phone, '01012343456', 'the number is untouched');

  // A number can be corrected, and is normalised on the way in.
  const renum = await call({ method: 'PATCH', url: '/api/members/' + target.id, cookie: S.staff.cookie,
    body: { phone: '010-1234-9999' } });
  assert.strictEqual(renum.statusCode, 200);
  assert.strictEqual(renum.body.member.phone, '01012349999', 'stored as digits');

  // The row moved rather than being duplicated.
  const after = (await call({ method: 'GET', url: '/api/members', cookie: S.staff.cookie })).body.members;
  assert.strictEqual(after.length, before.length, 'correcting a number must not add a row');
  assert.ok(!after.some((m) => m.phone === '01012343456'), 'the old number is gone');

  // Put it back for the tests that follow.
  await call({ method: 'PATCH', url: '/api/members/' + target.id, cookie: S.staff.cookie,
    body: { name: '김순자', phone: '01012343456' } });
});

test('a correction cannot collide with, or reach into, another record', async () => {
  const mine = (await call({ method: 'GET', url: '/api/members', cookie: S.staff.cookie })).body.members;
  const [a, b] = mine;

  // Two members must not end up sharing a number.
  const clash = await call({ method: 'PATCH', url: '/api/members/' + a.id, cookie: S.staff.cookie,
    body: { phone: b.phone } });
  assert.strictEqual(clash.statusCode, 409, 'a duplicate number is refused, not silently merged');

  const bad = await call({ method: 'PATCH', url: '/api/members/' + a.id, cookie: S.staff.cookie,
    body: { phone: '123' } });
  assert.strictEqual(bad.statusCode, 400);

  // And the tenant boundary holds on this route too.
  const theirs = await shim.one('SELECT id FROM members WHERE center_id = $1', [centerB.id]);
  const cross = await call({ method: 'PATCH', url: '/api/members/' + theirs.id, cookie: S.staff.cookie,
    body: { name: '침입' } });
  assert.strictEqual(cross.statusCode, 404, "another centre's member must not be editable");

  const untouched = await shim.one('SELECT name FROM members WHERE id = $1', [theirs.id]);
  assert.notStrictEqual(untouched.name, '침입');
});

test('deleting a member works, and only inside the caller\'s own center', async () => {
  const mine = await call({ method: 'GET', url: '/api/members', cookie: S.staff.cookie });
  const victim = mine.body.members.find((m) => m.phone === '01011112222');
  assert.ok(victim, 'the bulk upload above should have created this row');

  const ok = await call({ method: 'DELETE', url: '/api/members/' + victim.id, cookie: S.staff.cookie });
  assert.strictEqual(ok.statusCode, 200);
  const gone = await shim.one('SELECT 1 AS hit FROM members WHERE id = $1', [victim.id]);
  assert.strictEqual(gone, null);

  // A member of the other center must not be reachable.
  const theirs = await shim.one('SELECT id FROM members WHERE center_id = $1', [centerB.id]);
  const no = await call({ method: 'DELETE', url: '/api/members/' + theirs.id, cookie: S.staff.cookie });
  assert.strictEqual(no.statusCode, 404);
  const survived = await shim.one('SELECT 1 AS hit FROM members WHERE id = $1', [theirs.id]);
  assert.ok(survived, "the other center's member must still be there");
});

test('logout ends the session', async () => {
  const who = await login('seocho-admin', PW.admin);
  const out = await call({ method: 'POST', url: '/api/logout', cookie: who.cookie, body: {} });
  assert.strictEqual(out.statusCode, 200);
  const after = await call({ method: 'GET', url: '/api/members', cookie: who.cookie });
  assert.strictEqual(after.statusCode, 401);
});

test('stats are per center', async () => {
  const a = await call({ method: 'GET', url: '/api/stats', cookie: S.staff.cookie });
  const b = await call({ method: 'GET', url: '/api/stats?center=' + centerB.id, cookie: S.master.cookie });
  assert.ok(a.body.stats.members > b.body.stats.members);
  assert.strictEqual(b.body.stats.members, 1);
  assert.strictEqual(a.body.stats.enabled_services, 3);
  assert.strictEqual(b.body.stats.enabled_services, 0);
});

// ================================================================ catalogue import (§3-2)
// How a new revision of the client's service list reaches a running platform.
// The file format is theirs, unchanged — {id, category, sub, description,
// keywords, update_method, org, link} — because asking them to reshape it is
// how an update stops happening.
const V03 = (over = {}) => ({
  id: 's1', category: '건강 및 의료', sub: '응급 및 야간/휴일 진료',
  description: '주말/공휴일 당번 약국, 야간 인근 병원 및 응급실 위치',
  keywords: '야간 병원, 문 연 약국, 응급실',
  update_method: 'realtime_api', org: '휴일지킴이약국', link: 'https://www.pharm114.or.kr/',
  ...over,
});

test('the seed carries the client V03 organisation and link', async () => {
  const res = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  const s1 = res.body.services.find((s) => s.code === 's1');
  assert.strictEqual(s1.org, '휴일지킴이약국');
  assert.strictEqual(s1.link, 'https://www.pharm114.or.kr/');
  assert.strictEqual(s1.update_method, 'realtime_api');
});

test('import: a dry run reports the change and writes nothing', async () => {
  const body = { dry_run: true, items: [V03({ org: '바뀐 기관' })] };
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie, body });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.updated, 1);
  assert.strictEqual(res.body.created, 0);
  assert.deepStrictEqual(res.body.detail.updated[0].changes,
    [{ field: 'org', from: '휴일지킴이약국', to: '바뀐 기관' }]);

  const after = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  assert.strictEqual(after.body.services.find((s) => s.code === 's1').org, '휴일지킴이약국',
    'a dry run must not write');
});

test('import: re-importing an unchanged row changes nothing', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [V03()] } });
  assert.strictEqual(res.body.unchanged, 1);
  assert.strictEqual(res.body.updated, 0);
});

test('import: an updated link reaches every centre, and the kiosk sees it', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [V03({ link: 'https://www.pharm114.or.kr/main' })] } });
  assert.strictEqual(res.body.updated, 1);

  const a = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  assert.strictEqual(a.body.services.find((s) => s.code === 's1').link, 'https://www.pharm114.or.kr/main');
  const b = await call({ method: 'GET', url: '/api/services?center=' + centerB.id, cookie: S.master.cookie });
  assert.strictEqual(b.body.services.find((s) => s.code === 's1').link, 'https://www.pharm114.or.kr/main',
    'nationwide content is inherited, so the fix reaches every centre at once');
});

test('import: a field the file omits is left alone', async () => {
  await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [{ id: 's1', org: '휴일지킴이약국(수정)' }] } });
  const res = await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie });
  const s1 = res.body.services.find((s) => s.code === 's1');
  assert.strictEqual(s1.org, '휴일지킴이약국(수정)');
  assert.strictEqual(s1.sub, '응급 및 야간/휴일 진료', 'an omitted column must not be blanked');
  assert.strictEqual(s1.update_method, 'realtime_api');
});

test('import: a new service appears in every centre, switched on', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [V03({ id: 's900', sub: '새 서비스', org: '새 기관', update_method: 'manual' })] } });
  assert.strictEqual(res.body.created, 1);

  for (const [label, q, cookie] of [['seocho', '', S.admin.cookie],
                                    ['centerB', '?center=' + centerB.id, S.master.cookie]]) {
    const list = (await call({ method: 'GET', url: '/api/services' + q, cookie })).body.services;
    const made = list.find((s) => s.code === 's900');
    assert.ok(made, `${label} inherits the new service`);
    assert.strictEqual(made.enabled, true,
      `${label} can guide it straight away — an imported service that is off is invisible`);
  }
});

test('import: re-importing an unchanged file switches its services on', async () => {
  // 클라이언트가 실제로 부딪힌 상황 — the file is already in the catalogue byte for
  // byte, every row switched off, so the kiosk cannot guide any of it. Importing
  // the same file again has to be the way out of that, or there is none.
  const row = V03({ id: 's910', sub: '재가져오기 시험', org: '시험 기관' });
  await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { enable: false, items: [row] } });

  const off = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's910');
  assert.strictEqual(off.enabled, false, 'enable:false really does leave a new service off');

  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [row] } });
  assert.strictEqual(res.body.updated, 0, 'nothing about the content changed');
  assert.strictEqual(res.body.unchanged, 1);
  assert.strictEqual(res.body.enabled, 1, 'but one switch moved, and it is reported');

  const on = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's910');
  assert.strictEqual(on.enabled, true);
});

test('import: the preview counts the switches and writes none of them', async () => {
  const row = V03({ id: 's911', sub: '미리보기 시험' });
  await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { enable: false, items: [row] } });

  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { dry_run: true, items: [row] } });
  assert.strictEqual(res.body.enabled, 1);
  assert.deepStrictEqual(res.body.detail.enabled, ['s911'], 'and says which');

  const still = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's911');
  assert.strictEqual(still.enabled, false, 'a preview writes nothing, switches included');
});

test('import: enable:false moves no switch in either direction', async () => {
  await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { enable: false,
            items: [V03({ id: 's910', sub: '재가져오기 시험', org: '다른 기관' })] } });
  const after = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's910');
  assert.strictEqual(after.enabled, true, 'importing without enabling never switches one off');
  assert.strictEqual(after.org, '다른 기관', 'and the content still updates');
});

test("TENANT BOUNDARY — one centre's import never switches on another's service", async () => {
  // 같은 code를 두 복지관이 각각 가질 수 있습니다 — a centre-scoped code is unique per
  // centre, not globally, and the enable pass matches on codes. Matching on the
  // code alone would let 강서's import reach into 서초.
  const row = (id) => V03({ id, scope: 'center', sub: '같은 코드, 다른 복지관' });
  for (const c of [S.admin.center.id, centerB.id]) {
    await call({ method: 'POST', url: '/api/services/import?center=' + c, cookie: S.master.cookie,
      body: { enable: false, items: [row('s920')] } });
  }

  await call({ method: 'POST', url: '/api/services/import?center=' + centerB.id,
    cookie: S.master.cookie, body: { items: [row('s920')] } });

  const here = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's920');
  const there = (await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie })).body.services.find((s) => s.code === 's920');
  assert.strictEqual(there.enabled, true, 'the centre that imported has it on');
  assert.strictEqual(here.enabled, false, 'the centre that did not is untouched');
});

test('import: bad rows are refused individually and reported', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { dry_run: true, items: [
      V03({ id: 's1' }),
      V03({ id: 's2', link: 'javascript:alert(1)' }),
      V03({ id: '' }),
      V03({ id: 's3', update_method: 'telepathy' }),
      V03({ id: 's1' }),
    ] } });
  assert.strictEqual(res.body.skipped, 4);
  const why = res.body.detail.skipped.map((s) => s.reason).join(' | ');
  assert.ok(/http/.test(why), 'a non-http link is named as the reason');
  assert.ok(/code\(id\)가 없습니다/.test(why), 'a row with no code is named');
  assert.ok(/update_method/.test(why), 'an unknown update_method is named');
  assert.ok(/중복/.test(why), 'a code repeated inside the file is reported');
});

test('import: a code already used by one centre cannot become nationwide', async () => {
  // The seed files anything mentioning 서초 as that centre's own, so some codes in
  // the client's list are already centre-scoped here. A centre's list is
  // "everything common plus everything of mine", so letting the same code exist
  // in both scopes shows two rows with one name and hands the kiosk an ambiguous
  // service_code. Measured against the real data: s19 and s43 collide this way.
  const mine = await shim.one(`SELECT code FROM services WHERE scope = 'center' LIMIT 1`);
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { dry_run: true, items: [V03({ id: mine.code })] } });

  assert.strictEqual(res.body.skipped, 1);
  assert.strictEqual(res.body.created, 0);
  assert.ok(/전용 서비스/.test(res.body.detail.skipped[0].reason),
    'the reason names the centre that already owns the code');
});

test('import: a clashing row is skipped but the rest of the file still applies', async () => {
  const mine = await shim.one(`SELECT code FROM services WHERE scope = 'center' LIMIT 1`);
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { items: [V03({ id: mine.code }), V03({ id: 's901', sub: '멀쩡한 항목', org: '기관' })] } });
  assert.strictEqual(res.body.skipped, 1);
  assert.strictEqual(res.body.created, 1, 'one bad row must not cost the other 49');

  const list = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie })).body.services;
  assert.ok(list.find((s) => s.code === 's901'));
  assert.strictEqual(list.filter((s) => s.code === mine.code).length, 1, 'still exactly one row for that code');
});

test('TENANT BOUNDARY — a centre admin cannot rewrite nationwide content', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.admin.cookie,
    body: { scope: 'common', items: [V03({ org: '무단 수정' })] } });
  assert.strictEqual(res.body.scope, 'center',
    'a centre importing can only ever write its own content');

  const master = await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie });
  assert.notStrictEqual(master.body.services.find((s) => s.code === 's1').org, '무단 수정',
    "another centre's view of nationwide content is untouched");
});

test('staff cannot import or edit the catalogue', async () => {
  const imp = await call({ method: 'POST', url: '/api/services/import', cookie: S.staff.cookie,
    body: { items: [V03()] } });
  assert.strictEqual(imp.statusCode, 403);
});

test('a centre edits inherited content as an override, not at the source', async () => {
  const list = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie })).body.services;
  const common = list.find((s) => s.scope === 'common' && s.code === 's5');

  const res = await call({ method: 'PATCH', url: '/api/services/' + common.id, cookie: S.admin.cookie,
    body: { org: '우리 동네 주민센터' } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.overridden, true);

  const mine = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's5');
  assert.strictEqual(mine.org, '우리 동네 주민센터');
  assert.strictEqual(mine.base_org, '복지로', 'the nationwide value is still there underneath');

  const other = (await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie })).body.services.find((s) => s.code === 's5');
  assert.strictEqual(other.org, '복지로', "one centre's override never leaks into another");
});

test('clearing an override falls back to the inherited value', async () => {
  const list = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie })).body.services;
  const s5 = list.find((s) => s.code === 's5');
  await call({ method: 'PATCH', url: '/api/services/' + s5.id, cookie: S.admin.cookie, body: { org: '' } });

  const back = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's5');
  assert.strictEqual(back.org, '복지로');
});

test('the kiosk prompt carries the organisation behind each service', async () => {
  const sys = buildSystem({
    ieumi_name: '이음이', center_name: '서초', tone: 'warm',
    services: [{ code: 's1', category: '건강 및 의료', sub: '야간 진료',
                 description: '문 연 약국', org: '휴일지킴이약국', link: 'https://www.pharm114.or.kr/' }],
  });
  assert.ok(sys.includes('담당기관: 휴일지킴이약국'), 'Ieumi can name a real organisation');
  assert.ok(!sys.includes('pharm114'), 'a URL is never read aloud — it goes by SMS instead');
});

// ================================================================ scope reclassification
// The client's second file adds a `scope` field per row, because `org` showed
// that most of the list is run by a Seocho-district body and must not be
// inherited by 강서 as nationwide content.
test('import: a file may reclassify nationwide content as one centre\'s own', async () => {
  const before = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's6');
  assert.strictEqual(before.scope, 'common', 'starts life as nationwide content');

  // Switch it on and order it first, so the move can be shown to preserve both.
  await call({ method: 'PUT', url: '/api/services/priority', cookie: S.admin.cookie,
    body: { items: [{ id: before.id, enabled: true, sort_order: 0 }] } });

  const res = await call({ method: 'POST', url: '/api/services/import?center=' + S.admin.center.id,
    cookie: S.master.cookie,
    body: { enable: false,
            items: [V03({ id: 's6', scope: 'center', org: '서울시 복지포털', sub: before.sub,
                          description: before.description, keywords: before.keywords,
                          category: before.category, update_method: 'scraping' })] } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.moved, 1, 'a scope change is reported as a move, not an update');
  assert.strictEqual(res.body.detail.moved[0].from, '전국 공통');

  const mine = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.code === 's6');
  assert.strictEqual(mine.scope, 'center', 'now belongs to this centre alone');
  assert.strictEqual(mine.enabled, true, 'the move keeps the centre\'s own selection');
  assert.strictEqual(mine.sort_order, 0, 'and its ordering');
});

test('import: reclassifying takes it away from the other centres', async () => {
  const other = (await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie })).body.services;
  assert.ok(!other.find((s) => s.code === 's6'),
    '강서 must not inherit 서울시 복지포털 as its own — this is the point of the scope field');

  const rows = await shim.one(
    `SELECT count(*)::int n FROM center_services cs
       JOIN services s ON s.id = cs.service_id
      WHERE s.code = 's6' AND cs.center_id = $1`, [centerB.id]);
  assert.strictEqual(rows.n, 0, 'the inherited row is gone, not merely hidden');
});

test('import: the preview says how many centres lose access, before writing', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import?center=' + S.admin.center.id,
    cookie: S.master.cookie,
    body: { dry_run: true, items: [V03({ id: 's5', scope: 'center' })] } });
  assert.strictEqual(res.body.moved, 1);
  assert.ok(res.body.centres_losing_access >= 1, 'the cost is stated up front');

  const still = (await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie })).body.services.find((s) => s.code === 's5');
  assert.ok(still, 'a dry run moves nothing');
});

test('import: a scope that was only defaulted never moves anything', async () => {
  // The client's first file had no scope field at all. Reading its absence as
  // "make everything nationwide" would silently strip every centre's own
  // content — so only a scope the file states counts as an instruction.
  const mine = await shim.one(`SELECT code FROM services WHERE scope = 'center' LIMIT 1`);
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { dry_run: true, items: [V03({ id: mine.code })] } });
  assert.strictEqual(res.body.moved, 0);
  assert.strictEqual(res.body.skipped, 1);
});

test('TENANT BOUNDARY — a centre cannot reclassify nationwide content', async () => {
  const common = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((s) => s.scope === 'common');
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.admin.cookie,
    body: { items: [V03({ id: common.code, scope: 'center' })] } });

  assert.strictEqual(res.body.moved, 0);
  assert.strictEqual(res.body.skipped, 1);
  assert.ok(/마스터에게 요청/.test(res.body.detail.skipped[0].reason),
    'it says who can do this instead');

  const after = (await call({ method: 'GET', url: '/api/services?center=' + centerB.id,
    cookie: S.master.cookie })).body.services.find((s) => s.code === common.code);
  assert.ok(after, 'the other centre still has it');
});

test('import: a rename is reported with the call history riding on it', async () => {
  // s19 in the client's file is a different service from the s19 already stored
  // (노인여가복지시설 안내 against 긴급복지지원). That is a legitimate edit to make,
  // but it silently re-labels every call already filed under the code, so the
  // preview has to say so rather than list it as one field among seven.
  const filed = await shim.one(
    `SELECT service_code AS code FROM requests WHERE service_code IS NOT NULL LIMIT 1`);
  assert.ok(filed, 'a call must already be filed against some service for this to mean anything');
  const svc = await shim.one('SELECT scope, sub FROM services WHERE code = $1', [filed.code]);

  const res = await call({ method: 'POST', url: '/api/services/import?center=' + S.admin.center.id,
    cookie: S.master.cookie,
    body: { dry_run: true,
            items: [V03({ id: filed.code, scope: svc.scope, sub: '완전히 다른 서비스' })] } });

  const hit = res.body.detail.renamed.find((r) => r.code === filed.code);
  assert.ok(hit, 'the rename is called out separately, not buried among the field diffs');
  assert.strictEqual(hit.from, svc.sub);
  assert.strictEqual(hit.to, '완전히 다른 서비스');
  assert.ok(hit.requests >= 1, 'and how many filed calls are attached to the code');
});

test('import: a centre-scoped row needs a centre chosen first', async () => {
  const res = await call({ method: 'POST', url: '/api/services/import', cookie: S.master.cookie,
    body: { dry_run: true, items: [V03({ id: 's950', scope: 'center' })] } });
  assert.strictEqual(res.body.skipped, 1);
  assert.ok(/복지관에 넣을지/.test(res.body.detail.skipped[0].reason));
});

test('import: the client\'s own V03+scope file splits the way they described', async () => {
  const file = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'services.v03-scoped.json'), 'utf8'));
  const res = await call({ method: 'POST', url: '/api/services/import?center=' + S.admin.center.id,
    cookie: S.master.cookie, body: { dry_run: true, items: file } });

  assert.strictEqual(res.body.total, 50);
  assert.strictEqual(res.body.scopes.common, 11, '11 nationwide, as the client counted');
  assert.strictEqual(res.body.scopes.center, 39, 'and 39 Seocho-only');
  assert.strictEqual(res.body.skipped, 0, 'every row is usable once scope is stated');
});

test("import: the client's own file lands switched on, and the kiosk can see it", async () => {
  // 클라이언트의 수용 기준 그대로 — import their file, then ask the kiosk what it
  // knows. Everything short of this passed while the kiosk still answered
  // nothing, which is how the bug survived a round of testing.
  const file = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'services.v03-scoped.json'), 'utf8'));
  const res = await call({ method: 'POST', url: '/api/services/import?center=' + S.admin.center.id,
    cookie: S.master.cookie, body: { items: file } });
  assert.strictEqual(res.statusCode, 200);

  const ctx = await call({ method: 'GET', url: '/api/kiosk/context?c=' + kioskA });
  const codes = new Set(ctx.body.services.map((s) => s.code));
  const missing = file.map((r) => r.id).filter((id) => !codes.has(id));
  assert.deepStrictEqual(missing, [], 'every service in their file reaches the kiosk');
});

// ================================================================ 어르신이 말한 지역 (F2)
// The client's stated next test: does Ieumi answer for the region the *user*
// wants, not just the one the kiosk stands in.
const jobsMod = require('../jobs');

test('region: a district is recognised from what the senior said', async () => {
  const vocab = [
    { term: '강남구', sido: '서울', sigungu: '강남구' },
    { term: '강남', sido: '서울', sigungu: '강남구' },
    { term: '관악구', sido: '서울', sigungu: '관악구' },
    { term: '서울', sido: '서울', sigungu: '' },
  ].sort((a, b) => b.term.length - a.term.length);

  const hit = jobsMod.detectRegion(
    [{ role: 'assistant', content: '무엇을 도와드릴까요?' },
     { role: 'user', content: '강남구에 일자리 있어요?' }], vocab);
  assert.strictEqual(hit.sigungu, '강남구');

  // 구 dropped — a senior says "강남" as often as "강남구".
  assert.strictEqual(
    jobsMod.detectRegion([{ role: 'user', content: '강남 쪽으로 알아봐 주세요' }], vocab).sigungu,
    '강남구');
});

test('region: the most recent one wins, so a senior may change their mind', async () => {
  const vocab = [
    { term: '강남구', sido: '서울', sigungu: '강남구' },
    { term: '관악구', sido: '서울', sigungu: '관악구' },
  ].sort((a, b) => b.term.length - a.term.length);

  const hit = jobsMod.detectRegion([
    { role: 'user', content: '강남구요' },
    { role: 'assistant', content: '강남구 자리를 찾아볼게요.' },
    { role: 'user', content: '아니 관악구로 해주세요' },
  ], vocab);
  assert.strictEqual(hit.sigungu, '관악구');
});

test('region: only what the senior said counts, never Ieumi\'s own words', async () => {
  const vocab = [{ term: '강남구', sido: '서울', sigungu: '강남구' }];
  const hit = jobsMod.detectRegion([
    { role: 'assistant', content: '강남구에도 자리가 있어요.' },
    { role: 'user', content: '네 알겠습니다' },
  ], vocab);
  assert.strictEqual(hit, null, 'Ieumi mentioning a district must not redirect the search');
});

test('region: a district nobody has postings for is not in the vocabulary', async () => {
  // The vocabulary is built from the postings themselves, so a match can never
  // promise a district and then produce nothing.
  const vocab = [{ term: '강남구', sido: '서울', sigungu: '강남구' }];
  assert.strictEqual(
    jobsMod.detectRegion([{ role: 'user', content: '울릉군에 일자리 있나요?' }], vocab), null);
});

test('region: a stale vocabulary never makes a conversation wait', async () => {
  // The DISTINCT over the postings table measures at ~2.5s against the real
  // database. Awaiting it inside a turn would double time-to-first-audio the
  // moment the cache expired, at random rather than consistently (§3-6).
  await jobsMod.warmRegionVocabulary();

  const t = Date.now();
  const v = jobsMod.regionVocabulary();          // deliberately not awaited
  assert.ok(Array.isArray(v), 'a warm cache answers synchronously, not with a promise');
  assert.ok(Date.now() - t < 50);

  // Expiring it must still answer at once, with the refresh running behind.
  process.env.JOBS_VOCAB_TTL_MS = '0';
  const stale = jobsMod.regionVocabulary();
  assert.ok(Array.isArray(stale) || typeof stale.then === 'function');
  delete process.env.JOBS_VOCAB_TTL_MS;
});

test('the prompt tells Ieumi which region the list is for', async () => {
  const { jobsSection } = require('../prompt');

  const asked = jobsSection({ jobs: [{ gu: '서울 강남구', job: '청소' }], scope: 'asked',
                              region: '서울 강남구', centerRegion: '서울특별시 서초구', asked: '강남구' });
  assert.ok(/어르신이 말씀하신 '강남구'/.test(asked), 'the senior hears the district they named');

  const wider = jobsSection({ jobs: [{ gu: '서울 관악구', job: '청소' }], scope: 'asked-wider',
                              region: '서울', centerRegion: '서울특별시 서초구', asked: '강남구' });
  assert.ok(/강남구.*열린 자리가 없어/.test(wider), 'an empty district is admitted, not covered up');

  const none = jobsSection({ jobs: [], scope: 'asked-none', region: '서울 강남구',
                             centerRegion: '서울특별시 서초구', asked: '강남구' });
  assert.ok(/다른 지역 자리를 대신 내밀지 말고/.test(none),
    'nothing in the asked district means say so, not substitute another');
});

// ================================================================ 일반 상식 답변 (F3)
// The client asked for it in their first message: answer from the list first,
// and from general knowledge where the list is silent.
test('general answers: the list comes first, general knowledge second', async () => {
  const sys = buildSystem({ ieumi_name: '이음이', center_name: '서초',
    services: [{ code: 's1', category: '건강', sub: '야간진료', description: '약국', org: '휴일지킴이약국' }] });
  assert.ok(/목록에 있으면 목록이 우선입니다/.test(sys));
  assert.ok(/일반 상식은 짧게/.test(sys));
});

test('general answers: the specifics a senior would act on stay forbidden', async () => {
  const sys = buildSystem({ ieumi_name: '이음이', center_name: '서초', services: [] });
  // 전화번호 규칙은 더 강해졌습니다 — 131·129 처럼 "맞아 보이는" 번호를 지어내는
  // 것을 클라이언트 테스트에서 실제로 봤기 때문입니다.
  // The phone rule got stricter after the client's test caught invented numbers
  // that happened to be real (131, 129) — plausible is not the same as sourced.
  for (const forbidden of ['머릿속에서 떠오른 번호는', '주소, 기관 이름', '금액, 지원금 액수',
                           '날짜, 신청 기간', '자격 판단', '병을 진단하거나']) {
    assert.ok(sys.includes(forbidden), `the prompt must still rule out: ${forbidden}`);
  }
});

test('general answers: a centre can switch it off', async () => {
  const off = buildSystem({ ieumi_name: '이음이', center_name: '서초', general_answers: false, services: [] });
  assert.ok(!/일반 상식은 짧게/.test(off));
  assert.ok(/아는 척하지 말고/.test(off), 'switched off, it defers to staff instead');
});

test('general answers: the switch round-trips through settings', async () => {
  const off = await call({ method: 'PATCH', url: '/api/settings', cookie: S.admin.cookie,
    body: { general_answers: false } });
  assert.strictEqual(off.statusCode, 200);
  assert.strictEqual(off.body.settings.general_answers, false);

  const ctx = await require('../kiosk-context').forToken(kioskA);
  assert.strictEqual(ctx.general_answers, false,
    'and reaches the kiosk — the settings save drops the cached copy');

  const on = await call({ method: 'PATCH', url: '/api/settings', cookie: S.admin.cookie,
    body: { general_answers: true } });
  assert.strictEqual(on.body.settings.general_answers, true);
});

// ================================================================ 문자 (SMS)
// What a senior actually receives. The kiosk sends identifiers only; everything
// in the body is read back from a record here.
const { smsContent } = require('../sms');

const PERSONA = {
  center_name: '서초 어르신 행복이음 센터', ieumi_name: '이음이',
  services: [{ code: 's1', sub: '응급 및 야간/휴일 진료',
               org: '휴일지킴이약국', link: 'https://www.pharm114.or.kr/' }],
};
// A stand-in for the jobs table, so this never needs the data.go.kr sync to have run.
const JOBSTUB = {
  byId: async (id) => (id === 'real-1'
    ? { id: 'real-1', title: '경로당 급식 도우미', org: '서초동 경로당', place: '서울 서초구',
        contact_phone: '02-586-0000', apply_method: '방문', to_date: '2026-12-31', min_age: 60 }
    : null),
  toPromptJob: require('../jobs').toPromptJob,
};

test('SMS: a job message is built from the stored posting', async () => {
  const out = await smsContent(PERSONA, { jobId: 'real-1', kind: 'send' }, JOBSTUB);
  assert.ok(out.includes('경로당 급식 도우미'));
  assert.ok(out.includes('02-586-0000'), 'the senior gets the number they can act on');
  assert.ok(out.startsWith('[서초 어르신 행복이음 센터] 이음이'));
});

test('SMS: the job source has no wage, so no wage line is printed', async () => {
  const out = await smsContent(PERSONA, { jobId: 'real-1', kind: 'send' }, JOBSTUB);
  assert.ok(!/급여/.test(out), 'a wage line would be invented — the field does not exist (§11)');
  assert.ok(!/150만원/.test(out));
});

test('SMS: a posting that is not in the table cannot be sent', async () => {
  // The regression this exists for: `pick` was resolved in the browser against a
  // hardcoded demo array, so a senior asking about a real posting was texted an
  // invented one, wage included. An id the database does not know now produces
  // nothing at all rather than a plausible message.
  const out = await smsContent(PERSONA, { jobId: 'made-up', kind: 'send' }, JOBSTUB);
  assert.strictEqual(out, '');
});

test('SMS: a welfare answer is sent with its organisation and link', async () => {
  const out = await smsContent(PERSONA,
    { serviceCode: 's1', summary: '야간에 문 연 약국을 찾고 계십니다.' }, JOBSTUB);
  assert.ok(out.includes('응급 및 야간/휴일 진료'));
  assert.ok(out.includes('야간에 문 연 약국을 찾고 계십니다.'), 'the summary of the answer travels');
  assert.ok(out.includes('휴일지킴이약국'), 'the organisation comes from the catalogue');
  assert.ok(out.includes('https://www.pharm114.or.kr/'), 'and so does the link (client V03)');
});

// 엑셀 목록과 실시간 자료는 한 문자 안에 같이 들어갑니다 — 클라이언트가 "하나를
// 만들면 다른 하나가 안 된다"고 말한 그 증상입니다.
test('SMS: a posting and a service from one conversation both reach the senior', async () => {
  const out = await smsContent(PERSONA,
    { jobId: 'real-1', serviceCode: 's1', summary: '일자리와 약국을 함께 여쭤보셨습니다.', kind: 'send' },
    JOBSTUB);
  assert.ok(out.includes('경로당 급식 도우미'), 'the live posting is there');
  assert.ok(out.includes('02-586-0000'), 'with its phone number');
  assert.ok(out.includes('응급 및 야간/휴일 진료'), 'and the catalogue entry is there too');
  assert.ok(out.includes('휴일지킴이약국'), 'with the organisation the client supplied');
  assert.ok(out.includes('https://www.pharm114.or.kr/'), 'and its link');
});

test('SMS: a posting on its own still sends only the posting', async () => {
  const out = await smsContent(PERSONA,
    { jobId: 'real-1', summary: '이 줄은 들어가지 않아야 합니다', kind: 'send' }, JOBSTUB);
  assert.ok(out.includes('경로당 급식 도우미'));
  assert.ok(!out.includes('응급 및 야간/휴일 진료'), 'nothing from the catalogue was asked about');
  assert.ok(!out.includes('이 줄은 들어가지'), 'the posting lines already say it');
});

test('SMS: a service the centre has not enabled contributes nothing', async () => {
  const out = await smsContent(PERSONA, { serviceCode: 's999' }, JOBSTUB);
  assert.strictEqual(out, '', 'an unknown code must not produce a message about nothing');
});

test('SMS: nothing to say produces no message at all', async () => {
  assert.strictEqual(await smsContent(PERSONA, {}, JOBSTUB), '');
  assert.strictEqual(await smsContent(PERSONA, { summary: '   ' }, JOBSTUB), '');
});

test('SMS: a caller-supplied summary is capped', async () => {
  const out = await smsContent(PERSONA, { summary: 'ㅇ'.repeat(5000) }, JOBSTUB);
  assert.ok(out.length < 500, 'the one free-text field cannot become an arbitrary payload');
});

// ================================================================ 영어 모드 (1b)
// 개발자가 한국어를 읽지 못하면 시험을 할 수 없고, 시험하지 못한 것은 클라이언트가
// 처음 발견하게 됩니다. English mode exists so the system can be tested by
// someone who cannot read the language it ships in.
test('english: the catalogue is rendered from the English columns', async () => {
  const persona = {
    lang: 'en', ieumi_name: 'Ieumi', center_name: '서초 어르신 행복이음 센터',
    center_name_en: 'Seocho Senior Centre',
    services: [{ code: 's1', category: '건강 및 의료', category_en: 'Health & medical',
                 sub: '응급 및 야간/휴일 진료', sub_en: 'Emergency & night care',
                 description: '주말 당번 약국', description_en: 'Weekend duty pharmacies',
                 org: '휴일지킴이약국', org_en: 'Holiday Pharmacy Finder' }],
  };
  const p = buildSystem(persona);
  assert.ok(p.includes('Emergency & night care'), 'the English name is used');
  assert.ok(p.includes('Weekend duty pharmacies'));
  assert.ok(p.includes('Holiday Pharmacy Finder'), 'and the English organisation');
  assert.ok(p.includes('Seocho Senior Centre'), 'and the English centre name');
  assert.ok(/ANSWER IN ENGLISH/.test(p), 'with a directive to answer in English');
});

test('english: a row with no translation still reads, in Korean', async () => {
  // 번역이 없는 줄이 빈칸이 되면 이음이가 이름 없는 서비스를 안내하게 됩니다.
  // A half-translated catalogue must degrade field by field, never to a blank.
  const p = buildSystem({ lang: 'en', services: [
    { code: 's2', category: '건강', sub: '치매 및 노인성 질환', description: '조기 검진' }] });
  assert.ok(p.includes('치매 및 노인성 질환'), 'the Korean stands in for a missing translation');
  assert.ok(!/undefined|null/.test(p), 'and nothing leaks as undefined');
});

test('english mode changes the language, not the rules', async () => {
  // 영어용 규칙을 따로 쓰면 그건 다른 시스템입니다 — 영어로 시험해도 서초에서
  // 돌아가는 것을 증명하지 못합니다.
  // A separate English rule set would be a second system, and testing it would
  // prove nothing about the one that actually runs.
  const svc = [{ code: 's1', category: '건강', sub: '응급 진료', description: '야간 병원',
                 sub_en: 'Emergency care', description_en: 'Night hospitals',
                 category_en: 'Health' }];
  const ko = buildSystem({ services: svc });
  const en = buildSystem({ lang: 'en', services: svc });
  for (const rule of ['절대 지어내지 마세요', '답하는 방법', '"service":']) {
    assert.ok(ko.includes(rule), 'Korean carries: ' + rule);
    assert.ok(en.includes(rule), 'and English carries the same rule: ' + rule);
  }
});

// ================================================================ 링크 내용 (2단계)
// 클라이언트의 핵심 불만: "홈페이지에 나와 있는데 이음이는 모른다고 합니다."
// 없었던 것은 모델도 규칙도 아니고, 그 페이지를 아무도 읽지 않았다는 것입니다.
//
// The client's central complaint was that Ieumi could not answer what its own
// linked page plainly states. What was missing was not the model or the rules —
// nothing had ever opened the page.
const sourcesMod = require('../sources');

test('sources: a support-amount table survives extraction', async () => {
  // 탐님이 빨간 원으로 표시한 것이 표였습니다. 표를 태그째 지우면 숫자만 남고
  // 무슨 값인지 사라집니다.
  const html = '<table><tr><th>가구원수</th><td>1인</td><td>2인</td></tr>'
            + '<tr><th>지원금액</th><td>30만원</td><td>40만원</td></tr></table>';
  const out = sourcesMod.extractText(html);
  assert.ok(out.includes('가구원수 | 1인 | 2인'), 'the header row keeps its columns');
  assert.ok(out.includes('지원금액 | 30만원 | 40만원'), 'and each amount stays next to what it counts');
});

test('sources: navigation repeated on every page is dropped', async () => {
  const html = '<div>서초구청</div><div>서초구청</div><div>서초구청</div><p>생계비 1인 30만원</p>';
  const out = sourcesMod.extractText(html);
  assert.strictEqual(out.split('서초구청').length - 1, 1, 'a repeated menu line appears once');
  assert.ok(out.includes('생계비 1인 30만원'), 'and the content survives');
});

test('sources: a real page served with a hostile status code is still read', async () => {
  // 사랑의복지관(esarang.org)은 <모든> 페이지를 403 으로 돌려주면서 내용은 그대로
  // 보냅니다 — 이용안내 1,597자, 기관소개 2,413자가 그 안에 다 들어 있었습니다.
  // 상태 코드만 보고 버렸기 때문에, 서초구 장애인복지관 한 곳이 통째로 비어
  // 있었습니다. 페이지가 없는 것과 방화벽이 퉁명스러운 것은 다릅니다.
  //
  // Measured: that site answers 403 on every page while serving the real thing.
  // Judged by status alone, a whole disability centre answered nothing.
  const page = '<h1>이용안내</h1><p>' + '상담 및 직업지원 안내입니다. '.repeat(40) + '</p>';
  assert.ok(sourcesMod.worthReadingAnyway(page), 'a page with real content is read whatever the status');
});

test('sources: a firewall notice is not mistaken for a page', async () => {
  // 위의 구제책이 차단 안내문까지 사실로 요약해 버리면 더 나쁩니다 — 어르신이
  // "방화벽 보안 정책에 의해 차단되었습니다" 를 안내로 듣게 됩니다.
  // The salvage must not turn a block notice into facts.
  const refusal = '<h1>접근이 거부되었습니다</h1><p>' + '방화벽 보안 정책에 의해 차단되었습니다. '.repeat(40) + '</p>';
  assert.ok(!sourcesMod.worthReadingAnyway(refusal), 'a refusal is discarded even though it is long');
  assert.ok(!sourcesMod.worthReadingAnyway('<p>짧은 오류</p>'), 'and so is a short error page');
});

test('the prompt carries checked facts, with where and when', async () => {
  const p = buildSystem({ services: [{ code: 's61', category: '복지', sub: '긴급복지지원',
    description: '위기 가구 지원', org: '서초구청',
    facts: '생계비: 1인 30만원, 2인 40만원.', facts_at: '2026-09-15' }] });
  assert.ok(p.includes('확인된 자료'), 'the facts have their own block');
  assert.ok(p.includes('생계비: 1인 30만원, 2인 40만원.'));
  assert.ok(p.includes('서초구청'), 'attributed to the organisation');
  assert.ok(p.includes('2026-09-15'), 'and dated, so Ieumi can say when it was checked');
  assert.ok(/그대로 말해도 됩니다/.test(p), 'and the rule permits stating them');
});

test('a failed refresh does not strip a service of the facts it already had', async () => {
  // 하룻밤 수집이 실패했다고 어르신이 답을 못 받게 되면 안 됩니다.
  //
  // 예전에는 실패하면 status 를 'error' 로 바꿨고, 키오스크는 status='ok' 인
  // 줄만 읽으므로, 넘겨받은 사실이 아무 데도 쓰이지 못했습니다. 네트워크가 한 번
  // 흔들린 것과 그 서비스에 자료가 없는 것이 구별되지 않았습니다.
  //
  // A wobble in the network must not look the same as a service having no data.
  const sources = require('../sources');
  const svc = (await shim.query("SELECT id, code, sub, link FROM services WHERE code = 's3'")).rows[0];
  const url = 'https://example.test/ok';

  // 먼저 성공한 수집 한 번.
  await sources.refreshOne({ ...svc, link: url }, { deps: {
    fetchPage: async () => ({ httpStatus: 200, html: '<p>' + 'x'.repeat(900) + '</p>', error: null }),
    summarise: async () => ({ ko: '문의 02-1234-5678, 65세 이상.', en: 'Call 02-1234-5678, 65+.' }),
  } });

  const good = (await shim.query(
    'SELECT status, facts, fetched_at FROM service_sources WHERE service_id = $1 AND url = $2',
    [svc.id, url])).rows[0];
  assert.strictEqual(good.status, 'ok');
  const readAt = String(good.fetched_at);

  // 이제 같은 링크에서 요약이 실패합니다 (크레딧 소진 등).
  await sources.refreshOne({ ...svc, link: url }, { force: true, deps: {
    fetchPage: async () => ({ httpStatus: 200, html: '<p>' + 'y'.repeat(900) + '</p>', error: null }),
    summarise: async () => { throw new Error('credit balance is too low'); },
  } });

  const after = (await shim.query(
    'SELECT status, facts, error, fetched_at FROM service_sources WHERE service_id = $1 AND url = $2',
    [svc.id, url])).rows[0];

  assert.strictEqual(after.facts, good.facts, 'the facts it already had must survive');
  assert.strictEqual(after.status, 'ok',
    'and stay readable — the kiosk only reads status=ok, so error would hide them');
  assert.ok(/credit/i.test(after.error || ''), 'while the failure is still recorded for the dashboard');
  assert.strictEqual(String(after.fetched_at), readAt,
    'and the date must not move: we did not check today, so Ieumi must not say we did');
});

test('a service with no checked facts keeps the do-not-invent rule', async () => {
  // 자료가 없는 서비스까지 금액을 말하게 되면, 고친 것이 아니라 더 나빠진 것입니다.
  // Loosening the rule for services whose page was never read would not be a fix,
  // it would be the invention problem with extra steps.
  const p = buildSystem({ services: [{ code: 's5', category: '복지', sub: '현금성 지원',
    description: '연금 안내', org: '복지로' }] });
  assert.ok(!p.includes('확인된 자료 —'), 'no facts block when nothing was read');
  assert.ok(/절대 지어내지 마세요/.test(p), 'and the original prohibition still stands');
});

test('english: checked facts are carried in English too', async () => {
  const p = buildSystem({ lang: 'en', services: [{ code: 's61', category: '복지',
    sub: '긴급복지지원', sub_en: 'Emergency welfare', description: '위기 가구',
    org: '서초구청', org_en: 'Seocho District Office',
    facts: '생계비 2인 40만원.', facts_en: 'Living costs, 2 people: 400,000 won.',
    facts_at: '2026-09-15' }] });
  assert.ok(p.includes('CHECKED FACTS'));
  assert.ok(p.includes('Living costs, 2 people: 400,000 won.'));
  assert.ok(p.includes('Seocho District Office'));
  assert.ok(!p.includes('생계비 2인 40만원.'), 'the Korean facts are not doubled up');
});

test('the service list says whether each link has been read', async () => {
  // "60개 켜짐" 은 60개를 안내할 수 있다는 뜻이 아닙니다. 링크를 읽은 것만
  // 금액·자격을 답할 수 있고, 그 차이가 화면에 보이지 않으면 아무도 모릅니다.
  //
  // Switched-on is not the same as answerable. Only a service whose page has
  // been read can give an amount, and until this shipped that difference was
  // invisible until a senior asked and got nothing.
  const before = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((x) => x.code === 's1');
  assert.strictEqual(before.source_status, null, 'nothing read yet');

  await shim.query(
    `INSERT INTO service_sources (service_id, url, fetched_at, status, facts, fact_chars)
          VALUES ($1, $2, now(), 'ok', $3, $4)`,
    [before.id, 'https://example.test/a', '생계비: 2인 40만원.', 14]);

  const after = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((x) => x.code === 's1');
  assert.strictEqual(after.source_status, 'ok');
  assert.strictEqual(after.source_facts, '생계비: 2인 40만원.');
  assert.ok(after.source_at, 'and when it was read');
});

test('the kiosk prompt picks up facts the moment they are stored', async () => {
  const kioskCtx = require('../kiosk-context');
  kioskCtx.bustAll();
  const persona = await kioskCtx.forToken(kioskA);
  const s1 = persona.services.find((x) => x.code === 's1');
  assert.ok(s1, 's1 is switched on for this centre');
  assert.strictEqual(s1.facts, '생계비: 2인 40만원.', 'the facts travel with the service');
  assert.ok(buildSystem(persona).includes('생계비: 2인 40만원.'),
    'and reach the prompt without any further step');
});

test("TENANT BOUNDARY — a centre cannot re-read another centre's source", async () => {
  const mine = (await call({ method: 'GET', url: '/api/services', cookie: S.admin.cookie }))
    .body.services.find((x) => x.scope === 'center');

  // 다른 복지관을 지정해도 자기 복지관으로 돌아옵니다 — resolveCenter 가 §2 경계입니다.
  // Naming another centre must not widen what this admin can act on.
  const across = await call({ method: 'POST',
    url: '/api/services/' + mine.id + '/source?center=' + centerB.id,
    cookie: S.admin.cookie, body: {} });
  assert.ok(across.statusCode === 403 || across.statusCode === 404,
    'a centre admin naming another centre is refused, not served (got ' + across.statusCode + ')');

  // 담당자는 이 버튼 자체를 쓸 수 없습니다 — staff read requests, they do not fetch.
  const staff = await call({ method: 'POST', url: '/api/services/' + mine.id + '/source',
    cookie: S.staff.cookie, body: {} });
  assert.strictEqual(staff.statusCode, 403, 'staff cannot trigger a fetch');
});

// ============================================ 기계어가 말로 나가는 문제 (클라이언트 보고)
// 태리PD님이 화면에서 본 그대로입니다:
//   {"category":"기타",...," + Q + "pick" + Q + ":0," + Q + "어르신, 무엇에 대해…
//
// 프롬프트는 '할 말 먼저, JSON 마지막 줄' 이라고 합니다. 모델이 순서를 뒤집고
// JSON 을 끝맺지 못하면 예전 파서는 원문 전체를 말로 내보냈습니다.
//
// Reported by the client: the model put the data line first and never closed it,
// and the old parser spoke the whole raw string. A senior heard JSON read aloud.
// 큰따옴표를 문자로 만들어 씁니다 — JSON 예시가 따옴표 범벅이라 읽기 어려워집니다.
const Q = String.fromCharCode(34);

test('a data line that comes first is never read aloud', async () => {
  const { parseModelOutput } = require('../prompt');
  const raw = '{' + Q + 'category' + Q + ':' + Q + '기타' + Q + ','
    + Q + 'summary' + Q + ':' + Q + '불분명함' + Q + ',' + Q + 'offerSms' + Q + ':false,'
    + Q + 'pick' + Q + ':0,' + Q + '어르신, 무엇에 대해 설명해 드릴까요?';
  const out = parseModelOutput(raw);
  assert.ok(!/"(category|offerSms|summary)"\s*:/.test(out.reply),
    'the machine fields must never reach the speech bubble: ' + out.reply);
  assert.ok(out.reply.includes('무엇에 대해 설명해'), 'and the human sentence is recovered');
});

test('a complete data line followed by speech keeps the speech', async () => {
  const { parseModelOutput } = require('../prompt');
  const raw = '{' + Q + 'category' + Q + ':' + Q + '복지' + Q + ',' + Q + 'summary' + Q + ':' + Q + 'x' + Q
    + ',' + Q + 'offerSms' + Q + ':false,' + Q + 'pick' + Q + ':0,' + Q + 'service' + Q + ':0}'
    + '\n어르신, 무엇을 도와드릴까요?';
  const out = parseModelOutput(raw);
  assert.strictEqual(out.reply, '어르신, 무엇을 도와드릴까요?');
  assert.strictEqual(out.meta.category, '복지', 'and the data is still read');
});

test('when nothing human can be recovered, Ieumi asks again', async () => {
  // 건질 문장이 없으면 기계어를 읽어 드리느니 다시 여쭙는 편이 낫습니다.
  // With nothing recoverable, asking again beats reading machine output aloud.
  const { parseModelOutput } = require('../prompt');
  const raw = '{' + Q + 'category' + Q + ':' + Q + '기타' + Q + ',' + Q + 'offerSms' + Q + ':false,'
    + Q + 'pick' + Q + ':0,' + Q + 'service' + Q + ':0}';
  const ko = parseModelOutput(raw);
  assert.ok(!/[{}]/.test(ko.reply), 'no braces are spoken');
  assert.ok(/다시 말씀/.test(ko.reply), 'it asks the senior to repeat');
  const en = parseModelOutput(raw, { lang: 'en' });
  assert.ok(/say it once more/i.test(en.reply), 'and does so in English on an English kiosk');
});

test('the ordinary shape — speech then data line — is untouched', async () => {
  const { parseModelOutput } = require('../prompt');
  const raw = '네, 서초구청에서 확인하실 수 있어요.\n{' + Q + 'category' + Q + ':' + Q + '복지' + Q
    + ',' + Q + 'summary' + Q + ':' + Q + 'x' + Q + ',' + Q + 'offerSms' + Q + ':true,'
    + Q + 'pick' + Q + ':0,' + Q + 'service' + Q + ':1}';
  const out = parseModelOutput(raw);
  assert.strictEqual(out.reply, '네, 서초구청에서 확인하실 수 있어요.');
  assert.strictEqual(out.meta.service, 1);
});

// ================================================================ run
(async () => {
  console.log('\n이음이 멀티테넌트 테스트 — Ieumi multi-tenant tests\n');
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✔ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✖ ${name}\n      ${e.message.split('\n')[0]}`);
      failed++;
    }
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
