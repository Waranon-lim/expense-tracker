import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// The first account takes this id, so every row the old single-user app wrote
// (expenses, learned rules, phone alert subscriptions, categories) already
// belongs to it and nothing has to move.
export const FIRST_USER_ID = 'usr_demo_1';

const DEFAULT_CATEGORIES = [
  { name: 'Food', color: '#16a34a' },
  { name: 'Transport', color: '#2563eb' },
  { name: 'Other', color: '#64748b' },
] as const;

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
}

export async function countUsers(db: Pool): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS count FROM users');
  return result.rows[0].count as number;
}

export async function findUserByEmail(db: Pool, email: string): Promise<UserRow | null> {
  const result = await db.query('SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)', [email]);
  return (result.rows[0] as UserRow | undefined) ?? null;
}

export async function userExists(db: Pool, id: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

async function seedDefaultCategories(client: PoolClient, userId: string): Promise<void> {
  for (const { name, color } of DEFAULT_CATEGORIES) {
    await client.query(
      `INSERT INTO categories (user_id, name, color, is_default)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id, lower(trim(name))) DO NOTHING`,
      [userId, name, color],
    );
  }
}

// Returns null when the email is already taken. The advisory lock makes two
// sign-ups at the same moment take turns, so only one can become the first user.
export async function createUser(
  pool: Pool,
  email: string,
  passwordHash: string,
): Promise<{ id: string; email: string } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(8008)');
    const existing = await client.query('SELECT count(*)::int AS count FROM users');
    const id = existing.rows[0].count === 0 ? FIRST_USER_ID : `usr_${crypto.randomBytes(4).toString('hex')}`;
    await client.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [id, email, passwordHash]);
    await seedDefaultCategories(client, id);
    await client.query('COMMIT');
    return { id, email };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 23505 = unique violation. Only the email index means "email taken".
    if ((err as { code?: string; constraint?: string }).code === '23505' &&
        (err as { constraint?: string }).constraint === 'users_email_lower_idx') {
      return null;
    }
    throw err;
  } finally {
    client.release();
  }
}
