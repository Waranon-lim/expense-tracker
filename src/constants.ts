// Read lazily (not at import time): dotenv.config() runs in server.ts AFTER
// the imports are evaluated, so a module-level read would miss .env values.
export function categorizationTimeoutMs(): number {
  return process.env.CATEGORIZATION_TIMEOUT_MS ? Number(process.env.CATEGORIZATION_TIMEOUT_MS) : 30_000;
}
