import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildClearCookie, buildSessionCookie, parseCookies } from '../src/utils/cookies';

describe('parseCookies', () => {
  it('reads several cookies from one header', () => {
    assert.deepEqual(parseCookies('a=1; sid=abc; b=2'), { a: '1', sid: 'abc', b: '2' });
  });

  it('returns an empty object when there is no header', () => {
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('buildSessionCookie', () => {
  it('sets HttpOnly, SameSite=Lax, Path and Max-Age when remember me is on', () => {
    const cookie = buildSessionCookie('tok', { maxAgeSeconds: 2592000, secure: false });
    assert.equal(cookie, 'sid=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000');
  });

  it('has no Max-Age without remember me, so it ends with the browser session', () => {
    const cookie = buildSessionCookie('tok', { secure: false });
    assert.equal(cookie, 'sid=tok; Path=/; HttpOnly; SameSite=Lax');
  });

  it('adds Secure in production', () => {
    assert.match(buildSessionCookie('tok', { secure: true }), /; Secure$/);
  });
});

describe('buildClearCookie', () => {
  it('empties the cookie and expires it at once', () => {
    assert.equal(buildClearCookie(false), 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
});
