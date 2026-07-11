import { SqliteStorage } from "./sqlite";
import { PostgresStorage } from "./postgres";
import { Storage, StorageOptions } from "./interface";

export type {
  Storage,
  StorageOptions,
  GraphNode,
  GraphEdge,
  GraphNodeType,
  CodebaseIndexEntry,
  IndexCategory,
} from "./interface";
export { SqliteStorage } from "./sqlite";
export { PostgresStorage, type PostgresStorageOptions } from "./postgres";
export {
  LocalStorageAdapter,
  S3StorageAdapter,
  createStorageAdapterFromEnv,
  type LocalStorageAdapterOptions,
  type S3StorageAdapterOptions,
  type StorageAdapter,
  type StorageData,
} from "./interfaces";

function normalize(opts: string | StorageOptions): StorageOptions {
  return typeof opts === "string" ? { url: opts } : opts;
}

/**
 * Construct a {@link Storage} adapter from a connection string or options
 * object. URLs starting with `postgres://` or `postgresql://` route to the
 * Postgres adapter; anything else is treated as a SQLite file path (or
 * `":memory:"`).
 *
 * Callers should treat the return value as the {@link Storage} interface;
 * the concrete class is not part of the public API and may change.
 */
export function createStorage(opts: string | StorageOptions): Storage {
  const { url } = normalize(opts);
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return new PostgresStorage(url);
  }
  return new SqliteStorage(url);
}
