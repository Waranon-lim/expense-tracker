import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSignupOpen } from '../src/utils/signupSetting';

describe('isSignupOpen', () => {
  it('is open when not set or empty', () => {
    for (const raw of [undefined, '', '  ']) assert.equal(isSignupOpen(raw), true);
  });

  it('is open for true, 1, yes, on in any case', () => {
    for (const raw of ['true', 'TRUE', ' 1 ', 'Yes', 'on']) assert.equal(isSignupOpen(raw), true);
  });

  it('is closed for anything else', () => {
    for (const raw of ['false', 'False', '0', 'no', 'off', 'ture']) assert.equal(isSignupOpen(raw), false);
  });
});
