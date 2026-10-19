import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveManualExpenseDate } from '../src/utils/bangkokTime';
import { ManualExpenseRequestSchema } from '../src/validation/manualExpenseSchema';

// 2026-10-19 17:00 in Bangkok (UTC+7)
const NOW = new Date('2026-10-19T10:00:00Z');

describe('resolveManualExpenseDate', () => {
  it('returns now when no date is given', () => {
    assert.equal(resolveManualExpenseDate(undefined, NOW)?.toISOString(), NOW.toISOString());
  });

  it('returns now when the date is today in Bangkok', () => {
    assert.equal(resolveManualExpenseDate('2026-10-19', NOW)?.toISOString(), NOW.toISOString());
  });

  it('uses the Bangkok calendar day, not the UTC day', () => {
    // 2026-10-19 18:00 UTC is already 2026-10-20 01:00 in Bangkok
    const lateUtc = new Date('2026-10-19T18:00:00Z');
    assert.equal(resolveManualExpenseDate('2026-10-20', lateUtc)?.toISOString(), lateUtc.toISOString());
    assert.equal(resolveManualExpenseDate('2026-10-19', lateUtc)?.toISOString(), '2026-10-19T05:00:00.000Z');
  });

  it('stores a past day at 12:00 Bangkok time', () => {
    assert.equal(resolveManualExpenseDate('2026-10-18', NOW)?.toISOString(), '2026-10-18T05:00:00.000Z');
  });

  it('returns null for a future day', () => {
    assert.equal(resolveManualExpenseDate('2026-10-20', NOW), null);
  });
});

describe('ManualExpenseRequestSchema', () => {
  it('accepts a minimal body, trims text and defaults the currency to THB', () => {
    const parsed = ManualExpenseRequestSchema.parse({ merchant: '  Som Tam  ', amount: 65, category: ' Food ' });
    assert.deepEqual(parsed, { merchant: 'Som Tam', amount: 65, category: 'Food', currency: 'THB' });
  });

  it('accepts a date, a lower-case currency and 2 decimal places', () => {
    const parsed = ManualExpenseRequestSchema.parse({
      merchant: 'Cafe',
      amount: 12.5,
      category: 'Food',
      date: '2026-10-01',
      currency: 'usd',
    });
    assert.equal(parsed.date, '2026-10-01');
    assert.equal(parsed.currency, 'USD');
  });

  const base = { merchant: 'Cafe', amount: 10, category: 'Food' };
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['zero amount', { ...base, amount: 0 }],
    ['negative amount', { ...base, amount: -5 }],
    ['3 decimal places', { ...base, amount: 10.123 }],
    ['amount sent as text', { ...base, amount: '10' }],
    ['amount too large', { ...base, amount: 10_000_001 }],
    ['empty merchant', { ...base, merchant: '   ' }],
    ['empty category', { ...base, category: '' }],
    ['category over 40 characters', { ...base, category: 'x'.repeat(41) }],
    ['date in the wrong format', { ...base, date: '19/10/2026' }],
    ['date that does not exist', { ...base, date: '2026-02-31' }],
    ['currency of the wrong length', { ...base, currency: 'BAHT' }],
  ];
  for (const [name, body] of invalid) {
    it(`rejects ${name}`, () => {
      assert.equal(ManualExpenseRequestSchema.safeParse(body).success, false);
    });
  }
});
