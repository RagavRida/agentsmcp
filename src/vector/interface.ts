import type { SearchResult, VectorEntry } from "./store";

export interface VectorSearchOptions {
  limit?: number;
  domain?: string;
  program?: string;
}

/** Shared vector store surface — in-process or subprocess-backed. */
export interface VectorStoreLike {
  upsert(entry: VectorEntry): void | Promise<void>;
  upsertMany(entries: VectorEntry[]): void | Promise<void>;
  search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): SearchResult[] | Promise<SearchResult[]>;
  embed(texts: string[], mode?: "query" | "passage"): Promise<number[][]>;
  semanticSearch(
    query: string,
    options?: VectorSearchOptions,
  ): Promise<SearchResult[]>;
  count(): number | Promise<number>;
  countByProgram(program: string): number | Promise<number>;
  programs(): string[] | Promise<string[]>;
  listByProgram(program: string, limit?: number): Promise<SearchResult[]>;
  deleteByProgram(program: string): number | Promise<number>;
  deleteById(id: string): boolean | Promise<boolean>;
  clear(): number | Promise<number>;
  close(): void | Promise<void>;
}

export async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return value instanceof Promise ? value : Promise.resolve(value);
}
