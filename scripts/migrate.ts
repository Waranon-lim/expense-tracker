import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../src/db/pool';

async function runMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`Running migration: ${file}`);
    await pool.query(sql);
  }

  console.log('All migrations applied.');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
