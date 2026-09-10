// Migration runner — applies every db/migrations/*.sql not yet recorded, in
// filename order, each inside its own transaction.
const fs = require('fs');
const path = require('path');
const db = require('./index');

const DIR = path.join(__dirname, 'migrations');

async function main() {
  if (!db.DATABASE_URL) process.exit(1);

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const applied = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) {
      console.log(`  · ${f} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
    console.log(`  ✔ ${f}`);
    ran++;
  }

  console.log(ran ? `\nApplied ${ran} migration(s).` : '\nDatabase already up to date.');
  await db.pool.end();
}

main().catch((e) => {
  console.error('\n✖ Migration failed:', e.message);
  process.exit(1);
});
