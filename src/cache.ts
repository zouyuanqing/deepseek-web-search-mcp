import { createHash } from "node:crypto";

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface TtlLruCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export class TtlLruCache<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private readonly now: () => number;

  constructor(private readonly options: TtlLruCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.options.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.options.ttlMs,
    });
    this.pruneExpired();
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

export function hashCacheKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizeCacheQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}
