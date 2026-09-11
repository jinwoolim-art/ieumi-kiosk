// Seed the first tenant and the master content catalog.
// Safe to re-run: every insert is a no-op when the row already exists.
const crypto = require('crypto');
const path = require('path');
const db = require('./index');
const env = require('../env');
const { hashPassword } = require('../auth');

const SERVICES = require('./services.seed.json');
const REQUESTS = require('./requests.seed.json');

// The catalog as it stands today is one flat list. Anything naming 서초 (Seocho)
// or 서리풀 (Seoripul, a Seocho programme) is genuinely local to that center;
// the rest is nationwide-common content owned by master. This is §3-2 in
// practice — a center inherits the common set and adds its own on top.
const isSeochoLocal = (s) => /서초|서리풀/.test(`${s.desc}${s.kw}${s.sub}`);

const CENTER = {
  slug: env.SEED_CENTER_SLUG || 'seocho',
  name: env.SEED_CENTER_NAME || '서초 어르신 행복이음 센터',
  region: '서울특별시 서초구',
};

// Dummy numbers — the repository is public (PROJECT.md §9).
const MEMBERS = [
  ['김순자', '01012343456'], ['박영수', '01023454567'], ['이말순', '01034565678'],
  ['최복동', '01045676789'], ['김철수', '01078901234'], ['한복례', '01099998888'],
];

const newPassword = () => crypto.randomBytes(9).toString('base64url');

// The demo script runs 10:24 → 12:07. Convert each call's clock time into
// "minutes before the latest one", so the whole set can be anchored to now().
const asMinutes = (t) => {
  const [h, m] = String(t || '12:00').split(':').map(Number);
  return h * 60 + m;
};
const LATEST = Math.max(...REQUESTS.map((r) => asMinutes(r.time)));
const minutesAgo = (r) => LATEST - asMinutes(r.time);

/**
 * Seed the first tenant and the catalog. Takes the database handle as an
 * argument so the test harness can run the real seed against its own instance.
 * @returns {Promise<Array>} the accounts created by this run (with passwords)
 */
async function seed(db) {
  const created = [];

  await db.tx(async (c) => {
    // ---------------------------------------------------------- center
    const kioskToken = crypto.randomBytes(24).toString('base64url');
    await c.query(
      `INSERT INTO centers (slug, name, region, kiosk_token)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [CENTER.slug, CENTER.name, CENTER.region, kioskToken],
    );
    const center = (await c.query('SELECT * FROM centers WHERE slug = $1', [CENTER.slug])).rows[0];
    console.log(`  ✔ center  ${center.name}  (${center.slug})`);

    await c.query(
      `INSERT INTO center_settings (center_id, greeting)
            VALUES ($1, $2)
       ON CONFLICT (center_id) DO NOTHING`,
      [center.id, '안녕하세요 어르신, 저는 이음이예요. 무엇을 도와드릴까요?'],
    );

    // ---------------------------------------------------------- users (3 tiers, §3-3)
    const accounts = [
      { role: 'master',       username: 'master', name: '플레이포 운영자',  center_id: null,      envKey: 'SEED_MASTER_PASSWORD' },
      { role: 'center_admin', username: 'seocho-admin', name: '서초 관리자', center_id: center.id, envKey: 'SEED_ADMIN_PASSWORD' },
      { role: 'staff',        username: 'seocho-staff', name: '서초 담당자', center_id: center.id, envKey: 'SEED_STAFF_PASSWORD' },
    ];

    for (const a of accounts) {
      const exists = (await c.query('SELECT 1 FROM users WHERE username = $1', [a.username])).rowCount;
      if (exists) {
        console.log(`  · user    ${a.username} (already exists, password unchanged)`);
        continue;
      }
      const password = env[a.envKey] || newPassword();
      await c.query(
        `INSERT INTO users (center_id, role, username, password_hash, name)
              VALUES ($1, $2, $3, $4, $5)`,
        [a.center_id, a.role, a.username, hashPassword(password), a.name],
      );
      created.push({ ...a, password, fromEnv: !!env[a.envKey] });
      console.log(`  ✔ user    ${a.username}  (${a.role})`);
    }

    // ---------------------------------------------------------- services catalog (§3-2)
    let common = 0, local = 0, order = 0;
    for (const s of SERVICES) {
      const mine = isSeochoLocal(s);
      const scope = mine ? 'center' : 'common';
      const centerId = mine ? center.id : null;

      await c.query(
        `INSERT INTO services (code, scope, center_id, category, sub, description, keywords,
                               org, link, update_method)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [s.id, scope, centerId, s.cat, s.sub, s.desc, s.kw,
         s.org || '', s.link || '', s.method || 'manual'],
      );
      mine ? local++ : common++;

      // Give the center a row per service so ordering survives; disabled by
      // default, exactly like the planning tool behaves today.
      const svc = (await c.query(
        `SELECT id FROM services
          WHERE code = $1 AND scope = $2 AND center_id IS NOT DISTINCT FROM $3`,
        [s.id, scope, centerId],
      )).rows[0];

      await c.query(
        `INSERT INTO center_services (center_id, service_id, enabled, sort_order)
              VALUES ($1, $2, false, $3)
         ON CONFLICT (center_id, service_id) DO NOTHING`,
        [center.id, svc.id, order++],
      );
    }
    console.log(`  ✔ services ${common} common (master) + ${local} center-specific (${center.slug})`);

    // ---------------------------------------------------------- roster
    for (const [name, phone] of MEMBERS) {
      await c.query(
        `INSERT INTO members (center_id, name, phone)
              VALUES ($1, $2, $3)
         ON CONFLICT (center_id, phone) DO NOTHING`,
        [center.id, name, phone],
      );
    }
    console.log(`  ✔ members  ${MEMBERS.length} (dummy numbers)`);

    // ---------------------------------------------------------- demo requests
    const already = (await c.query('SELECT count(*)::int AS n FROM requests WHERE center_id = $1', [center.id])).rows[0].n;
    if (already) {
      console.log(`  · requests ${already} already present, skipped`);
    } else {
      for (const r of REQUESTS) {
        const member = r.phone
          ? (await c.query('SELECT id FROM members WHERE center_id = $1 AND phone = $2', [center.id, r.phone])).rows[0]
          : null;
        // Each demo call gets its own timestamp, counted back from now so the
        // set always reads as "earlier today" whatever timezone it is opened in,
        // while keeping the spacing of the original demo script.
        //
        // Two reasons this is not just now(): inside a transaction now() is the
        // transaction's start time, so every row would land on an identical
        // timestamp and the dashboard's ordering would be arbitrary; and a fixed
        // wall-clock time drifts by the viewer's UTC offset.
        await c.query(
          `INSERT INTO requests
             (center_id, member_id, caller_name, caller_phone, category, summary, transcript, chips, urgent, followup, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
                   now() - make_interval(mins => $11))`,
          [center.id, member?.id || null, r.name, r.phone || '', r.cat, r.summary,
           JSON.stringify(r.transcript), JSON.stringify(r.chips), r.urgent, r.followup,
           minutesAgo(r)],
        );
      }
      console.log(`  ✔ requests ${REQUESTS.length} demo records`);
    }

    // ---------------------------------------------------------- kiosk URL
    console.log(`\n  Kiosk URL for this center:\n    /이음이-키오스크-LIVE.html?c=${center.kiosk_token}`);
  });

  return created;
}

async function main() {
  if (!db.DATABASE_URL) process.exit(1);
  const created = await seed(db);

  if (created.length) {
    const generated = created.filter((a) => !a.fromEnv);
    console.log('\n  ── Accounts created ─────────────────────────────');
    for (const a of created) {
      console.log(`   ${a.role.padEnd(13)} ${a.username.padEnd(14)} ${a.fromEnv ? '(password from .env)' : a.password}`);
    }
    if (generated.length) {
      console.log('\n  These passwords are shown once and are not recoverable.');
      console.log('  Save them now, and change them before any real deployment.');
    }
    console.log('  ─────────────────────────────────────────────────');
  }

  console.log('\nSeed complete.');
  await db.pool.end();
}

module.exports = { seed };

if (require.main === module) {
  main().catch((e) => {
    console.error('\n✖ Seed failed:', e.message);
    process.exit(1);
  });
}
