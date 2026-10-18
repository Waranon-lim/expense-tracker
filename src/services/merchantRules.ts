import type { Pool, PoolClient } from 'pg';
import { mapBankCategory } from './categoryMapping';

export interface Suggestion {
  category: string;
  source: 'learned' | 'mapping' | 'default';
}

// Banks send the same shop under slightly different strings ("7-ELEVEN",
// "7-Eleven  ", "STARBUCKS STORE 101" vs "...102"). Normalizing makes them
// share one rule: lowercase, punctuation -> spaces, and drop trailing
// store-number tokens (but never the only token, so "7 eleven" keeps its 7).
export function normalizeMerchant(merchant: string): string {
  const tokens = merchant
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && /^\d+$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

// Called inside finalizeCategory's transaction whenever the USER picks a
// category, so the newest tap always wins ("I changed my mind about Grab").
export async function learnMerchantRule(
  client: PoolClient,
  userId: string,
  merchant: string,
  category: string,
): Promise<void> {
  const key = normalizeMerchant(merchant);
  if (!key) return;
  await client.query(
    `INSERT INTO merchant_rules (user_id, merchant_key, category)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, merchant_key) DO UPDATE SET category = EXCLUDED.category, updated_at = now()`,
    [userId, key, category],
  );
}

export async function loadMerchantRules(db: Pool, userId: string): Promise<Map<string, string>> {
  const { rows } = await db.query('SELECT merchant_key, category FROM merchant_rules WHERE user_id = $1', [userId]);
  return new Map(rows.map((r) => [r.merchant_key as string, r.category as string]));
}

// What we think the category is: a learned rule beats the built-in guess.
export function suggestCategory(
  rules: Map<string, string>,
  merchant: string,
  bankCategory: string,
): Suggestion {
  const learned = rules.get(normalizeMerchant(merchant));
  if (learned) return { category: learned, source: 'learned' };
  return mapBankCategory(bankCategory, merchant);
}
