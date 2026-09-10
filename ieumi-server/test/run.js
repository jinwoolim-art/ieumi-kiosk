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
  assert.strictEqual(common.n + local.n, 59, 'all 59 services should be seeded');
  assert.strictEqual(local.n, 7, 'the 7 Seocho-specific services should be center-scoped');

  const members = await shim.one('SELECT count(*)::int n FROM members');
  assert.strictEqual(members.n, 6);
  const reqs = await shim.one('SELECT count(*)::int n FROM requests');
  assert.strictEqual(reqs.n, 7);

  // Re-running must not duplicate anything.
  await seed(shim);
  const after = await shim.one(`SELECT count(*)::int n FROM services`);
  assert.strictEqual(after.n, 59, 'seed should be idempotent');
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
  assert.strictEqual(inherited.n, 52, 'the new center inherits the 52 common services');

  // …and must NOT see Seocho's own 7.
  const visible = await shim.one(
    `SELECT count(*)::int n FROM services s
      WHERE s.active AND (s.scope = 'common' OR s.center_id = $1)`, [centerB.id]);
  assert.strictEqual(visible.n, 52, "a center must not see another center's own services");
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
  assert.strictEqual(list.body.services.length, 59, 'Seocho sees 52 common + its own 7');

  const items = list.body.services.map((s, i) => ({ id: s.id, enabled: i < 3, sort_order: 58 - i }));
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
