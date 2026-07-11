// ============================================================
// Deep SQL Parser — Extracts tables, columns, JOINs, CURSORs
// from embedded EXEC SQL blocks in COBOL/PL/I.
// Pure regex-based, deterministic, zero LLM calls.
// ============================================================

export interface SQLStatement {
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "DECLARE_CURSOR" | "OPEN" | "FETCH" | "CLOSE" | "COMMIT" | "ROLLBACK" | "UNKNOWN";
  /** Primary table referenced */
  table: string;
  /** All tables referenced (including JOINs) */
  tables: string[];
  /** Column names extracted */
  columns: string[];
  /** JOIN relationships */
  joins: SQLJoin[];
  /** WHERE clause predicates */
  predicates: string[];
  /** Host variables referenced (COBOL :WS-VAR style) */
  hostVariables: string[];
  /** Cursor name (for DECLARE CURSOR / OPEN / FETCH / CLOSE) */
  cursorName?: string;
  /** Raw SQL text */
  raw: string;
}

export interface SQLJoin {
  type: "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS";
  table: string;
  onClause: string;
}

/**
 * Parse raw SQL text extracted from EXEC SQL blocks.
 * Handles DB2 dialect (mainframe standard).
 */
export function parseSQL(rawSql: string): SQLStatement {
  const sql = rawSql.replace(/\s+/g, " ").trim().toUpperCase();

  // Detect operation
  const operation = detectOperation(sql);

  // Extract host variables (:WS-VAR-NAME)
  const hostVarPattern = /:([A-Z][A-Z0-9_-]*)/g;
  const hostVariables: string[] = [];
  let hvMatch: RegExpExecArray | null;
  while ((hvMatch = hostVarPattern.exec(rawSql.toUpperCase())) !== null) {
    if (!hostVariables.includes(hvMatch[1])) {
      hostVariables.push(hvMatch[1]);
    }
  }

  switch (operation) {
    case "SELECT":
      return parseSelect(sql, rawSql, hostVariables);
    case "INSERT":
      return parseInsert(sql, rawSql, hostVariables);
    case "UPDATE":
      return parseUpdate(sql, rawSql, hostVariables);
    case "DELETE":
      return parseDelete(sql, rawSql, hostVariables);
    case "MERGE":
      return parseMerge(sql, rawSql, hostVariables);
    case "DECLARE_CURSOR":
      return parseCursor(sql, rawSql, hostVariables);
    case "OPEN":
    case "FETCH":
    case "CLOSE":
      return parseCursorOp(operation, sql, rawSql, hostVariables);
    case "COMMIT":
    case "ROLLBACK":
      return {
        operation,
        table: "",
        tables: [],
        columns: [],
        joins: [],
        predicates: [],
        hostVariables,
        raw: rawSql,
      };
    default:
      return {
        operation: "UNKNOWN",
        table: "",
        tables: [],
        columns: [],
        joins: [],
        predicates: [],
        hostVariables,
        raw: rawSql,
      };
  }
}

function detectOperation(sql: string):
  | "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE"
  | "DECLARE_CURSOR" | "OPEN" | "FETCH" | "CLOSE"
  | "COMMIT" | "ROLLBACK" | "UNKNOWN" {
  const trimmed = sql.trimStart();
  if (trimmed.startsWith("SELECT")) return "SELECT";
  if (trimmed.startsWith("INSERT")) return "INSERT";
  if (trimmed.startsWith("UPDATE")) return "UPDATE";
  if (trimmed.startsWith("DELETE")) return "DELETE";
  if (trimmed.startsWith("MERGE")) return "MERGE";
  if (trimmed.startsWith("DECLARE") && trimmed.includes("CURSOR")) return "DECLARE_CURSOR";
  if (trimmed.startsWith("OPEN")) return "OPEN";
  if (trimmed.startsWith("FETCH")) return "FETCH";
  if (trimmed.startsWith("CLOSE")) return "CLOSE";
  if (trimmed.startsWith("COMMIT")) return "COMMIT";
  if (trimmed.startsWith("ROLLBACK")) return "ROLLBACK";
  return "UNKNOWN";
}

/**
 * Extract column names from a SELECT column list.
 * Handles: col, t.col, col AS alias, COUNT(*), SUM(col), etc.
 */
function extractSelectColumns(columnClause: string): string[] {
  if (columnClause.trim() === "*") return ["*"];

  const columns: string[] = [];
  // Split on commas, but respect parentheses (for functions)
  let depth = 0;
  let current = "";
  for (const ch of columnClause) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      const col = cleanColumnRef(current.trim());
      if (col) columns.push(col);
      current = "";
    } else {
      current += ch;
    }
  }
  const last = cleanColumnRef(current.trim());
  if (last) columns.push(last);

  return columns;
}

function cleanColumnRef(expr: string): string {
  // Remove AS alias: "COL AS ALIAS" → "COL"
  const asMatch = expr.match(/^(.+?)\s+AS\s+/i);
  const base = asMatch ? asMatch[1].trim() : expr;

  // Handle aggregate functions: SUM(COL) → COL
  const funcMatch = base.match(/^(?:SUM|COUNT|AVG|MIN|MAX|COALESCE)\s*\(\s*(.+?)\s*\)$/i);
  if (funcMatch) {
    const inner = funcMatch[1].trim();
    return inner === "*" ? "*" : cleanColumnRef(inner);
  }

  // Handle table-qualified: T.COL → COL
  const dotMatch = base.match(/^[A-Z][A-Z0-9_]*\.([A-Z][A-Z0-9_-]*)$/);
  if (dotMatch) return dotMatch[1];

  // Strip host variable prefix
  if (base.startsWith(":")) return base.slice(1);

  // Only return valid identifiers
  if (/^[A-Z][A-Z0-9_-]*$/.test(base)) return base;

  return "";
}

/**
 * Extract table names from a FROM clause, including JOINs.
 */
function extractFromClause(sql: string): { tables: string[]; joins: SQLJoin[] } {
  const tables: string[] = [];
  const joins: SQLJoin[] = [];

  // Find FROM clause
  const fromMatch = sql.match(/\bFROM\s+(.+?)(?:\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bFOR\s+UPDATE\b|\bWITH\b|$)/i);
  if (!fromMatch) return { tables, joins };

  let fromClause = fromMatch[1].trim();

  // Extract JOINs first
  const joinPattern = /\b(INNER|LEFT\s+OUTER|LEFT|RIGHT\s+OUTER|RIGHT|FULL\s+OUTER|FULL|CROSS)\s+JOIN\s+([A-Z][A-Z0-9_]*)\s*(?:[A-Z]{1,3}\s+)?(?:ON\s+(.+?))?(?=\s+(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN|\s*$)/gi;
  let joinMatch: RegExpExecArray | null;
  while ((joinMatch = joinPattern.exec(fromClause)) !== null) {
    const joinType = joinMatch[1].replace(/\s+OUTER/i, "").trim().toUpperCase() as SQLJoin["type"];
    tables.push(joinMatch[2]);
    joins.push({
      type: joinType,
      table: joinMatch[2],
      onClause: joinMatch[3]?.trim() || "",
    });
  }

  // Extract the primary table (first in FROM, before any JOIN)
  const primaryPart = fromClause.split(/\b(?:INNER|LEFT|RIGHT|FULL|CROSS)\s+JOIN\b/i)[0].trim();
  // Handle comma-separated tables: FROM T1, T2
  const primaryTables = primaryPart.split(",").map((t) => {
    const name = t.trim().split(/\s+/)[0];
    return name?.match(/^[A-Z][A-Z0-9_]*$/i) ? name.toUpperCase() : "";
  }).filter(Boolean);

  tables.unshift(...primaryTables);

  return { tables: [...new Set(tables)], joins };
}

/**
 * Extract WHERE clause predicates.
 */
function extractPredicates(sql: string): string[] {
  const whereMatch = sql.match(/\bWHERE\s+(.+?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bFOR\s+UPDATE\b|\bWITH\b|$)/i);
  if (!whereMatch) return [];

  const whereClause = whereMatch[1].trim();
  // Split on AND/OR at top level
  return whereClause
    .split(/\s+(?:AND|OR)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseSelect(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  // Extract columns: between SELECT and FROM
  const colMatch = sql.match(/SELECT\s+(.*?)\s+FROM\b/i);
  const columns = colMatch ? extractSelectColumns(colMatch[1]) : [];

  const { tables, joins } = extractFromClause(sql);
  const predicates = extractPredicates(sql);

  return {
    operation: "SELECT",
    table: tables[0] || "UNKNOWN",
    tables,
    columns,
    joins,
    predicates,
    hostVariables,
    raw: rawSql,
  };
}

function parseInsert(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  const intoMatch = sql.match(/INSERT\s+INTO\s+([A-Z][A-Z0-9_]*)/i);
  const table = intoMatch ? intoMatch[1] : "UNKNOWN";

  // Extract column list if specified: INSERT INTO T (COL1, COL2)
  const colListMatch = sql.match(/INSERT\s+INTO\s+[A-Z][A-Z0-9_]*\s*\(([^)]+)\)/i);
  const columns = colListMatch
    ? colListMatch[1].split(",").map((c) => c.trim()).filter(Boolean)
    : [];

  return {
    operation: "INSERT",
    table,
    tables: [table],
    columns,
    joins: [],
    predicates: [],
    hostVariables,
    raw: rawSql,
  };
}

function parseUpdate(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  const tableMatch = sql.match(/UPDATE\s+([A-Z][A-Z0-9_]*)/i);
  const table = tableMatch ? tableMatch[1] : "UNKNOWN";

  // Extract SET columns: SET COL1 = val, COL2 = val
  const setMatch = sql.match(/SET\s+(.+?)(?:\bWHERE\b|$)/i);
  const columns: string[] = [];
  if (setMatch) {
    const assignments = setMatch[1].split(",");
    for (const a of assignments) {
      const colName = a.trim().split(/\s*=/)[0].trim();
      if (/^[A-Z][A-Z0-9_-]*$/i.test(colName)) columns.push(colName);
    }
  }

  const predicates = extractPredicates(sql);

  return {
    operation: "UPDATE",
    table,
    tables: [table],
    columns,
    joins: [],
    predicates,
    hostVariables,
    raw: rawSql,
  };
}

function parseDelete(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  const fromMatch = sql.match(/DELETE\s+FROM\s+([A-Z][A-Z0-9_]*)/i);
  const table = fromMatch ? fromMatch[1] : "UNKNOWN";
  const predicates = extractPredicates(sql);

  return {
    operation: "DELETE",
    table,
    tables: [table],
    columns: [],
    joins: [],
    predicates,
    hostVariables,
    raw: rawSql,
  };
}

function parseMerge(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  const intoMatch = sql.match(/MERGE\s+INTO\s+([A-Z][A-Z0-9_]*)/i);
  const table = intoMatch ? intoMatch[1] : "UNKNOWN";
  const usingMatch = sql.match(/USING\s+([A-Z][A-Z0-9_]*)/i);
  const tables = [table];
  if (usingMatch) tables.push(usingMatch[1]);

  return {
    operation: "MERGE",
    table,
    tables,
    columns: [],
    joins: [],
    predicates: [],
    hostVariables,
    raw: rawSql,
  };
}

function parseCursor(sql: string, rawSql: string, hostVariables: string[]): SQLStatement {
  const nameMatch = sql.match(/DECLARE\s+([A-Z][A-Z0-9_-]*)\s+CURSOR/i);
  const cursorName = nameMatch ? nameMatch[1] : "UNKNOWN";

  // The cursor body is a SELECT — parse it
  const selectStart = sql.indexOf("SELECT");
  if (selectStart >= 0) {
    const selectSql = sql.substring(selectStart);
    const inner = parseSelect(selectSql, rawSql, hostVariables);
    return {
      ...inner,
      operation: "DECLARE_CURSOR",
      cursorName,
    };
  }

  return {
    operation: "DECLARE_CURSOR",
    table: "",
    tables: [],
    columns: [],
    joins: [],
    predicates: [],
    hostVariables,
    cursorName,
    raw: rawSql,
  };
}

function parseCursorOp(
  operation: "OPEN" | "FETCH" | "CLOSE",
  sql: string,
  rawSql: string,
  hostVariables: string[]
): SQLStatement {
  const nameMatch = sql.match(/(?:OPEN|FETCH|CLOSE)\s+([A-Z][A-Z0-9_-]*)/i);
  const cursorName = nameMatch ? nameMatch[1] : "UNKNOWN";

  // For FETCH, extract INTO variables
  const intoMatch = sql.match(/INTO\s+(.+)/i);
  const columns: string[] = [];
  if (intoMatch) {
    const vars = intoMatch[1].split(",").map((v) => v.trim().replace(/^:/, "")).filter(Boolean);
    columns.push(...vars);
  }

  return {
    operation,
    table: "",
    tables: [],
    columns,
    joins: [],
    predicates: [],
    hostVariables,
    cursorName,
    raw: rawSql,
  };
}
