// 일자리 데이터 — data.go.kr 한국노인인력개발원 노인일자리 API (SenuriService).
//
// What this source actually provides, measured rather than assumed:
//   · title, organisation, place ("서울 서초구"), application deadline and dates
//   · from the per-job detail call: address, contact name, contact PHONE,
//     minimum age, headcount
//   · NOT pay, and NOT working hours — no such field exists in either call.
//     Ieumi must therefore never state a wage or a shift for these postings.
//
// Three properties of the API drive the design (see db/migrations/003_jobs.sql):
// no region filter, 9-30 second responses, and a daily call limit. So postings
// are synced into Postgres in the background and queried from there.
const http = require('http');
const https = require('https');
const db = require('./db');
const env = require('./env');

const BASE = 'https://apis.data.go.kr/B552474/SenuriService';
const KEY = env.DATAGO_KEY || '';
const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';

// How far back to walk. The feed is newest-first; a few thousand rows reaches
// several months back, which is well beyond anything still open.
const SYNC_ROWS = Number(env.JOBS_SYNC_ROWS || 2000);
// Fetching a job's detail is a separate call, so it is done only for postings in
// a region one of our centres actually serves.
const MAX_DETAIL = Number(env.JOBS_MAX_DETAIL || 60);

// ---------------------------------------------------------------- transport
// Node's fetch ignores HTTPS_PROXY, and this API is reached through one on some
// networks, so the request goes out the same way server.js does it.
function httpGet(urlStr, timeoutMs = 60_000) {
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('data.go.kr timeout')), timeoutMs);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const fail = (e) => { clearTimeout(timer); reject(e); };
    const collect = (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
      res.on('error', fail);
    };

    if (PROXY) {
      const px = new URL(PROXY);
      const c = http.request({ host: px.hostname, port: px.port || 80, method: 'CONNECT',
        path: u.hostname + ':443', headers: { host: u.hostname + ':443' } });
      c.on('error', fail);
      c.on('connect', (pres, socket) => {
        if (pres.statusCode !== 200) return fail(new Error('proxy CONNECT ' + pres.statusCode));
        https.request({ socket, servername: u.hostname, host: u.hostname, agent: false,
          path: u.pathname + u.search, method: 'GET' }, collect).on('error', fail).end();
      });
      c.end();
    } else {
      https.get(urlStr, collect).on('error', fail);
    }
  });
}

// ---------------------------------------------------------------- parsing
// The API answers in XML. It is a flat, predictable shape, so a small reader
// beats adding a parser dependency.
const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#xD;/gi, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const field = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};
const items = (xml) => [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

const asDate = (yyyymmdd) => {
  const s = String(yyyymmdd || '').replace(/\D/g, '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

// "서울 서초구" → { sido: '서울', sigungu: '서초구' }
function splitPlace(place) {
  const parts = String(place || '').trim().split(/\s+/);
  return { sido: parts[0] || '', sigungu: parts.slice(1).join(' ') || '' };
}

// The list call leaves workPlcNm empty on a large share of postings — measured
// at 200 of 354 — but the detail call carries a full postal address. Recovering
// the region from it is the difference between a posting being findable and
// being dead weight.
//   "01002 서울특별시 강북구 삼양로173길 12" → 서울 / 강북구
function placeFromAddress(address) {
  const m = String(address || '')
    .match(/([가-힣]{2,4}(?:특별자치시|특별자치도|특별시|광역시|도))\s+([가-힣]{1,8}(?:시|군|구))/);
  if (!m) return null;
  const sido = normaliseSido(m[1]);
  if (!sido) return null;
  return { sido, sigungu: m[2], place: `${sido} ${m[2]}` };
}

function toJob(xml) {
  const place = field(xml, 'workPlcNm');
  const { sido, sigungu } = splitPlace(place);
  return {
    id: field(xml, 'jobId'),
    title: field(xml, 'recrtTitle'),
    org: field(xml, 'oranNm'),
    place, sido, sigungu,
    deadline: field(xml, 'deadline'),
    from_date: asDate(field(xml, 'frDd')),
    to_date: asDate(field(xml, 'toDd')),
    apply_method: field(xml, 'acptMthd'),
    source: field(xml, 'stmNm'),
  };
}

// ---------------------------------------------------------------- sync
async function fetchList(rows) {
  const xml = await httpGet(`${BASE}/getJobList?serviceKey=${KEY}&pageNo=1&numOfRows=${rows}`);
  const code = field(xml, 'resultCode');
  if (code && code !== '00') throw new Error(`data.go.kr ${code}: ${field(xml, 'resultMsg')}`);
  return items(xml).map(toJob).filter((j) => j.id && j.title);
}

async function fetchDetail(id) {
  const xml = await httpGet(`${BASE}/getJobInfo?serviceKey=${KEY}&id=${encodeURIComponent(id)}`);
  const body = items(xml)[0];
  if (!body) return null;
  return {
    address: field(body, 'plDetAddr'),
    contact_name: field(body, 'clerk'),
    contact_phone: field(body, 'clerkContt'),
    min_age: Number(field(body, 'age')) || null,
    headcount: Number(field(body, 'clltPrnnum')) || null,
    org: field(body, 'plbizNm') || undefined,
  };
}

/**
 * Refresh the stored postings.
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 */
async function sync({ log = () => {} } = {}) {
  if (!KEY) throw new Error('DATAGO_KEY is not set — see .env.example');

  await db.query('UPDATE job_sync_state SET started_at = now(), error = NULL WHERE id = 1');
  try {
    log(`  목록 요청 중… (${SYNC_ROWS}건, 30초쯤 걸립니다)`);
    const list = await fetchList(SYNC_ROWS);
    log(`  ${list.length}건 수신`);

    // Keep only what a senior could still apply to.
    const today = new Date().toISOString().slice(0, 10);
    const open = list.filter((j) => !j.to_date || j.to_date >= today);
    log(`  그중 접수 가능 ${open.length}건`);

    if (open.length) {
      await db.query(
        `INSERT INTO jobs (id, title, org, place, sido, sigungu, deadline,
                           from_date, to_date, apply_method, source)
         SELECT * FROM unnest(
           $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
           $7::text[], $8::date[], $9::date[], $10::text[], $11::text[]
         ) AS t(id, title, org, place, sido, sigungu, deadline, from_date, to_date, apply_method, source)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title, org = excluded.org, deadline = excluded.deadline,
           from_date = excluded.from_date, to_date = excluded.to_date,
           apply_method = excluded.apply_method, source = excluded.source,
           -- The feed leaves the region blank on many postings. Only overwrite
           -- when it actually says something, or every sync would wipe the
           -- region the address backfill recovered and pay to find it again.
           place   = CASE WHEN excluded.place   <> '' THEN excluded.place   ELSE jobs.place   END,
           sido    = CASE WHEN excluded.sido    <> '' THEN excluded.sido    ELSE jobs.sido    END,
           sigungu = CASE WHEN excluded.sigungu <> '' THEN excluded.sigungu ELSE jobs.sigungu END,
           -- A region the feed states is the work location and is trusted for
           -- matching; anything else keeps whatever the backfill decided.
           region_source = CASE WHEN excluded.sido <> '' THEN 'api' ELSE jobs.region_source END,
           synced_at = now()`,
        [
          open.map((j) => j.id), open.map((j) => j.title), open.map((j) => j.org),
          open.map((j) => j.place), open.map((j) => j.sido), open.map((j) => j.sigungu),
          open.map((j) => j.deadline), open.map((j) => j.from_date), open.map((j) => j.to_date),
          open.map((j) => j.apply_method), open.map((j) => j.source),
        ]);
    }

    // Details (address, phone) cost one call each, so fetch them only where a
    // centre could actually offer the posting — and only for what is missing.
    const regions = await db.all(
      `SELECT DISTINCT split_part(region, ' ', 1) AS sido FROM centers WHERE region <> ''`);
    const sidoList = regions.map((r) => normaliseSido(r.sido)).filter(Boolean);

    // Two groups need a detail call: postings already known to be in one of our
    // regions, and postings whose region is unknown — those are only findable
    // once the address tells us where they are, so leaving them out would keep
    // them invisible forever.
    let detailed = 0, located = 0;
    const need = await db.all(
      `SELECT id FROM jobs
        WHERE has_detail = false
          AND (sido = ANY($1::text[]) OR sido = '')
        ORDER BY (sido = '') ASC, to_date DESC NULLS LAST
        LIMIT $2`, [sidoList.length ? sidoList : [''], MAX_DETAIL]);
    log(`  상세 정보 필요 ${need.length}건 (연락처·주소·지역)`);

    for (const { id } of need) {
      try {
        const d = await fetchDetail(id);
        if (!d) continue;
        const place = placeFromAddress(d.address);
        if (place) located++;
        await db.query(
          `UPDATE jobs
              SET address = $2, contact_name = $3, contact_phone = $4,
                  min_age = $5, headcount = $6,
                  org = COALESCE(NULLIF($7, ''), org),
                  place   = CASE WHEN place = ''   THEN $8  ELSE place   END,
                  sido    = CASE WHEN sido = ''    THEN $9  ELSE sido    END,
                  sigungu = CASE WHEN sigungu = '' THEN $10 ELSE sigungu END,
                  -- Mark a region recovered from the employer's address as such:
                  -- it is not necessarily where the work is (migration 004).
                  region_source = CASE WHEN sido = '' AND $9 <> '' THEN 'address' ELSE region_source END,
                  has_detail = true
            WHERE id = $1`,
          [id, d.address, d.contact_name, d.contact_phone, d.min_age, d.headcount, d.org || '',
           place ? place.place : '', place ? place.sido : '', place ? place.sigungu : '']);
        detailed++;
      } catch (e) { log(`    · ${id} 상세 실패: ${e.message}`); }
    }
    if (located) log(`  주소에서 지역을 알아낸 공고 ${located}건`);

    // Closed postings are kept for a while — a senior may ring about one they
    // heard yesterday, and the staff dashboard's history refers to them — then
    // dropped, so an unattended daily sync does not grow the table forever.
    const pruned = await db.query(
      `DELETE FROM jobs WHERE to_date IS NOT NULL AND to_date < current_date - INTERVAL '30 days'`);
    if (pruned.rowCount) log(`  마감된 지 오래된 공고 ${pruned.rowCount}건 정리`);

    await db.query(
      `UPDATE job_sync_state
          SET finished_at = now(), scanned = $1, stored = $2, detailed = $3, error = NULL
        WHERE id = 1`,
      [list.length, open.length, detailed]);

    return { scanned: list.length, stored: open.length, detailed, pruned: pruned.rowCount };
  } catch (e) {
    await db.query('UPDATE job_sync_state SET finished_at = now(), error = $1 WHERE id = 1',
      [String(e.message || e)]).catch(() => {});
    throw e;
  }
}

// Centre regions read "서울특별시 서초구"; the job feed says "서울 서초구".
function normaliseSido(s) {
  return String(s || '')
    .replace(/특별자치시|특별자치도|특별시|광역시|self/g, '')
    .replace(/^(강원|전북|제주)도?$/, '$1')
    .replace(/도$/, '')
    .trim();
}

/**
 * 복지관 지역에 맞는 일자리 — the postings to offer at one centre.
 *
 * Tries the centre's own district first, then widens to its province. The
 * client's own note records that Seocho had zero live postings at one point, so
 * widening is the normal case, not an edge case — and the prompt already tells
 * Ieumi to say so honestly.
 */
async function forCenterRegion(region, limit = 6) {
  const parts = String(region || '').trim().split(/\s+/);
  const sido = normaliseSido(parts[0]);
  const sigungu = parts.slice(1).join(' ');

  // to_date is formatted in SQL: the driver hands back a JS Date at local
  // midnight, which shifts the day either side of UTC when it is stringified.
  // Only regions the feed itself stated are used to place a job in a district.
  // A region inferred from the employer's address can be somewhere else entirely,
  // and Ieumi reads the place aloud to someone who may travel to it (migration 004).
  // Still open, as of today. A posting is only filtered for openness when it is
  // stored, so without this an expired one keeps being offered every day after
  // its deadline — which matters most once the sync runs unattended.
  const pick = (where, params) => db.all(
    `SELECT id, title, org, place, deadline, apply_method,
            to_char(to_date, 'YYYY-MM-DD') AS to_date,
            address, contact_phone, min_age, headcount
       FROM jobs
      WHERE region_source = 'api'
        AND (to_date IS NULL OR to_date >= current_date)
        AND ${where}
      ORDER BY has_detail DESC, to_date DESC NULLS LAST
      LIMIT ${Number(limit)}`, params);

  if (sido && sigungu) {
    const local = await pick('sido = $1 AND sigungu = $2', [sido, sigungu]);
    if (local.length) return { jobs: local, scope: 'sigungu', region: `${sido} ${sigungu}` };
  }
  if (sido) {
    const wide = await pick('sido = $1', [sido]);
    if (wide.length) return { jobs: wide, scope: 'sido', region: sido };
  }
  return { jobs: [], scope: 'none', region: region || '' };
}

/**
 * The shape the conversation prompt expects (see prompt.js jobsText).
 *
 * `place` (workPlcNm) is where the work is; `address` (plDetAddr) is the
 * employer's own office and is frequently somewhere else entirely — one posting
 * has its work in 서초구 and its employer in 고양시. They are labelled
 * differently on purpose: reading the office address out as the workplace sends
 * a senior to the wrong city.
 */
// `id` rides along so a later /sms can re-read the posting from the database
// rather than trusting a copy the browser hands back. jobsText drops it before
// the prompt is built, so it costs nothing in tokens and is never read aloud.
const toPromptJob = (j) => ({
  id: j.id,
  gu: j.place,
  job: j.title,
  org: j.org,
  age: j.min_age ? `만 ${j.min_age}세 이상` : '',
  to: j.to_date ? String(j.to_date).slice(0, 10) + '까지' : j.deadline,
  orgAddr: j.address,
  tel: j.contact_phone,
  apply: j.apply_method,
});

const status = () => db.one('SELECT * FROM job_sync_state WHERE id = 1');

/**
 * One posting, by id — the source for a text message.
 *
 * The kiosk used to hand the whole posting back for /sms to format, which meant
 * the body of a real text message was whatever the browser said it was. Reading
 * it here instead costs one indexed lookup and makes an invented posting
 * unsendable: an id that is not in the table produces no message.
 */
const byId = (id) => db.one(
  `SELECT id, title, org, place, deadline, apply_method,
          to_char(to_date, 'YYYY-MM-DD') AS to_date,
          address, contact_phone, min_age, headcount
     FROM jobs WHERE id = $1`, [String(id || '')]);

module.exports = {
  sync, forCenterRegion, toPromptJob, status, byId,
  normaliseSido, splitPlace, placeFromAddress, fetchList, KEY,
};
