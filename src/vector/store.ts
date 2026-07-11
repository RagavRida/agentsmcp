// ============================================================
// Vector Store — SQLite-backed semantic vector storage
// Stores embeddings from the Modal GPU endpoint and provides
// cosine similarity search for natural language queries.
// ============================================================

import * as path from "path";

import type { VectorSearchOptions, VectorStoreLike } from "./interface";

// We use the same better-sqlite3 that AgentMailbox already depends on
type Database = import("better-sqlite3").Database;

export interface VectorEntry {
  id: string;
  program: string;
  nodeType: string;
  domain: string;
  description: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  program: string;
  nodeType: string;
  domain: string;
  description: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export class VectorStore implements VectorStoreLike {
  private db: Database;
  private modalUrl: string | null;

  constructor(dbPath: string, modalUrl?: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    this.db = new Database(dbPath);
    this.modalUrl = modalUrl || process.env.AGENTSMCP_MODAL_EMBED_URL || null;
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_vectors (
        id TEXT PRIMARY KEY,
        program TEXT NOT NULL,
        node_type TEXT NOT NULL,
        domain TEXT NOT NULL,
        description TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT,
        level INTEGER DEFAULT 0,
        parent_id TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_vectors_program ON semantic_vectors(program);
      CREATE INDEX IF NOT EXISTS idx_vectors_domain ON semantic_vectors(domain);
      CREATE INDEX IF NOT EXISTS idx_vectors_node_type ON semantic_vectors(node_type);
      CREATE INDEX IF NOT EXISTS idx_vectors_level ON semantic_vectors(level);
    `);
  }

  /**
   * Store a pre-computed embedding vector.
   */
  upsert(entry: VectorEntry): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO semantic_vectors (id, program, node_type, domain, description, embedding, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.id,
      entry.program,
      entry.nodeType,
      entry.domain,
      entry.description,
      Buffer.from(new Float32Array(entry.embedding).buffer),
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  /**
   * Batch upsert multiple entries in a single transaction.
   */
  upsertMany(entries: VectorEntry[]): void {
    const tx = this.db.transaction((items: VectorEntry[]) => {
      for (const entry of items) {
        this.upsert(entry);
      }
    });
    tx(entries);
  }

  /**
   * Search for the most similar vectors using cosine similarity.
   * If a Modal URL is configured, it will embed the query using the GPU endpoint.
   * Otherwise, pass a pre-computed queryVector.
   */
  search(queryVector: number[], options?: {
    limit?: number;
    domain?: string;
    program?: string;
  }): SearchResult[] {
    const limit = options?.limit ?? 10;

    // Build the WHERE clause for optional filters
    let whereClause = "";
    const params: string[] = [];
    if (options?.domain) {
      whereClause += " AND domain = ?";
      params.push(options.domain);
    }
    if (options?.program) {
      whereClause += " AND program = ?";
      params.push(options.program);
    }

    const rows = this.db.prepare(`
      SELECT id, program, node_type, domain, description, embedding, metadata
      FROM semantic_vectors
      WHERE 1=1 ${whereClause}
    `).all(...params) as Array<{
      id: string;
      program: string;
      node_type: string;
      domain: string;
      description: string;
      embedding: Buffer;
      metadata: string | null;
    }>;

    // Compute cosine similarity for each row
    const results: SearchResult[] = rows.map((row) => {
      const storedVec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const score = cosineSimilarity(queryVector, Array.from(storedVec));
      return {
        id: row.id,
        program: row.program,
        nodeType: row.node_type,
        domain: row.domain,
        description: row.description,
        score,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      };
    });

    // Sort by similarity (highest first) and return top-K
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Call the Modal GPU endpoint to generate an embedding for text.
   */
  async embed(texts: string[], mode: "query" | "passage" = "passage"): Promise<number[][]> {
    if (!this.modalUrl) {
      const { hashEmbed } = await import("../memory/embedder");
      return texts.map((t) => hashEmbed(t));
    }

    const response = await fetch(`${this.modalUrl}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts, mode }),
    });

    if (!response.ok) {
      throw new Error(`Modal embedding request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }

  /**
   * High-level: embed a query string and search for similar vectors.
   */
  async semanticSearch(query: string, options?: {
    limit?: number;
    domain?: string;
    program?: string;
  }): Promise<SearchResult[]> {
    const [queryVector] = await this.embed([query], "query");
    return this.search(queryVector, options);
  }

  /**
   * List entries for a program in insertion order (no similarity scoring).
   */
  async listByProgram(program: string, limit = 500): Promise<SearchResult[]> {
    const rows = this.db.prepare(`
      SELECT id, program, node_type, domain, description, metadata
      FROM semantic_vectors
      WHERE program = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(program, limit) as Array<{
      id: string;
      program: string;
      node_type: string;
      domain: string;
      description: string;
      metadata: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      program: row.program,
      nodeType: row.node_type,
      domain: row.domain,
      description: row.description,
      score: 1,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  countByProgram(program: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM semantic_vectors WHERE program = ?",
    ).get(program) as { cnt: number };
    return row.cnt;
  }

  /**
   * Get the total number of stored vectors.
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM semantic_vectors").get() as { cnt: number };
    return row.cnt;
  }

  /**
   * List all distinct programs that have been indexed.
   */
  programs(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT program FROM semantic_vectors ORDER BY program"
    ).all() as Array<{ program: string }>;
    return rows.map((r) => r.program);
  }

  /**
   * Delete all vectors for a specific program.
   * Returns the number of vectors deleted.
   */
  deleteByProgram(program: string): number {
    const info = this.db.prepare(
      "DELETE FROM semantic_vectors WHERE program = ?"
    ).run(program);
    return info.changes;
  }

  /**
   * Delete a specific vector by ID.
   */
  deleteById(id: string): boolean {
    const info = this.db.prepare(
      "DELETE FROM semantic_vectors WHERE id = ?"
    ).run(id);
    return info.changes > 0;
  }

  /**
   * Delete all vectors (reset the store).
   */
  clear(): number {
    const info = this.db.prepare("DELETE FROM semantic_vectors").run();
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}

// ---- Math ----

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: query vector has ${a.length} dims but a stored ` +
        `vector has ${b.length} dims. This usually means the embedding model changed ` +
        `after indexing (e.g. the Modal endpoint vs. the 384-dim hashEmbed fallback). ` +
        `Re-index the affected programs with a single, consistent embedding model.`,
    );
  }
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
