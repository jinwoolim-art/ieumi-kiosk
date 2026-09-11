// REST API for the dashboards and the kiosk.
//
// Everything here is same-origin only (no CORS headers) and cookie-authenticated.
// Tenant isolation runs through auth.requireCenter/resolveCenter — a handler must
// never take a center_id straight from the request body.
const db = require('./db');
const auth = require('./auth');
const kioskCache = require('./kiosk-context');
const { HttpError } = auth;

const norm = (p) => String(p || '').replace(/\D/g, '');
const str = (v, max = 500) => String(v ?? '').slice(0, max);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const send = (res, code, obj) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
};

function readJson(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, '자료가 너무 큽니다.'));   // payload too large
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '잘못된 요청 형식입니다.'));  // malformed body
      }
    });
    req.on('error', reject);
  });
}

// Cross-site form posts cannot set this header, and SameSite=Lax already keeps
// the cookie off cross-site requests — together that covers CSRF for mutations.
function requireJsonRequest(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) throw new HttpError(415, 'JSON 요청만 허용됩니다.');
}

// ============================================================ auth routes
// 로그인 무차별 대입 방지 — Brute-force guard for the login route.
// In memory and therefore per-instance: enough for a single deployment, but if
// this ever runs on more than one instance the counter has to move to the
// database or a shared cache to mean anything.
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();

function loginKey(req, username) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
  return `${ip}|${String(username).toLowerCase()}`;
}

function loginBlocked(key) {
  const rec = loginFailures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFailures.delete(key); return false; }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function noteLoginFailure(key) {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) loginFailures.set(key, { count: 1, first: now });
  else rec.count++;

  if (loginFailures.size > 5000) {          // bound the map; drop what has aged out
    for (const [k, v] of loginFailures) if (now - v.first > LOGIN_WINDOW_MS) loginFailures.delete(k);
  }
}

async function login(req, res) {
  requireJsonRequest(req);
  const { username, password } = await readJson(req);
  const key = loginKey(req, username);
  if (loginBlocked(key)) {
    throw new HttpError(429, '로그인 시도가 너무 많습니다. 15분 후에 다시 시도해 주세요.');
  }

  const user = await db.one(
    'SELECT id, username, password_hash, role, center_id, name, active FROM users WHERE username = $1',
    [str(username, 120)],
  );

  // Same message and roughly the same work either way, so a wrong username and a
  // wrong password are not distinguishable.
  const ok = user && user.active && auth.verifyPassword(password, user.password_hash);
  if (!ok) {
    if (!user) auth.verifyPassword(password, 'scrypt$00$00');   // keep timing similar
    noteLoginFailure(key);
    throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  loginFailures.delete(key);

  const { token, expires } = await auth.createSession(user.id, req.headers['user-agent'] || '');
  auth.purgeExpiredSessions();
  res.setHeader('set-cookie', auth.sessionCookie(req, token, expires));

  const center = user.center_id
    ? await db.one('SELECT id, slug, name FROM centers WHERE id = $1', [user.center_id])
    : null;
  return send(res, 200, {
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
    center,
  });
}

async function logout(req, res) {
  await auth.destroySession(auth.readCookie(req, auth.COOKIE));
  res.setHeader('set-cookie', auth.clearCookie());
  return send(res, 200, { ok: true });
}

async function me(req, res, user) {
  if (!user) return send(res, 200, { user: null });
  const center = user.center_id
    ? await db.one('SELECT id, slug, name FROM centers WHERE id = $1', [user.center_id])
    : null;
  return send(res, 200, {
    user: { id: user.id, username: user.username, name: user.name, role: user.role },
    center,
  });
}

// 내 비밀번호 변경 — change your own password.
// Every role needs this, and master especially: the account list is scoped to a
// center, and master belongs to none, so master never appears in it and could
// otherwise never rotate the password it was seeded with.
async function changeOwnPassword(req, res, user) {
  auth.requireUser(user);
  requireJsonRequest(req);
  const { current, next } = await readJson(req);

  const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  if (!row || !auth.verifyPassword(current, row.password_hash)) {
    throw new HttpError(401, '현재 비밀번호가 올바르지 않습니다.');
  }
  if (String(next || '').length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
  if (current === next) throw new HttpError(400, '현재 비밀번호와 다른 비밀번호를 입력해 주세요.');

  await db.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2',
    [auth.hashPassword(next), user.id]);

  // Sign out everywhere else, but keep this session — changing your password
  // should not log you out of the page you are standing on.
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2',
    [user.id, require('crypto').createHash('sha256').update(user.token).digest('hex')]);

  return send(res, 200, { ok: true });
}

// ============================================================ centers
async function listCenters(req, res, user) {
  auth.requireUser(user);
  const rows = user.role === 'master'
    ? await db.all(`SELECT c.id, c.slug, c.name, c.region, c.active, c.created_at,
                           (SELECT count(*)::int FROM members  m WHERE m.center_id = c.id) AS member_count,
                           (SELECT count(*)::int FROM requests r WHERE r.center_id = c.id) AS request_count
                      FROM centers c ORDER BY c.created_at`)
    : await db.all('SELECT id, slug, name, region, active, created_at FROM centers WHERE id = $1', [user.center_id]);
  return send(res, 200, { centers: rows });
}

async function createCenter(req, res, user) {
  auth.requireRole(user, 'master');
  requireJsonRequest(req);
  const body = await readJson(req);
  const slug = str(body.slug, 60).trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const name = str(body.name, 200).trim();
  if (!slug || !name) throw new HttpError(400, '식별자(slug)와 이름을 입력해 주세요.');

  const crypto = require('crypto');
  const center = await db.tx(async (c) => {
    const dupe = await c.query('SELECT 1 FROM centers WHERE slug = $1', [slug]);
    if (dupe.rowCount) throw new HttpError(409, '이미 사용 중인 식별자입니다.');

    const row = (await c.query(
      `INSERT INTO centers (slug, name, region, kiosk_token) VALUES ($1, $2, $3, $4) RETURNING *`,
      [slug, name, str(body.region, 200), crypto.randomBytes(24).toString('base64url')],
    )).rows[0];

    await c.query('INSERT INTO center_settings (center_id) VALUES ($1)', [row.id]);

    // A new center inherits the whole common catalog, disabled, in catalog order.
    await c.query(
      `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
       SELECT $1, s.id, false, row_number() OVER (ORDER BY s.category, s.code)
         FROM services s WHERE s.scope = 'common' AND s.active = true`,
      [row.id],
    );
    return row;
  });
  return send(res, 201, { center });
}

// ============================================================ users (§3-3)
async function listUsers(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  const centerId = auth.resolveCenter(user, url.searchParams.get('center'));
  const rows = centerId
    ? await db.all(
        `SELECT u.id, u.username, u.name, u.role, u.active, u.last_login_at, u.center_id
           FROM users u WHERE u.center_id = $1 ORDER BY u.role, u.username`, [centerId])
    : await db.all(
        `SELECT u.id, u.username, u.name, u.role, u.active, u.last_login_at, u.center_id, c.name AS center_name
           FROM users u LEFT JOIN centers c ON c.id = u.center_id ORDER BY u.role, u.username`);
  return send(res, 200, { users: rows });
}

async function createUser(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  requireJsonRequest(req);
  const body = await readJson(req);
  const role = str(body.role, 20);
  const username = str(body.username, 120).trim();
  const password = String(body.password || '');

  if (!username || password.length < 8) {
    throw new HttpError(400, '아이디와 8자 이상의 비밀번호를 입력해 주세요.');
  }
  if (!['master', 'center_admin', 'staff'].includes(role)) throw new HttpError(400, '알 수 없는 권한입니다.');

  // A center admin may only ever create staff inside their own center.
  if (user.role === 'center_admin' && role !== 'staff') {
    throw new HttpError(403, '담당자 계정만 만들 수 있습니다.');
  }
  // The dashboard sends the target center as a query parameter, like every other
  // route; accept it in the body too for direct API use.
  const requested = body.center_id || url.searchParams.get('center');
  const centerId = role === 'master' ? null : auth.requireCenter(user, requested);
  if (role === 'master') auth.requireRole(user, 'master');

  try {
    const row = await db.one(
      `INSERT INTO users (center_id, role, username, password_hash, name)
            VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, name, role, active, center_id`,
      [centerId, role, username, auth.hashPassword(password), str(body.name, 120)],
    );
    return send(res, 201, { user: row });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, '이미 사용 중인 아이디입니다.');
    throw e;
  }
}

async function updateUser(req, res, user, url, id) {
  auth.requireRole(user, 'master', 'center_admin');
  requireJsonRequest(req);
  const body = await readJson(req);

  const target = await db.one('SELECT id, role, center_id FROM users WHERE id = $1', [id]);
  if (!target) throw new HttpError(404, '계정을 찾을 수 없습니다.');
  if (user.role === 'center_admin') {
    if (target.center_id !== user.center_id || target.role === 'master') {
      throw new HttpError(403, '권한이 없습니다.');
    }
  }

  const sets = [], vals = [];
  if (body.name !== undefined)   { sets.push(`name = $${sets.length + 1}`);   vals.push(str(body.name, 120)); }
  if (body.active !== undefined) { sets.push(`active = $${sets.length + 1}`); vals.push(!!body.active); }
  if (body.password) {
    if (String(body.password).length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
    sets.push(`password_hash = $${sets.length + 1}`);
    vals.push(auth.hashPassword(body.password));
  }
  if (!sets.length) throw new HttpError(400, '변경할 내용이 없습니다.');

  sets.push('updated_at = now()');
  vals.push(id);
  const row = await db.one(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
      RETURNING id, username, name, role, active, center_id`, vals);

  // Changing a password or disabling an account drops that user's sessions.
  if (body.password || body.active === false) {
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  }
  return send(res, 200, { user: row });
}

// ============================================================ members / roster (§3-4)
async function listMembers(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const rows = await db.all(
    'SELECT id, name, phone, note, created_at FROM members WHERE center_id = $1 ORDER BY name, phone',
    [centerId]);
  return send(res, 200, { members: rows });
}

// Accepts one member or a batch — the bulk paste path in the dashboard (§3-4).
async function upsertMembers(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);
  const list = Array.isArray(body.members) ? body.members : [body];

  // Deduplicate by phone within the batch — ON CONFLICT cannot touch the same
  // row twice in one statement, and a pasted spreadsheet often repeats a number.
  // The last occurrence wins, which matches what "paste the corrected list" means.
  const byPhone = new Map();
  for (const m of list) {
    const phone = norm(m.phone);
    if (phone.length < 10 || phone.length > 11) continue;
    byPhone.set(phone, { name: str(m.name, 120).trim(), phone, note: str(m.note, 500) });
  }
  const clean = [...byPhone.values()];
  if (!clean.length) throw new HttpError(400, '전화번호를 확인해 주세요 (10~11자리).');

  // One statement for the whole paste, not one per person (§3-4 — bulk entry has
  // to feel instant, and a per-row loop is a round trip per row).
  await db.query(
    `INSERT INTO members (center_id, name, phone, note)
     SELECT $1, x.name, x.phone, x.note
       FROM unnest($2::text[], $3::text[], $4::text[]) AS x(name, phone, note)
     ON CONFLICT (center_id, phone)
     DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE members.name END,
                   note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE members.note END,
                   updated_at = now()`,
    [centerId, clean.map((m) => m.name), clean.map((m) => m.phone), clean.map((m) => m.note)]);

  const total = await db.one('SELECT count(*)::int AS n FROM members WHERE center_id = $1', [centerId]);
  return send(res, 200, { saved: clean.length, skipped: list.length - clean.length, total: total.n });
}

// 회원 수정 — correct a name or a number in place (§3-4).
// Adding upserts by phone, which can change a name but never the number itself:
// a new number would create a second row and strand the old one. Fixing a
// mistyped digit is the commonest correction there is, so it needs its own path.
async function updateMember(req, res, user, url, id) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);

  const sets = [], vals = [];
  if (body.name !== undefined) { sets.push(`name = $${sets.length + 1}`); vals.push(str(body.name, 120).trim()); }
  if (body.note !== undefined) { sets.push(`note = $${sets.length + 1}`); vals.push(str(body.note, 500)); }
  if (body.phone !== undefined) {
    const phone = norm(body.phone);
    if (phone.length < 10 || phone.length > 11) {
      throw new HttpError(400, '전화번호를 확인해 주세요 (10~11자리).');
    }
    sets.push(`phone = $${sets.length + 1}`);
    vals.push(phone);
  }
  if (!sets.length) throw new HttpError(400, '변경할 내용이 없습니다.');

  sets.push('updated_at = now()');
  vals.push(id, centerId);

  try {
    const row = await db.one(
      `UPDATE members SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND center_id = $${vals.length}
        RETURNING id, name, phone, note`, vals);
    if (!row) throw new HttpError(404, '회원을 찾을 수 없습니다.');
    return send(res, 200, { member: row });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, '이미 등록된 전화번호입니다.');
    throw e;
  }
}

async function deleteMember(req, res, user, url, id) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const r = await db.query('DELETE FROM members WHERE id = $1 AND center_id = $2', [id, centerId]);
  if (!r.rowCount) throw new HttpError(404, '회원을 찾을 수 없습니다.');
  return send(res, 200, { ok: true });
}

async function clearMembers(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const r = await db.query('DELETE FROM members WHERE center_id = $1', [centerId]);
  return send(res, 200, { deleted: r.rowCount });
}

// ============================================================ services & priority (§3-2)
// The resolved view: nationwide-common content plus this center's own, with the
// center's enable/order/override applied on top.
async function listServices(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const rows = await db.all(
    `SELECT s.id, s.code, s.scope, s.category,
            COALESCE(cs.override_sub, s.sub)                 AS sub,
            COALESCE(cs.override_description, s.description) AS description,
            COALESCE(cs.override_org,  s.org)                AS org,
            COALESCE(cs.override_link, s.link)               AS link,
            s.update_method,
            s.keywords,
            s.sub                    AS base_sub,
            s.description            AS base_description,
            s.org                    AS base_org,
            s.link                   AS base_link,
            cs.override_sub IS NOT NULL OR cs.override_description IS NOT NULL
              OR cs.override_org IS NOT NULL OR cs.override_link IS NOT NULL AS overridden,
            COALESCE(cs.enabled, false)   AS enabled,
            COALESCE(cs.sort_order, 9999) AS sort_order
       FROM services s
       LEFT JOIN center_services cs ON cs.service_id = s.id AND cs.center_id = $1
      WHERE s.active = true AND (s.scope = 'common' OR s.center_id = $1)
      ORDER BY sort_order, s.code`,
    [centerId]);
  return send(res, 200, { services: rows });
}

// ------------------------------------------------------------ catalogue import
// 서비스 카탈로그 가져오기 — how a new revision of the service list reaches the
// running platform without a deploy (the client's V03 → V04 question).
//
// The file the client produces is the input format, verbatim: a JSON array of
// {id, category, sub, description, keywords, update_method, org, link}. Our own
// seed file uses shorter keys for the same fields, so both spellings are
// accepted and neither side has to reformat anything.
const FIELD = {
  code: ['code', 'id'],
  category: ['category', 'cat'],
  sub: ['sub'],
  description: ['description', 'desc'],
  keywords: ['keywords', 'kw'],
  org: ['org'],
  link: ['link', 'url'],
  update_method: ['update_method', 'method'],
};
const pickField = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};

const METHODS = ['manual', 'realtime_api', 'scraping'];
const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

/**
 * Normalise one incoming row, or explain why it cannot be used.
 * A row is never half-applied: either every field it carries is acceptable or
 * the whole row is skipped and reported, which is what makes the preview honest.
 */
function normaliseServiceRow(raw, i) {
  const at = i + 1;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: { at, reason: '항목이 객체가 아닙니다.' } };
  }
  const get = (k) => {
    const v = pickField(raw, FIELD[k]);
    return v === undefined ? undefined : str(v, k === 'link' ? 1000 : 500).trim();
  };

  const code = get('code');
  if (!code) return { error: { at, reason: 'code(id)가 없습니다.' } };
  if (!CODE_RE.test(code)) return { error: { at, code, reason: 'code 형식이 올바르지 않습니다.' } };

  const link = get('link');
  // A link is what a senior is ultimately sent. Anything that is not plain http
  // is refused rather than stored — javascript: in a text message is somebody
  // else's problem to explain.
  if (link && !/^https?:\/\//i.test(link)) {
    return { error: { at, code, reason: '링크는 http:// 또는 https:// 여야 합니다.' } };
  }

  const method = get('update_method');
  if (method && !METHODS.includes(method)) {
    return { error: { at, code, reason: `update_method는 ${METHODS.join(' / ')} 중 하나여야 합니다.` } };
  }

  const row = { code };
  for (const k of ['category', 'sub', 'description', 'keywords', 'org', 'link']) {
    const v = get(k);
    if (v !== undefined) row[k] = v;
  }
  if (method) row.update_method = method;
  return { row };
}

// The columns an import is allowed to touch. `code` addresses the row and is
// never itself updated; scope and center_id are decided by the caller's role,
// never by the file.
const IMPORTABLE = ['category', 'sub', 'description', 'keywords', 'org', 'link', 'update_method'];

/**
 * POST /api/services/import — upsert a catalogue revision.
 *
 * Three properties matter more than the code here:
 *  · `dry_run` reports exactly what would change and writes nothing, so a
 *    centre sees the consequences before accepting them (§3-4, the same shape
 *    as the roster paste the client singled out).
 *  · Re-importing an unchanged file reports 60 unchanged and writes nothing —
 *    an import is safe to repeat.
 *  · A row absent from the file is left alone, never deleted. A partial file is
 *    a partial update, not a truncation; retiring a service is a separate,
 *    deliberate act (`active`).
 */
async function importServices(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  requireJsonRequest(req);
  const body = await readJson(req);
  const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : null);
  if (!items) throw new HttpError(400, '가져올 목록이 없습니다.');
  if (items.length > 2000) throw new HttpError(413, '한 번에 2000개까지 가져올 수 있습니다.');

  // Master maintains the nationwide catalogue; a centre maintains its own.
  // The file cannot choose — that is the tenant boundary, and it is decided
  // from the session, exactly like every other write here. Only the centre
  // case needs a centre resolved; nationwide content belongs to no one centre.
  const asCommon = user.role === 'master' && body.scope !== 'center';
  const scope = asCommon ? 'common' : 'center';
  const centerId = asCommon ? null : auth.requireCenter(user, url.searchParams.get('center'));
  const owner = asCommon ? null : centerId;
  const dryRun = !!body.dry_run;

  const skipped = [];
  const rows = [];
  const seen = new Set();
  items.forEach((raw, i) => {
    const { row, error } = normaliseServiceRow(raw, i);
    if (error) return skipped.push(error);
    if (seen.has(row.code)) {
      return skipped.push({ at: i + 1, code: row.code, reason: '파일 안에서 code가 중복됩니다.' });
    }
    seen.add(row.code);
    row._at = i + 1;          // kept only to report a clash against the right line
    rows.push(row);
  });

  const existing = new Map((await db.all(
    `SELECT code, category, sub, description, keywords, org, link, update_method
       FROM services
      WHERE scope = $1 AND center_id IS NOT DISTINCT FROM $2 AND code = ANY($3::text[])`,
    [scope, owner, rows.map((r) => r.code)],
  )).map((r) => [r.code, r]));

  // 같은 코드가 다른 범위에 이미 있으면 건너뜁니다.
  //
  // A centre's list is "everything common, plus everything of mine", so the same
  // code living in both scopes shows the senior's own dashboard two rows with one
  // name and hands the kiosk an ambiguous service_code. Real case: the seed put
  // 서초's 긴급복지지원 at s19 because its text mentions 서초, and the client's file
  // reuses s19 for 노인여가복지시설. Importing it as nationwide content would not
  // have failed — it would have silently produced a duplicate. Refusing and
  // naming the clash is the only outcome a person can act on.
  const clash = new Map((await db.all(
    `SELECT s.code, s.scope, c.name AS center_name
       FROM services s
       LEFT JOIN centers c ON c.id = s.center_id
      WHERE s.code = ANY($1::text[])
        AND NOT (s.scope = $2 AND s.center_id IS NOT DISTINCT FROM $3)
        AND (s.scope = 'common' OR s.center_id = COALESCE($3, s.center_id))`,
    [rows.map((r) => r.code), scope, owner],
  )).map((r) => [r.code, r]));

  const created = [], updated = [], unchanged = [], writable = [];
  for (const row of rows) {
    const other = clash.get(row.code);
    if (other) {
      skipped.push({ at: row._at, code: row.code,
        reason: other.scope === 'common'
          ? '이 코드는 이미 전국 공통 서비스로 등록되어 있습니다. 다른 code를 쓰거나 마스터에게 수정을 요청하세요.'
          : `이 코드는 이미 '${other.center_name}' 전용 서비스로 등록되어 있습니다. 다른 code를 써 주세요.` });
      continue;
    }
    writable.push(row);
    const was = existing.get(row.code);
    if (!was) { created.push(row.code); continue; }
    const changes = IMPORTABLE
      .filter((k) => row[k] !== undefined && row[k] !== was[k])
      .map((k) => ({ field: k, from: was[k], to: row[k] }));
    (changes.length ? updated : unchanged).push(
      changes.length ? { code: row.code, changes } : row.code);
  }

  const summary = {
    scope,
    dry_run: dryRun,
    total: items.length,
    created: created.length,
    updated: updated.length,
    unchanged: unchanged.length,
    skipped: skipped.length,
    detail: { created, updated, skipped },
  };
  if (dryRun || !writable.length) return send(res, 200, summary);

  // Resolve each row against what is already stored *before* writing, so a file
  // that omits a column leaves that column alone. Doing this in SQL would mean
  // COALESCE against `excluded`, and `excluded` cannot carry a NULL through a
  // NOT NULL column — the omission would arrive as '' and quietly blank the
  // existing value. The comparison above already loaded every row this needs.
  const DEFAULTS = { update_method: 'manual' };
  const final = writable.map((row) => {
    const was = existing.get(row.code) || {};
    const out = { code: row.code };
    for (const k of IMPORTABLE) {
      out[k] = row[k] !== undefined ? row[k]
             : was[k] !== undefined ? was[k]
             : (DEFAULTS[k] || '');
    }
    return out;
  });

  // One statement per field set rather than one per row: the same reason
  // savePriority batches, and this runs against a database an ocean away.
  const conflict = asCommon
    ? `(code) WHERE scope = 'common'`
    : `(center_id, code) WHERE scope = 'center'`;

  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO services (code, scope, center_id, category, sub, description,
                             keywords, org, link, update_method)
       SELECT x.code, $1, $2, x.category, x.sub, x.description,
              x.keywords, x.org, x.link, x.update_method
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[], $9::text[], $10::text[])
           AS x(code, category, sub, description, keywords, org, link, update_method)
       ON CONFLICT ${conflict}
       DO UPDATE SET category      = excluded.category,
                     sub           = excluded.sub,
                     description   = excluded.description,
                     keywords      = excluded.keywords,
                     org           = excluded.org,
                     link          = excluded.link,
                     update_method = excluded.update_method,
                     updated_at    = now()`,
      [scope, owner, final.map((r) => r.code),
       ...IMPORTABLE.map((k) => final.map((r) => r[k]))],
    );

    // A brand-new service needs a center_services row or it cannot be ordered
    // or switched on. Disabled by default — an import adds to what a centre may
    // offer, it never decides for the centre what it offers.
    //
    // Nationwide content lands in every centre, the way createCenter hands a new
    // centre the whole common catalogue; a centre's own content lands only there.
    if (created.length) {
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
         SELECT ctr.id, s.id, false,
                COALESCE((SELECT max(cs.sort_order) + 1
                            FROM center_services cs WHERE cs.center_id = ctr.id), 0)
                  + row_number() OVER (PARTITION BY ctr.id ORDER BY s.code)
           FROM services s
           JOIN centers ctr ON ($1::uuid IS NULL AND ctr.active) OR ctr.id = $1
          WHERE s.scope = $2 AND s.center_id IS NOT DISTINCT FROM $3
            AND s.code = ANY($4::text[])
         ON CONFLICT (center_id, service_id) DO NOTHING`,
        [centerId, scope, owner, created]);
    }
  });

  // Common content reaches every centre, so every cached kiosk copy is stale.
  asCommon ? kioskCache.bustAll() : kioskCache.bust(centerId);
  return send(res, 200, summary);
}

/**
 * PATCH /api/services/:id — correct one entry from the dashboard.
 *
 * Which row actually changes depends on who is asking, and that is §3-2 rather
 * than a special case: master edits nationwide content at the source, so the fix
 * reaches every centre. A centre editing an inherited entry writes an *override*
 * instead, leaving the nationwide row alone — which is what the override columns
 * have been for since 001, with nothing writing them until now. A centre's own
 * content it simply owns, and edits directly.
 */
const EDITABLE = ['category', 'sub', 'description', 'keywords', 'org', 'link', 'update_method'];
const OVERRIDABLE = { sub: 'override_sub', description: 'override_description',
                      org: 'override_org', link: 'override_link' };

async function updateService(req, res, user, url, id) {
  auth.requireRole(user, 'master', 'center_admin');
  if (!UUID.test(String(id || ''))) throw new HttpError(400, '잘못된 서비스 주소입니다.');
  requireJsonRequest(req);
  const body = await readJson(req);

  const { row: patch, error } = normaliseServiceRow({ code: 'x', ...body }, 0);
  if (error) throw new HttpError(400, error.reason);
  delete patch.code;

  const centerId = user.role === 'master'
    ? auth.resolveCenter(user, url.searchParams.get('center'))
    : auth.requireCenter(user, url.searchParams.get('center'));

  // The tenant boundary: a centre may only reach rows it can already see —
  // nationwide content, or its own. Anything else simply is not found.
  const svc = await db.one(
    `SELECT id, scope, center_id FROM services
      WHERE id = $1 AND (scope = 'common' OR center_id = $2)`,
    [id, centerId]);
  if (!svc) throw new HttpError(404, '서비스를 찾을 수 없습니다.');

  const editBase = svc.scope === 'center' || user.role === 'master';

  if (editBase) {
    const fields = EDITABLE.filter((k) => patch[k] !== undefined);
    if (!fields.length) throw new HttpError(400, '변경할 내용이 없습니다.');
    await db.query(
      `UPDATE services SET ${fields.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now()
        WHERE id = $1`,
      [svc.id, ...fields.map((k) => patch[k])]);
  } else {
    const fields = Object.keys(OVERRIDABLE).filter((k) => patch[k] !== undefined);
    if (!fields.length) {
      throw new HttpError(400, '공통 서비스는 이름·설명·담당기관·링크만 우리 복지관에 맞게 바꿀 수 있습니다.');
    }
    // An empty string is how the dashboard says "drop my override and inherit
    // the nationwide value again" — distinct from never having set one.
    const cols = fields.map((k) => OVERRIDABLE[k]);
    const vals = fields.map((k) => (patch[k] === '' ? null : patch[k]));
    await db.query(
      `INSERT INTO center_services (center_id, service_id, ${cols.join(', ')})
            VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (center_id, service_id)
       DO UPDATE SET ${cols.map((c2) => `${c2} = excluded.${c2}`).join(', ')}, updated_at = now()`,
      [centerId, svc.id, ...vals]);
  }

  svc.scope === 'common' && user.role === 'master' ? kioskCache.bustAll() : kioskCache.bust(centerId);
  return send(res, 200, { ok: true, scope: svc.scope, overridden: !editBase });
}

async function savePriority(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, '저장할 항목이 없습니다.');

  // One statement, not one per service. A row-at-a-time loop here meant ~120
  // sequential round trips, which is instant against a local database and takes
  // half a minute against a hosted one.
  const seen = new Set();
  const ids = [], enabled = [], orders = [];
  items.forEach((it, i) => {
    const id = String(it.id || '');
    if (!UUID.test(id) || seen.has(id)) return;      // a bad id would break the uuid[] cast
    seen.add(id);
    ids.push(id);
    enabled.push(!!it.enabled);
    orders.push(Number.isFinite(+it.sort_order) ? +it.sort_order : i);
  });
  if (!ids.length) throw new HttpError(400, '저장할 항목이 없습니다.');

  // The join is what keeps the tenant boundary: a service this center cannot
  // see simply produces no row, exactly as the previous per-item check did.
  const { rows } = await db.query(
    `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
     SELECT $1, s.id, x.enabled, x.sort_order
       FROM unnest($2::uuid[], $3::boolean[], $4::int[]) AS x(service_id, enabled, sort_order)
       JOIN services s ON s.id = x.service_id
        AND s.active = true AND (s.scope = 'common' OR s.center_id = $1)
     ON CONFLICT (center_id, service_id)
     DO UPDATE SET enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = now()
     RETURNING service_id`,
    [centerId, ids, enabled, orders]);

  // The kiosk is holding a cached copy of this list — drop it so the change is
  // audible on the next call rather than up to a minute later.
  kioskCache.bust(centerId);

  return send(res, 200, { saved: rows.length });
}

// ============================================================ settings (§3-5)
// The kiosk token is a capability — it lets the holder look callers up in the
// roster and file requests — so only the roles that configure kiosks get it.
// Both the read and the write go through here, so a save returns the same shape
// as a load and the caller's copy of the settings never loses a field.
async function withKioskToken(settings, user, centerId) {
  if (user.role === 'master' || user.role === 'center_admin') {
    const c = await db.one('SELECT kiosk_token FROM centers WHERE id = $1', [centerId]);
    settings.kiosk_token = c ? c.kiosk_token : null;
  }
  return settings;
}

async function getSettings(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  let s = await db.one('SELECT * FROM center_settings WHERE center_id = $1', [centerId]);
  if (!s) s = await db.one('INSERT INTO center_settings (center_id) VALUES ($1) RETURNING *', [centerId]);
  return send(res, 200, { settings: await withKioskToken(s, user, centerId) });
}

async function updateSettings(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);

  const allowed = {
    ieumi_name: (v) => str(v, 60) || '이음이',
    voice_speaker: (v) => str(v, 40),
    voice_speed: (v) => str(v, 5),
    tone: (v) => (['warm', 'plain', 'cheerful'].includes(v) ? v : 'warm'),
    greeting: (v) => str(v, 500),
    roster_check_on: (v) => !!v,
    chat_model: (v) => str(v, 80) || null,
  };

  const sets = [], vals = [];
  for (const [k, coerce] of Object.entries(allowed)) {
    if (body[k] !== undefined) { sets.push(`${k} = $${sets.length + 1}`); vals.push(coerce(body[k])); }
  }
  if (!sets.length) throw new HttpError(400, '변경할 내용이 없습니다.');
  sets.push('updated_at = now()');
  vals.push(centerId);

  await db.query('INSERT INTO center_settings (center_id) VALUES ($1) ON CONFLICT DO NOTHING', [centerId]);
  const row = await db.one(
    `UPDATE center_settings SET ${sets.join(', ')} WHERE center_id = $${vals.length} RETURNING *`, vals);

  // Name, voice and tone are read from the cache on every turn — drop it so a
  // saved change is heard on the next call.
  kioskCache.bust(centerId);

  return send(res, 200, { settings: await withKioskToken(row, user, centerId) });
}

// ============================================================ requests
async function listRequests(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const rows = await db.all(
    `SELECT r.id, r.caller_name, r.caller_phone, r.category, r.summary, r.transcript, r.chips,
            r.urgent, r.followup, r.status, r.memo, r.created_at, r.member_id,
            m.name AS member_name,
            r.service_code,
            (SELECT sv.sub FROM services sv
              WHERE sv.code = r.service_code
                AND (sv.scope = 'common' OR sv.center_id = r.center_id)
              LIMIT 1) AS service_name
       FROM requests r
       LEFT JOIN members m ON m.id = r.member_id
      WHERE r.center_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 300`,
    [centerId]);
  return send(res, 200, { requests: rows });
}

async function updateRequest(req, res, user, url, id) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);

  const sets = [], vals = [];
  if (body.status !== undefined) {
    if (!['접수', '처리중', '완료'].includes(body.status)) throw new HttpError(400, '알 수 없는 상태입니다.');
    sets.push(`status = $${sets.length + 1}`); vals.push(body.status);
  }
  if (body.memo !== undefined)     { sets.push(`memo = $${sets.length + 1}`);     vals.push(str(body.memo, 2000)); }
  if (body.followup !== undefined) { sets.push(`followup = $${sets.length + 1}`); vals.push(!!body.followup); }
  if (!sets.length) throw new HttpError(400, '변경할 내용이 없습니다.');

  sets.push('updated_at = now()', `handled_by = $${sets.length + 1}`);
  vals.push(user.id, id, centerId);
  const row = await db.one(
    `UPDATE requests SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND center_id = $${vals.length}
      RETURNING id, status, memo, followup`, vals);
  if (!row) throw new HttpError(404, '요청을 찾을 수 없습니다.');
  return send(res, 200, { request: row });
}

// ============================================================ job posts
async function listJobPosts(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const rows = await db.all(
    'SELECT id, title, kind, ref, created_at FROM job_posts WHERE center_id = $1 ORDER BY created_at DESC',
    [centerId]);
  return send(res, 200, { jobPosts: rows });
}

async function createJobPost(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);
  const title = str(body.title, 300).trim();
  if (!title) throw new HttpError(400, '제목을 입력해 주세요.');
  const kind = ['텍스트', '링크', '파일'].includes(body.kind) ? body.kind : '텍스트';
  const row = await db.one(
    `INSERT INTO job_posts (center_id, title, kind, ref) VALUES ($1, $2, $3, $4)
       RETURNING id, title, kind, ref, created_at`,
    [centerId, title, kind, str(body.ref, 1000)]);
  return send(res, 201, { jobPost: row });
}

async function deleteJobPost(req, res, user, url, id) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const r = await db.query('DELETE FROM job_posts WHERE id = $1 AND center_id = $2', [id, centerId]);
  if (!r.rowCount) throw new HttpError(404, '자료를 찾을 수 없습니다.');
  return send(res, 200, { ok: true });
}

// ============================================================ job postings
// 일자리 데이터 — synced from data.go.kr by jobs.js. A sync takes minutes, so it
// is never awaited inside a request: the dashboard starts one and polls.
let syncRunning = false;

async function jobsStatus(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const jobs = require('./jobs');

  const state = await jobs.status();
  const center = await db.one('SELECT name, region FROM centers WHERE id = $1', [centerId]);
  const mine = await jobs.forCenterRegion(center.region, 8);
  const total = await db.one('SELECT count(*)::int AS n FROM jobs');

  return send(res, 200, {
    configured: !!jobs.KEY,
    running: syncRunning,
    state,
    total: total.n,
    center: { name: center.name, region: center.region },
    scope: mine.scope,          // sigungu | sido | none
    region: mine.region,
    jobs: mine.jobs,
  });
}

async function jobsSync(req, res, user) {
  auth.requireRole(user, 'master', 'center_admin');
  const jobs = require('./jobs');
  if (!jobs.KEY) throw new HttpError(400, 'DATAGO_KEY가 설정되지 않았습니다.');
  if (syncRunning) return send(res, 202, { running: true, note: '이미 동기화 중입니다.' });

  // Started, not awaited — the API takes minutes and the request would time out.
  syncRunning = true;
  jobs.sync()
    .catch((e) => console.error('[jobs] sync failed:', e.message))
    .finally(() => { syncRunning = false; });

  return send(res, 202, { running: true, note: '동기화를 시작했습니다. 몇 분 걸립니다.' });
}

// ============================================================ stats
async function stats(req, res, user, url) {
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  const row = await db.one(
    `SELECT (SELECT count(*)::int FROM members  WHERE center_id = $1) AS members,
            (SELECT count(*)::int FROM requests WHERE center_id = $1) AS requests,
            (SELECT count(*)::int FROM requests WHERE center_id = $1 AND status = '완료') AS done,
            (SELECT count(*)::int FROM requests WHERE center_id = $1 AND urgent)          AS urgent,
            (SELECT count(*)::int FROM center_services WHERE center_id = $1 AND enabled)  AS enabled_services,
            (SELECT roster_check_on FROM center_settings WHERE center_id = $1)            AS roster_check_on`,
    [centerId]);
  return send(res, 200, { stats: row });
}

// ============================================================ kiosk (token, no login)
// A kiosk device has no human to sign in, so it carries a per-center token in its
// URL. That token grants only what the kiosk needs and nothing else.
async function kioskContext(req, res, url) {
  const center = await auth.centerFromKioskToken(url.searchParams.get('c'));
  if (!center) throw new HttpError(404, '등록되지 않은 키오스크입니다.');   // unknown kiosk

  const settings = await db.one(
    `SELECT ieumi_name, voice_speaker, voice_speed, tone, greeting, roster_check_on
       FROM center_settings WHERE center_id = $1`, [center.id]);

  const services = await db.all(
    `SELECT s.code, s.category,
            COALESCE(cs.override_sub, s.sub)                 AS sub,
            COALESCE(cs.override_description, s.description) AS description,
            COALESCE(cs.override_org,  s.org)                AS org,
            COALESCE(cs.override_link, s.link)               AS link,
            s.keywords, cs.sort_order
       FROM center_services cs
       JOIN services s ON s.id = cs.service_id
      WHERE cs.center_id = $1 AND cs.enabled = true AND s.active = true
      ORDER BY cs.sort_order`, [center.id]);

  return send(res, 200, {
    center: { id: center.id, slug: center.slug, name: center.name, region: center.region },
    settings: settings || {},
    services,
  });
}

async function kioskLookup(req, res, url) {
  requireJsonRequest(req);
  const body = await readJson(req);
  const center = await auth.centerFromKioskToken(body.c || url.searchParams.get('c'));
  if (!center) throw new HttpError(404, '등록되지 않은 키오스크입니다.');

  const phone = norm(body.phone);
  if (phone.length < 10) return send(res, 200, { found: false });

  const m = await db.one(
    'SELECT id, name FROM members WHERE center_id = $1 AND phone = $2', [center.id, phone]);
  return send(res, 200, m ? { found: true, id: m.id, name: m.name } : { found: false });
}

async function kioskCreateRequest(req, res, url) {
  requireJsonRequest(req);
  const body = await readJson(req);
  const center = await auth.centerFromKioskToken(body.c || url.searchParams.get('c'));
  if (!center) throw new HttpError(404, '등록되지 않은 키오스크입니다.');

  const phone = norm(body.phone);
  const member = phone
    ? await db.one('SELECT id, name FROM members WHERE center_id = $1 AND phone = $2', [center.id, phone])
    : null;

  const category = ['job', 'health', 'welfare', 'urgent', 'etc'].includes(body.category) ? body.category : 'etc';

  // Only a service this centre has actually switched on may be recorded, so the
  // figures a centre sees are its own selections and nothing else.
  let serviceCode = null;
  if (body.serviceCode) {
    const svc = await db.one(
      `SELECT sv.code
         FROM center_services cs
         JOIN services sv ON sv.id = cs.service_id
        WHERE cs.center_id = $1 AND cs.enabled = true AND sv.code = $2
          AND (sv.scope = 'common' OR sv.center_id = $1)`,
      [center.id, str(body.serviceCode, 40)]);
    serviceCode = svc ? svc.code : null;
  }
  const transcript = Array.isArray(body.transcript)
    ? body.transcript.slice(0, 200).map((t) => ({ role: t.role === 'senior' ? 'senior' : 'ieumi', text: str(t.text, 2000) }))
    : [];

  const row = await db.one(
    `INSERT INTO requests
       (center_id, member_id, caller_name, caller_phone, category, summary, transcript, chips, urgent, followup, service_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
     RETURNING id, created_at`,
    [center.id, member?.id || null, str(body.name || member?.name || '', 120), phone, category,
     str(body.summary, 2000), JSON.stringify(transcript),
     JSON.stringify(Array.isArray(body.chips) ? body.chips.slice(0, 12).map((x) => str(x, 80)) : []),
     !!body.urgent, body.followup !== false, serviceCode],
  );
  return send(res, 201, { id: row.id, created_at: row.created_at });
}

// ============================================================ import from localStorage
// One-time migration path for demo data already sitting in a browser (§4).
async function importLocalStorage(req, res, user, url) {
  auth.requireRole(user, 'master', 'center_admin');
  const centerId = auth.requireCenter(user, url.searchParams.get('center'));
  requireJsonRequest(req);
  const body = await readJson(req);
  const out = { members: 0, priority: 0, jobPosts: 0 };

  await db.tx(async (c) => {
    for (const m of Array.isArray(body.roster) ? body.roster : []) {
      const phone = norm(m.phone);
      if (phone.length < 10) continue;
      await c.query(
        `INSERT INTO members (center_id, name, phone) VALUES ($1, $2, $3)
         ON CONFLICT (center_id, phone) DO UPDATE SET name = excluded.name, updated_at = now()`,
        [centerId, str(m.name, 120), phone]);
      out.members++;
    }

    // { on: {serviceCode: true}, order: [serviceCode, …] }
    const p = body.priority || {};
    const order = Array.isArray(p.order) ? p.order : [];
    for (let i = 0; i < order.length; i++) {
      const svc = (await c.query(
        `SELECT id FROM services WHERE code = $1 AND (scope = 'common' OR center_id = $2)`,
        [String(order[i]), centerId])).rows[0];
      if (!svc) continue;
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order) VALUES ($1, $2, $3, $4)
         ON CONFLICT (center_id, service_id)
         DO UPDATE SET enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = now()`,
        [centerId, svc.id, !!(p.on && p.on[order[i]]), i]);
      out.priority++;
    }

    for (const j of Array.isArray(body.jobPosts) ? body.jobPosts : []) {
      if (!j.title) continue;
      await c.query(
        `INSERT INTO job_posts (center_id, title, kind, ref) VALUES ($1, $2, $3, $4)`,
        [centerId, str(j.title, 300), ['텍스트', '링크', '파일'].includes(j.type) ? j.type : '텍스트', str(j.ref, 1000)]);
      out.jobPosts++;
    }
  });
  return send(res, 200, { imported: out });
}

// ============================================================ router
const ROUTES = [
  ['POST',   /^\/api\/login$/,               login,            { open: true }],
  ['POST',   /^\/api\/logout$/,              logout,           { open: true }],
  ['GET',    /^\/api\/me$/,                  me,               { open: true }],
  ['PATCH',  /^\/api\/me\/password$/,        changeOwnPassword],

  ['GET',    /^\/api\/kiosk\/context$/,      kioskContext,     { kiosk: true }],
  ['POST',   /^\/api\/kiosk\/lookup$/,       kioskLookup,      { kiosk: true }],
  ['POST',   /^\/api\/kiosk\/requests$/,     kioskCreateRequest, { kiosk: true }],

  ['GET',    /^\/api\/centers$/,             listCenters],
  ['POST',   /^\/api\/centers$/,             createCenter],

  ['GET',    /^\/api\/users$/,               listUsers],
  ['POST',   /^\/api\/users$/,               createUser],
  ['PATCH',  /^\/api\/users\/([\w-]+)$/,     updateUser],

  ['GET',    /^\/api\/members$/,             listMembers],
  ['POST',   /^\/api\/members$/,             upsertMembers],
  ['DELETE', /^\/api\/members$/,             clearMembers],
  ['PATCH',  /^\/api\/members\/([\w-]+)$/,   updateMember],
  ['DELETE', /^\/api\/members\/([\w-]+)$/,   deleteMember],

  ['GET',    /^\/api\/services$/,            listServices],
  ['POST',   /^\/api\/services\/import$/,    importServices],
  ['PUT',    /^\/api\/services\/priority$/,  savePriority],
  ['PATCH',  /^\/api\/services\/([\w-]+)$/,  updateService],

  ['GET',    /^\/api\/settings$/,            getSettings],
  ['PATCH',  /^\/api\/settings$/,            updateSettings],

  ['GET',    /^\/api\/requests$/,            listRequests],
  ['PATCH',  /^\/api\/requests\/([\w-]+)$/,  updateRequest],

  ['GET',    /^\/api\/job-posts$/,           listJobPosts],
  ['POST',   /^\/api\/job-posts$/,           createJobPost],
  ['DELETE', /^\/api\/job-posts\/([\w-]+)$/, deleteJobPost],

  ['GET',    /^\/api\/jobs\/status$/,        jobsStatus],
  ['POST',   /^\/api\/jobs\/sync$/,          jobsSync],

  ['GET',    /^\/api\/stats$/,               stats],
  ['POST',   /^\/api\/import$/,              importLocalStorage],
];

/** Returns true when the request was an /api/* route and has been answered. */
async function handle(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;

  // Without a database nothing here can work; say so plainly rather than
  // letting every call fail as an opaque 500.
  if (!db.DATABASE_URL) {
    send(res, 503, { error: '데이터베이스가 설정되지 않았습니다. ieumi-server/.env 의 DATABASE_URL 을 확인해 주세요. (DATABASE_URL is not configured — see README)' });
    return true;
  }

  const match = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!match) {
    send(res, 404, { error: '알 수 없는 API 경로입니다.' });
    return true;
  }

  const [, re, fn, opts = {}] = match;
  const params = (url.pathname.match(re) || []).slice(1);

  try {
    if (opts.kiosk) {
      await fn(req, res, url, ...params);
    } else if (opts.open) {
      const user = await auth.currentUser(req);
      await fn(req, res, user, url, ...params);
    } else {
      const user = auth.requireUser(await auth.currentUser(req));
      await fn(req, res, user, url, ...params);
    }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}:`, e);
    send(res, status, { error: status >= 500 ? '서버 오류가 발생했습니다.' : e.message });
  }
  return true;
}

module.exports = { handle, send, readJson, norm };
