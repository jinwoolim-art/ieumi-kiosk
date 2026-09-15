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
// {id, category, sub, description, keywords, update_method, org, link, scope}.
// Our own seed file uses shorter keys for the same fields, so both spellings are
// accepted and neither side has to reformat anything.
//
// `scope` answers the question the first import raised: `org` showed that most
// of the list is run by a Seocho-district body, which must not be inherited by
// 강서 as nationwide content. The client now classifies each row —
// common (전국·서울 광역) or center (서초 전용) — and this honours it per row.
const FIELD = {
  code: ['code', 'id'],
  category: ['category', 'cat'],
  sub: ['sub'],
  description: ['description', 'desc'],
  keywords: ['keywords', 'kw'],
  org: ['org'],
  link: ['link', 'url'],
  update_method: ['update_method', 'method'],
  scope: ['scope'],
};
const pickField = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== null) return row[n];
  return undefined;
};

const METHODS = ['manual', 'realtime_api', 'scraping'];
const SCOPES = ['common', 'center'];
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

  const scope = get('scope');
  if (scope && !SCOPES.includes(scope)) {
    return { error: { at, code, reason: `scope는 ${SCOPES.join(' / ')} 중 하나여야 합니다.` } };
  }

  const row = { code };
  for (const k of ['category', 'sub', 'description', 'keywords', 'org', 'link']) {
    const v = get(k);
    if (v !== undefined) row[k] = v;
  }
  if (method) row.update_method = method;
  if (scope) row.scope = scope;
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

  const dryRun = !!body.dry_run;
  const isMaster = user.role === 'master';

  // 가져온 서비스는 기본으로 켜집니다. A catalogue a centre authored is a statement
  // about what it offers, so an import that leaves every row switched off blocks
  // guidance entirely — the client hit exactly that, and from the kiosk it is
  // indistinguishable from a matching failure. `enable: false` imports without
  // touching a single switch, for a centre that wants to review first.
  const enable = body.enable !== false;

  // 어느 복지관의 자료인가 — the centre a centre-scoped row belongs to. A centre
  // admin never gets to name another; master names one with ?center=. Nationwide
  // rows belong to no centre and need none, so master may import a file of only
  // common rows without selecting anything.
  const centerId = isMaster
    ? auth.resolveCenter(user, url.searchParams.get('center'))
    : auth.requireCenter(user, url.searchParams.get('center'));
  // A centre's import is its own content whatever the file or the body says, so
  // the reported default has to say that too — otherwise the summary claims a
  // scope the rows were never given.
  const defaultScope = !isMaster ? 'center'
    : (SCOPES.includes(body.scope) ? body.scope : 'common');

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
    row._at = i + 1;

    // 범위는 파일이 제안하고, 권한이 결정합니다 (§3-3). A centre admin's import is
    // always their own content however the file is labelled — otherwise a file
    // would be a way to edit every centre's catalogue at once.
    const want = isMaster ? (row.scope || defaultScope) : 'center';
    row._scope = want;
    row._owner = want === 'center' ? centerId : null;
    if (want === 'center' && !centerId) {
      return skipped.push({ at: row._at, code: row.code,
        reason: '우리 복지관 전용(center) 항목입니다. 어느 복지관에 넣을지 먼저 선택해 주세요.' });
    }
    rows.push(row);
  });

  const codes = rows.map((r) => r.code);

  // Every stored row carrying one of these codes, in any scope — the move and
  // the collision test below both need to see rows the target scope does not hold.
  const stored = await db.all(
    `SELECT s.id, s.code, s.scope, s.center_id, c.name AS center_name,
            s.category, s.sub, s.description, s.keywords, s.org, s.link, s.update_method
       FROM services s
       LEFT JOIN centers c ON c.id = s.center_id
      WHERE s.code = ANY($1::text[])`, [codes]);

  // 이름이 바뀌는 항목은 이력이 걸려 있습니다 — how many calls were already filed
  // against each code, so a rename can be reported with its cost rather than as
  // a routine field change.
  const reqCount = new Map((await db.all(
    `SELECT service_code AS code, count(*)::int AS n FROM requests
      WHERE service_code = ANY($1::text[]) GROUP BY 1`, [codes],
  )).map((r) => [r.code, r.n]));

  const sameSlot = (r, row) => r.scope === row._scope
    && (r.center_id || null) === (row._owner || null);

  // Two rows with one code only matter where somebody would see both at once. A
  // centre's list is "everything common, plus everything of mine", so a
  // nationwide row collides with every centre's private row of the same code,
  // while two different centres' private rows never meet.
  const collides = (r, row) => !sameSlot(r, row)
    && (row._scope === 'common' || r.scope === 'common' || r.center_id === row._owner);

  // A move rewrites who owns a service, so three things must all hold.
  //
  // It is master's to make: a centre must not be able to pull nationwide content
  // out of every other centre. The file must *say* the scope — a scope that was
  // merely defaulted is an assumption, not an instruction, and a file with no
  // scope field at all (the client's first version) must never silently
  // reclassify anything. And no import hands one centre's private service to
  // another; that is not a reclassification, it is a transfer.
  const movable = (from, row) => isMaster
    && !!row.scope
    && !(from.scope === 'center' && row._scope === 'center');

  const created = [], updated = [], unchanged = [], moved = [], renamed = [], applied = [];
  const toInsert = [], toUpdate = [], toMove = [];

  for (const row of rows) {
    const mine = stored.filter((r) => r.code === row.code);
    const target = mine.find((r) => sameSlot(r, row));
    const others = mine.filter((r) => collides(r, row));

    if (others.length && (target || others.length > 1 || !movable(others[0], row))) {
      const o = others[0];
      skipped.push({ at: row._at, code: row.code,
        reason: target
          ? `이 code가 두 곳에 있습니다 (${o.scope === 'common' ? '전국 공통' : o.center_name}). 먼저 정리해야 합니다.`
          : o.scope === 'common'
            ? '이 코드는 전국 공통 서비스입니다. 우리 복지관 전용으로 바꾸려면 마스터에게 요청하세요.'
            : `이 코드는 '${o.center_name}' 전용 서비스입니다. 다른 code를 써 주세요.` });
      continue;
    }

    // Past the guard: this row is going in. 변경이 없어도 포함됩니다 — an unchanged
    // row still counts, because "already in the catalogue but switched off" is
    // the state the client is trying to get out of.
    applied.push(row.code);

    const was = target || (others.length ? others[0] : null);
    const isMove = !target && !!was;

    const changes = IMPORTABLE
      .filter((k) => row[k] !== undefined && was && row[k] !== was[k])
      .map((k) => ({ field: k, from: was[k], to: row[k] }));

    if (!was) {
      created.push(row.code);
      toInsert.push(row);
    } else if (isMove) {
      moved.push({ code: row.code,
                   from: was.scope === 'common' ? '전국 공통' : was.center_name,
                   to: row._scope === 'common' ? '전국 공통' : '이 복지관 전용',
                   changes });
      toMove.push({ ...row, _id: was.id });
    } else if (changes.length) {
      updated.push({ code: row.code, changes });
      toUpdate.push({ ...row, _id: was.id });
    } else {
      unchanged.push(row.code);
    }

    // A changed 사업명 is the one edit that can quietly turn a code into a
    // different service — the client's s19 (긴급복지지원 → 노인여가복지시설) does
    // exactly that, and any call already filed under s19 silently re-labels.
    if (was && row.sub !== undefined && row.sub !== was.sub) {
      renamed.push({ code: row.code, from: was.sub, to: row.sub,
                     requests: reqCount.get(row.code) || 0 });
    }
  }

  // Moving nationwide content into one centre takes it away from the others.
  // Nobody should discover that after pressing the button.
  const centresLosing = toMove.some((m) => m._scope === 'center')
    ? (await db.one('SELECT count(*)::int n FROM centers WHERE active AND id <> $1', [centerId])).n
    : 0;

  // 지금 꺼져 있어 켜질 항목 — counted before the write so the preview can show it.
  // A service already on is not reported: the number means switches that move.
  const offNow = enable && applied.length
    ? (await db.all(
        `SELECT DISTINCT s.code
           FROM center_services cs
           JOIN services s ON s.id = cs.service_id
          WHERE s.code = ANY($1::text[]) AND NOT cs.enabled
            AND (s.scope = 'common' OR (s.center_id = $2 AND cs.center_id = $2))`,
        [applied, centerId])).map((r) => r.code)
    : [];
  const willEnable = enable ? [...new Set([...created, ...offNow])] : [];

  const summary = {
    scope: defaultScope,
    scopes: { common: rows.filter((r) => r._scope === 'common').length,
              center: rows.filter((r) => r._scope === 'center').length },
    dry_run: dryRun,
    total: items.length,
    created: created.length,
    updated: updated.length,
    moved: moved.length,
    unchanged: unchanged.length,
    enabled: willEnable.length,
    skipped: skipped.length,
    centres_losing_access: centresLosing,
    detail: { created, updated, moved, renamed, skipped, enabled: willEnable },
  };

  if (dryRun || !(toInsert.length || toUpdate.length || toMove.length || willEnable.length)) {
    return send(res, 200, summary);
  }

  // Resolve each row against what is already stored *before* writing, so a file
  // that omits a column leaves that column alone. Doing this in SQL would mean
  // COALESCE against `excluded`, and `excluded` cannot carry a NULL through a
  // NOT NULL column — the omission would arrive as '' and quietly blank the
  // existing value.
  const DEFAULTS = { update_method: 'manual' };
  const byId = new Map(stored.map((r) => [r.id, r]));
  const fill = (row) => {
    const was = (row._id && byId.get(row._id)) || {};
    const out = { code: row.code, _id: row._id, _scope: row._scope, _owner: row._owner };
    for (const k of IMPORTABLE) {
      out[k] = row[k] !== undefined ? row[k]
             : was[k] !== undefined ? was[k]
             : (DEFAULTS[k] || '');
    }
    return out;
  };
  const ins = toInsert.map(fill);
  const upd = [...toUpdate, ...toMove].map(fill);
  const col = (list, k) => list.map((r) => r[k]);

  await db.tx(async (c) => {
    if (ins.length) {
      await c.query(
        `INSERT INTO services (code, scope, center_id, category, sub, description,
                               keywords, org, link, update_method)
         SELECT x.code, x.scope, x.center_id::uuid, x.category, x.sub, x.description,
                x.keywords, x.org, x.link, x.update_method
           FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                       $7::text[], $8::text[], $9::text[], $10::text[])
             AS x(code, scope, center_id, category, sub, description,
                  keywords, org, link, update_method)`,
        [col(ins, 'code'), col(ins, '_scope'), col(ins, '_owner'),
         ...IMPORTABLE.map((k) => col(ins, k))]);
    }

    // An update and a move are the same statement: a move simply also rewrites
    // scope and owner. Doing it in place is what preserves the owning centre's
    // enabled flag, ordering and overrides — those hang off services.id.
    if (upd.length) {
      await c.query(
        `UPDATE services s
            SET scope = x.scope, center_id = x.center_id::uuid,
                category = x.category, sub = x.sub, description = x.description,
                keywords = x.keywords, org = x.org, link = x.link,
                update_method = x.update_method, updated_at = now()
           FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                       $7::text[], $8::text[], $9::text[], $10::text[])
             AS x(id, scope, center_id, category, sub, description,
                  keywords, org, link, update_method)
          WHERE s.id = x.id`,
        [col(upd, '_id'), col(upd, '_scope'), col(upd, '_owner'),
         ...IMPORTABLE.map((k) => col(upd, k))]);
    }

    // ---- center_services has to follow a move, or the inheritance starts lying.
    const intoCentre = toMove.filter((m) => m._scope === 'center').map((m) => m._id);
    if (intoCentre.length) {
      // Every other centre inherited this while it was nationwide. It belongs to
      // one centre now, and dropping those rows is the entire point of the move.
      await c.query(
        `DELETE FROM center_services cs
          USING unnest($1::uuid[]) AS x(service_id)
          WHERE cs.service_id = x.service_id AND cs.center_id <> $2`,
        [intoCentre, centerId]);
      // The new owner normally already has its row, because it inherited too.
      // This covers the case where it does not.
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
         SELECT $2, x.service_id, false,
                COALESCE((SELECT max(sort_order) + 1 FROM center_services WHERE center_id = $2), 0)
           FROM unnest($1::uuid[]) AS x(service_id)
         ON CONFLICT (center_id, service_id) DO NOTHING`,
        [intoCentre, centerId]);
    }

    // Promoted to nationwide: every centre inherits it now, switched off.
    const intoCommon = toMove.filter((m) => m._scope === 'common').map((m) => m._id);
    if (intoCommon.length) {
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
         SELECT ctr.id, x.service_id, false,
                COALESCE((SELECT max(sort_order) + 1 FROM center_services WHERE center_id = ctr.id), 0)
           FROM unnest($1::uuid[]) AS x(service_id)
           CROSS JOIN centers ctr
          WHERE ctr.active
         ON CONFLICT (center_id, service_id) DO NOTHING`,
        [intoCommon]);
    }

    // A brand-new service needs a center_services row or it cannot be ordered or
    // switched on. Every insert in this transaction writes `false`; the single
    // pass at the end is the only thing that turns a row on, so there is one
    // rule and one place to read it.
    const newCommon = ins.filter((r) => r._scope === 'common').map((r) => r.code);
    const newOwn = ins.filter((r) => r._scope === 'center').map((r) => r.code);
    if (newCommon.length) {
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
         SELECT ctr.id, s.id, false,
                COALESCE((SELECT max(cs.sort_order) + 1
                            FROM center_services cs WHERE cs.center_id = ctr.id), 0)
                  + row_number() OVER (PARTITION BY ctr.id ORDER BY s.code)
           FROM services s CROSS JOIN centers ctr
          WHERE s.scope = 'common' AND s.code = ANY($1::text[]) AND ctr.active
         ON CONFLICT (center_id, service_id) DO NOTHING`, [newCommon]);
    }
    if (newOwn.length) {
      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
         SELECT $1, s.id, false,
                COALESCE((SELECT max(cs.sort_order) + 1
                            FROM center_services cs WHERE cs.center_id = $1), 0)
                  + row_number() OVER (ORDER BY s.code)
           FROM services s
          WHERE s.scope = 'center' AND s.center_id = $1 AND s.code = ANY($2::text[])
         ON CONFLICT (center_id, service_id) DO NOTHING`, [centerId, newOwn]);
    }

    // ---- 그리고 켭니다 — after every row exists, in one statement.
    //
    // 범위를 따라갑니다: nationwide content switches on at every centre that
    // inherits it, a centre's own content at that centre. That is what
    // inheritance means — a centre holding 45 inherited services with none of
    // them on has a kiosk that cannot answer anything.
    //
    // It reaches rows the file did not change, which is the point: re-importing
    // the same file is how a centre that already imported into the dark gets
    // out of it. The cost is that a service someone deliberately switched off
    // comes back on, so the preview counts them and the dashboard offers the
    // opt-out rather than deciding quietly.
    if (enable && applied.length) {
      await c.query(
        `UPDATE center_services cs
            SET enabled = true, updated_at = now()
           FROM services s
          WHERE cs.service_id = s.id
            AND s.code = ANY($1::text[])
            AND NOT cs.enabled
            AND (s.scope = 'common' OR (s.center_id = $2 AND cs.center_id = $2))`,
        [applied, centerId]);
    }
  });

  // A move, or any nationwide edit, reaches every centre — so every cached kiosk
  // copy is stale, not only this centre's.
  const wide = rows.some((r) => r._scope === 'common') || toMove.length > 0;  // incl. enabling
  wide ? kioskCache.bustAll() : kioskCache.bust(centerId);
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
    general_answers: (v) => !!v,
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
    `SELECT ieumi_name, voice_speaker, voice_speed, tone, greeting, roster_check_on,
            general_answers
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
