import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoginRateLimiter } from '../src/utils/loginRateLimit';

const WINDOW = 15 * 60 * 1000;

describe('loginRateLimiter', () => {
  it('does not block before 5 failures', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 4; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('blocks after 5 failures', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('a'), true);
  });

  it('unblocks after 15 minutes', () => {
    let time = 0;
    const limiter = createLoginRateLimiter({ now: () => time });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    time = WINDOW - 1;
    assert.equal(limiter.isBlocked('a'), true);
    time = WINDOW + 1;
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('clears the count after a successful login', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    limiter.clear('a');
    assert.equal(limiter.isBlocked('a'), false);
  });

  it('counts each key on its own', () => {
    const limiter = createLoginRateLimiter({ now: () => 0 });
    for (let i = 0; i < 5; i++) limiter.recordFailure('a');
    assert.equal(limiter.isBlocked('b'), false);
  });
});
