/**
 * Shared Redis client factory used by both routing and Injection layers.
 *
 * One ioredis instance per process; lazy-connect with retry.
 * Callers receive `Redis | null` — null means Redis is unavailable
 * and they should use their SQLite / Null fallback.
 */
import Redis from "ioredis";
import type { RedisConfig } from "../types.js";

let _client: Redis | null = null;
let _failed = false;

export function getRedisClient(config: RedisConfig): Redis | null {
  if (_client) return _client;
  if (_failed || !config.enabled) return null;

  try {
    if (config.url) {
      _client = new Redis(config.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 3) return null;
          return Math.min(times * 500, 2000);
        },
      });
    } else {
      _client = new Redis({
        host: config.host || "127.0.0.1",
        port: config.port || 6379,
        password: config.password || undefined,
        db: config.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times: number) => {
          if (times > 3) return null;
          return Math.min(times * 500, 2000);
        },
      });
    }

    _client.on("error", () => {
      _failed = true;
    });

    // Fire connect — won't throw thanks to lazyConnect
    _client.connect().catch(() => {
      _failed = true;
      _client = null;
    });

    return _client;
  } catch {
    _failed = true;
    return null;
  }
}

/** Reset singleton (tests only). */
export function __resetRedisClientForTests(): void {
  if (_client) {
    try { _client.disconnect(); } catch { /* ignore */ }
  }
  _client = null;
  _failed = false;
}
