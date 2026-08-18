/**
 * RedisSessionStore — Redis-backed session storage for the private extension.
 *
 * The host treats the stored state as an opaque JSON blob and never inspects
 * its shape. It only provides transport-level primitives:
 * - JSON serialization of an opaque state object
 * - Automatic TTL via Redis SETEX
 * - Graceful degradation: returns null on connection errors (passthrough behavior)
 * - Key prefix isolation for multi-tenant Redis instances
 * - An atomic per-session sequence counter (incrTurnSeq)
 */

import Redis from "ioredis";
import type { RedisConfig } from "./types.js";
import { log } from "./report/log.js";

/**
 * Generic session store contract. State is opaque (`unknown`) to the host —
 * only the extension understands its structure.
 */
export interface SessionStore {
  get(key: string): Promise<unknown | null>;
  set(key: string, state: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  incrTurnSeq(key: string): Promise<number>;
}

export class RedisSessionStore implements SessionStore {
  private client: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private connected = false;

  constructor(config: RedisConfig) {
    this.keyPrefix = config.keyPrefix || "cg:sess:";
    this.ttlSeconds = config.ttlSeconds || 1800;

    if (config.url) {
      this.client = new Redis(config.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) return null; // Stop retrying after 3 attempts
          return Math.min(times * 500, 2000);
        },
      });
    } else {
      this.client = new Redis({
        host: config.host || "127.0.0.1",
        port: config.port || 6379,
        password: config.password || undefined,
        db: config.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 500, 2000);
        },
      });
    }

    this.client.on("connect", () => {
      this.connected = true;
      log.info("redis.connected", { keyPrefix: this.keyPrefix });
    });

    this.client.on("error", (err) => {
      this.connected = false;
      log.warn("redis.error", { error: String(err) });
    });

    this.client.on("close", () => {
      this.connected = false;
    });

    // Initiate connection
    this.client.connect().catch((err) => {
      log.warn("redis.connect_failed", { error: String(err) });
    });
  }

  private buildKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  /** Key for the atomic turn-sequence counter (separate from the state blob). */
  private buildTurnSeqKey(key: string): string {
    return `${this.keyPrefix}turnseq:${key}`;
  }

  async get(key: string): Promise<unknown | null> {
    if (!this.connected) return null;

    try {
      const raw = await this.client.get(this.buildKey(key));
      if (!raw) return null;

      return JSON.parse(raw) as unknown;
    } catch (err) {
      log.warn("redis.get_error", { key, error: String(err) });
      return null;
    }
  }

  async set(key: string, state: unknown): Promise<void> {
    if (!this.connected) return;

    try {
      const serialized = JSON.stringify(state, (_k, v) => {
        // Truncate over-long string fields to avoid oversized values.
        if (typeof v === "string" && v.length > 4096) {
          return v.slice(0, 4096);
        }
        return v;
      });
      await this.client.setex(this.buildKey(key), this.ttlSeconds, serialized);
      // Keep the turn-sequence counter alive in lockstep with the state blob.
      // Its TTL is otherwise only refreshed on increment (new turn), so a long
      // tool-loop that never starts a new turn could let the counter expire
      // while the blob survives — causing turnSeq to reset and regress on the
      // next new turn. EXPIRE on a missing key is a safe no-op (returns 0).
      await this.client.expire(this.buildTurnSeqKey(key), this.ttlSeconds);
    } catch (err) {
      log.warn("redis.set_error", { key, error: String(err) });
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client.del(this.buildKey(key));
      await this.client.del(this.buildTurnSeqKey(key));
    } catch (err) {
      log.warn("redis.delete_error", { key, error: String(err) });
    }
  }

  /**
   * Atomically increment the per-session turn sequence counter.
   *
   * Uses a dedicated key (`<prefix>turnseq:<session>`) with Redis INCR so that
   * concurrent requests on the same session are serialized by Redis itself —
   * each caller gets a unique, strictly increasing value. The counter's TTL is
   * refreshed on every increment to match the session lifetime.
   *
   * Returns 0 when Redis is unavailable so the host can fall back to its
   * stateless turn count.
   */
  async incrTurnSeq(key: string): Promise<number> {
    if (!this.connected) return 0;

    try {
      const turnSeqKey = this.buildTurnSeqKey(key);
      const next = await this.client.incr(turnSeqKey);
      await this.client.expire(turnSeqKey, this.ttlSeconds);
      return next;
    } catch (err) {
      log.warn("redis.incr_turnseq_error", { key, error: String(err) });
      return 0;
    }
  }

  /** Check if Redis is currently connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Gracefully close the Redis connection. */
  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
