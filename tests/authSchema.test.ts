import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LoginSchema, SignupSchema } from '../src/validation/authSchema';

describe('SignupSchema', () => {
  it('trims and lower-cases the email, and defaults remember to false', () => {
    const parsed = SignupSchema.parse({ email: '  Me@Example.COM ', password: 'longenough' });
    assert.deepEqual(parsed, { email: 'me@example.com', password: 'longenough', remember: false });
  });

  it('accepts remember true', () => {
    assert.equal(SignupSchema.parse({ email: 'a@b.co', password: 'longenough', remember: true }).remember, true);
  });

  it('rejects an invalid email', () => {
    assert.equal(SignupSchema.safeParse({ email: 'not-an-email', password: 'longenough' }).success, false);
  });

  it('rejects a password shorter than 8 characters', () => {
    assert.equal(SignupSchema.safeParse({ email: 'a@b.co', password: '1234567' }).success, false);
  });

  it('rejects a password longer than 200 characters', () => {
    assert.equal(SignupSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(201) }).success, false);
  });
});

describe('LoginSchema', () => {
  it('has the same shape as sign-up', () => {
    const parsed = LoginSchema.parse({ email: 'A@B.co', password: 'longenough', remember: true });
    assert.deepEqual(parsed, { email: 'a@b.co', password: 'longenough', remember: true });
  });
});
