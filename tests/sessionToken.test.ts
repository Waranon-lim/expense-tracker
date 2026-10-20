import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { hashSessionToken, newSessionToken } from '../src/services/sessionToken';

describe('sessionToken', () => {
  it('makes a 43 character URL-safe token (32 random bytes)', () => {
    assert.match(newSessionToken(), /^[A-Za-z0-9_-]{43}$/);
  });

  it('makes a different token each time', () => {
    assert.notEqual(newSessionToken(), newSessionToken());
  });

  it('stores the SHA-256 hex of the token, never the token', () => {
    const token = newSessionToken();
    const stored = hashSessionToken(token);
    assert.equal(stored, crypto.createHash('sha256').update(token).digest('hex'));
    assert.notEqual(stored, token);
    assert.equal(hashSessionToken(token), stored); // same input, same output
  });
});
