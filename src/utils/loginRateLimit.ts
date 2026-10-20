interface Entry {
  count: number;
  firstAt: number;
}

export interface LoginRateLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
  maxEntries?: number;
}

// Counts failed logins per key (email plus address) inside a fixed window that
// starts at the first failure. It lives in memory, so it resets when the
// server restarts. That is enough to stop quick password guessing.
export function createLoginRateLimiter({
  maxFailures = 5,
  windowMs = 15 * 60 * 1000,
  now = Date.now,
  maxEntries = 10_000,
}: LoginRateLimiterOptions = {}) {
  const entries = new Map<string, Entry>();

  function current(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry && now() - entry.firstAt > windowMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    isBlocked(key: string): boolean {
      const entry = current(key);
      return entry !== undefined && entry.count >= maxFailures;
    },
    recordFailure(key: string): void {
      // Keep the map from growing without limit: drop every expired window.
      if (entries.size >= maxEntries) {
        for (const [k, e] of entries) {
          if (now() - e.firstAt > windowMs) entries.delete(k);
        }
      }
      const entry = current(key);
      if (entry) entry.count += 1;
      else entries.set(key, { count: 1, firstAt: now() });
    },
    clear(key: string): void {
      entries.delete(key);
    },
    size(): number {
      return entries.size;
    },
  };
}

export const loginRateLimiter = createLoginRateLimiter();
