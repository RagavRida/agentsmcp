import { hashEmbed } from "../memory/embedder";
import { VectorDatabase } from "./database";
import type { VectorStoreLike, VectorSearchOptions } from "./interface";
import type { SearchResult, VectorEntry } from "./store";

/**
 * Subprocess-isolated vector store client.
 * Delegates DB ops to vector-worker; embeddings via Modal or hash fallback.
 */
export class VectorStoreClient implements VectorStoreLike {
  private readonly database: VectorDatabase;

  constructor(dbPath: string, requestTimeoutMs?: number) {
    this.database = new VectorDatabase({ dbPath, requestTimeoutMs });
  }

  async upsert(entry: VectorEntry): Promise<void> {
    await this.database.upsert(entry);
  }

  async upsertMany(entries: VectorEntry[]): Promise<void> {
    await this.database.upsertMany(entries);
  }

  async search(
    queryVector: number[],
    options?: VectorSearchOptions,
  ): Promise<SearchResult[]> {
    return this.database.search(queryVector, options);
  }

  async embed(texts: string[], mode: "query" | "passage" = "passage"): Promise<number[][]> {
    const modalUrl =
      process.env.AGENTSMCP_MODAL_EMBED_URL ||
      process.env.AGENTSMCP_MODAL_ENDPOINT_URL;
    if (modalUrl) {
      const response = await fetch(`${modalUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts, mode }),
      });
      if (!response.ok) {
        throw new Error(`Modal embedding failed: ${response.status}`);
      }
      const data = (await response.json()) as { embeddings: number[][] };
      return data.embeddings;
    }
    return texts.map((t) => hashEmbed(t));
  }

  async semanticSearch(
    query: string,
    options?: VectorSearchOptions,
  ): Promise<SearchResult[]> {
    const [queryVector] = await this.embed([query], "query");
    return this.search(queryVector, options);
  }

  async count(): Promise<number> {
    return this.database.count();
  }

  async countByProgram(program: string): Promise<number> {
    return this.database.countByProgram(program);
  }

  async programs(): Promise<string[]> {
    return this.database.programs();
  }

  async listByProgram(program: string, limit = 500): Promise<SearchResult[]> {
    return this.database.listByProgram(program, limit);
  }

  async deleteByProgram(program: string): Promise<number> {
    return this.database.deleteByProgram(program);
  }

  async deleteById(id: string): Promise<boolean> {
    return this.database.deleteById(id);
  }

  async clear(): Promise<number> {
    return this.database.clear();
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  get workerPid(): number | undefined {
    return this.database.workerPid;
  }
}
