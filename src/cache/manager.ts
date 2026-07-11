import { createHash } from "crypto";
import type { StorageAdapter } from "../storage/interfaces";

export interface CacheManagerOptions {
  namespace?: string;
}

interface CacheEnvelope<T> {
  version: 1;
  key: string;
  createdAt: string;
  value: T;
}

export class CacheManager {
  private readonly storage: StorageAdapter;
  private readonly namespace: string;

  constructor(storage: StorageAdapter, options: CacheManagerOptions = {}) {
    this.storage = storage;
    this.namespace = options.namespace ?? "cache";
  }

  async getOrCompute<T>(key: string, computeFn: () => Promise<T> | T): Promise<T> {
    try {
      const cached = await this.get<T>(key);
      if (cached !== null) return cached;
    } catch {
      // Cache read failures should not block the caller's source of truth.
    }

    const value = await computeFn();
    try {
      await this.set(key, value);
    } catch {
      // Cache write failures are non-fatal.
    }
    return value;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.storage.read(this.storageKey(key));
    if (!raw) return null;

    const parsed = JSON.parse(raw.toString("utf-8")) as CacheEnvelope<T>;
    return parsed.value;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const envelope: CacheEnvelope<T> = {
      version: 1,
      key,
      createdAt: new Date().toISOString(),
      value,
    };
    await this.storage.write(
      this.storageKey(key),
      JSON.stringify(envelope, null, 2)
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.storage.exists(this.storageKey(key));
    } catch {
      return false;
    }
  }

  storageKey(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return `${this.namespace}/${digest}.json`;
  }
}
