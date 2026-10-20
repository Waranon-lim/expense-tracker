import crypto from 'node:crypto';

// The browser holds the token. The database holds only its hash, so a leaked
// database does not give out working sessions. SHA-256 is enough here (not
// scrypt) because the token is 32 random bytes, not a guessable password.
export function newSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
