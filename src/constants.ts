// This is a single-user demo app — every ingested transaction (mock bank
// webhook or the dashboard's "simulate" button) belongs to the same user,
// and the dashboard only ever shows this user's expenses.
export const DEMO_USER_ID = 'usr_demo_1';

// Read lazily (not at import time): dotenv.config() runs in server.ts AFTER
// the imports are evaluated, so a module-level read would miss .env values.
export function categorizationTimeoutMs(): number {
  return process.env.CATEGORIZATION_TIMEOUT_MS ? Number(process.env.CATEGORIZATION_TIMEOUT_MS) : 30_000;
}
