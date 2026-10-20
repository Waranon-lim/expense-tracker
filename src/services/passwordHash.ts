import crypto from 'node:crypto';
import { promisify } from 'node:util';

// scrypt is a password hash that is slow on purpose and needs a lot of memory,
// so guessing passwords from a leaked hash is expensive. It ships with Node.
const scrypt = promisify(crypto.scrypt) as unknown as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

// The salt is random for every hash, so two users with the same password get
// different stored strings. The salt is kept inside the string, because the
// check needs it again.
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_LENGTH) return false;
  const actual = await scrypt(password, salt, KEY_LENGTH);
  // timingSafeEqual takes the same time however many bytes match.
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;

// Login for an email that does not exist still spends the same time hashing,
// so the response time does not reveal which emails have accounts.
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(password, await dummyHash);
}
