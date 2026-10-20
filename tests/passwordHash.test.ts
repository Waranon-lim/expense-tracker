import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from '../src/services/passwordHash';

describe('passwordHash', () => {
  it('stores the hash as scrypt$salt$hash', async () => {
    const stored = await hashPassword('correct horse battery');
    const parts = stored.split('$');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'scrypt');
    assert.match(parts[1], /^[0-9a-f]{32}$/); // 16 random bytes
    assert.match(parts[2], /^[0-9a-f]{128}$/); // 64 byte hash
  });

  it('accepts the right password', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse battery', stored), true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    assert.equal(await verifyPassword('correct horse batterz', stored), false);
  });

  it('gives a different hash each time for the same password', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');
    assert.notEqual(first, second);
    assert.equal(await verifyPassword('same password', first), true);
    assert.equal(await verifyPassword('same password', second), true);
  });

  it('returns false, not an error, for a malformed stored hash', async () => {
    assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
    assert.equal(await verifyPassword('anything', 'scrypt$zz$zz'), false);
  });
});
