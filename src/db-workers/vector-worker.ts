import {
  OP_CLEAR,
  OP_CLOSE,
  OP_CONNECT,
  OP_COUNT,
  OP_DELETE_ID,
  OP_DELETE_PROGRAM,
  OP_PROGRAMS,
  OP_TABLE_ADD,
  OP_VECTOR_SEARCH,
  OP_COUNT_BY_PROGRAM,
  OP_LIST_BY_PROGRAM,
  registerWorkerHandler,
} from "./harness";

type Database = import("better-sqlite3").Database;

interface VectorEntry {
  id: string;
  program: string;
  nodeType: string;
  domain: string;
  description: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

interface SearchOptions {
  limit?: number;
  domain?: string;
  program?: string;
}

let db: Database | null = null;

registerWorkerHandler(async (op, payload) => {
  switch (op) {
    case OP_CONNECT:
      return connect(payload as { dbPath: string });
    case OP_TABLE_ADD:
      return tableAdd(payload as { entries: VectorEntry[] });
    case OP_VECTOR_SEARCH:
      return vectorSearch(payload as { queryVector: number[]; options?: SearchOptions });
    case OP_COUNT:
      return count();
    case OP_PROGRAMS:
      return programs();
    case OP_DELETE_PROGRAM:
      return deleteByProgram(payload as { program: string });
    case OP_DELETE_ID:
      return deleteById(payload as { id: string });
    case OP_CLEAR:
      return clear();
    case OP_COUNT_BY_PROGRAM:
      return countByProgram(payload as { program: string });
    case OP_LIST_BY_PROGRAM:
      return listByProgram(payload as { program: string; limit?: number });
    case OP_CLOSE:
      closeDb();
      return { closed: true };
    default:
      throw new Error(`Unknown vector worker op: ${op}`);
  }
});

function connect(payload: { dbPath: string }): { connected: true } {
  if (db) closeDb();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require("better-sqlite3");
  db = new Database(payload.dbPath);
  initialize();
  return { connected: true };
}

function tableAdd(payload: { entries: VectorEntry[] }): { added: number } {
  const database = requireDb();
  const entries = payload.entries ?? [];
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO semantic_vectors (id, program, node_type, domain, description, embedding, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = database.transaction((items: VectorEntry[]) => {
    for (const entry of items) {
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
  });
  tx(entries);
  return { added: entries.length };
}

function vectorSearch(payload: {
  queryVector: number[];
  options?: SearchOptions;
}): Array<{
  id: string;
  program: string;
  nodeType: string;
  domain: string;
  description: string;
  score: number;
  metadata?: Record<string, unknown>;
}> {
  const database = requireDb();
  const limit = payload.options?.limit ?? 10;
  let whereClause = "";
  const params: string[] = [];
  if (payload.options?.domain) {
    whereClause += " AND domain = ?";
    params.push(payload.options.domain);
  }
  if (payload.options?.program) {
    whereClause += " AND program = ?";
    params.push(payload.options.program);
  }

  const rows = database.prepare(`
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

  const results = rows.map((row) => {
    const storedVec = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    return {
      id: row.id,
      program: row.program,
      nodeType: row.node_type,
      domain: row.domain,
      description: row.description,
      score: cosineSimilarity(payload.queryVector, Array.from(storedVec)),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

function count(): number {
  const row = requireDb()
    .prepare("SELECT COUNT(*) as cnt FROM semantic_vectors")
    .get() as { cnt: number };
  return row.cnt;
}

function programs(): string[] {
  const rows = requireDb()
    .prepare("SELECT DISTINCT program FROM semantic_vectors ORDER BY program")
    .all() as Array<{ program: string }>;
  return rows.map((row) => row.program);
}

function countByProgram(payload: { program: string }): number {
  const row = requireDb()
    .prepare("SELECT COUNT(*) as cnt FROM semantic_vectors WHERE program = ?")
    .get(payload.program) as { cnt: number };
  return row.cnt;
}

function listByProgram(payload: { program: string; limit?: number }): Array<{
  id: string;
  program: string;
  nodeType: string;
  domain: string;
  description: string;
  score: number;
  metadata?: Record<string, unknown>;
}> {
  const limit = payload.limit ?? 500;
  const rows = requireDb()
    .prepare(`
      SELECT id, program, node_type, domain, description, metadata
      FROM semantic_vectors
      WHERE program = ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `)
    .all(payload.program, limit) as Array<{
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

function deleteByProgram(payload: { program: string }): number {
  return requireDb()
    .prepare("DELETE FROM semantic_vectors WHERE program = ?")
    .run(payload.program).changes;
}

function deleteById(payload: { id: string }): boolean {
  return requireDb()
    .prepare("DELETE FROM semantic_vectors WHERE id = ?")
    .run(payload.id).changes > 0;
}

function clear(): number {
  return requireDb().prepare("DELETE FROM semantic_vectors").run().changes;
}

function initialize(): void {
  requireDb().exec(`
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

function closeDb(): void {
  db?.close();
  db = null;
}

function requireDb(): Database {
  if (!db) throw new Error("Vector worker is not connected");
  return db;
}

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

process.once("disconnect", () => closeDb());
process.once("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
