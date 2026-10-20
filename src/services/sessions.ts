import type { Pool } from 'pg';
import { hashSessionToken, newSessionToken } from './sessionToken';

export const REMEMBER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SHORT_LIFETIME_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface NewSession {
  token: string;
  /** Set only for "remember me". Without it the cookie ends with the browser session. */
  maxAgeSeconds?: number;
}

export async function createSession(db: Pool, userId: string, remember: boolean): Promise<NewSession> {
  // Old sessions are removed here, at each login, so no separate cleanup job is needed.
  await db.query('DELETE FROM sessions WHERE expires_at < now()');

  const token = newSessionToken();
  const lifetimeMs = remember ? REMEMBER_LIFETIME_MS : SHORT_LIFETIME_MS;
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3::double precision))`,
    [hashSessionToken(token), userId, lifetimeMs / 1000],
  );
  return { token, maxAgeSeconds: remember ? REMEMBER_LIFETIME_MS / 1000 : undefined };
}

export async function findSessionUser(db: Pool, token: string): Promise<{ id: string; email: string } | null> {
  const result = await db.query(
    `SELECT u.id, u.email
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)],
  );
  return (result.rows[0] as { id: string; email: string } | undefined) ?? null;
}

export async function deleteSession(db: Pool, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken(token)]);
}
