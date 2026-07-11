// ============================================================
// Abstract Semantic Tree Parser — Type Definitions
// Deterministic, zero-LLM parsing for JCL & COBOL
// ============================================================

// ---- Tokenizer Types ----

export enum TokenType {
  // JCL tokens
  JCL_STATEMENT = 'JCL_STATEMENT',
  JCL_COMMENT = 'JCL_COMMENT',
  JCL_DELIMITER = 'JCL_DELIMITER',
  JCL_CONTINUATION = 'JCL_CONTINUATION',

  // COBOL tokens
  COBOL_DIVISION = 'COBOL_DIVISION',
  COBOL_SECTION = 'COBOL_SECTION',
  COBOL_PARAGRAPH = 'COBOL_PARAGRAPH',
  COBOL_STATEMENT = 'COBOL_STATEMENT',
  COBOL_COPY = 'COBOL_COPY',
  COBOL_EXEC_SQL = 'COBOL_EXEC_SQL',
  COBOL_EXEC_CICS = 'COBOL_EXEC_CICS',
  COBOL_PERFORM = 'COBOL_PERFORM',
  COBOL_CALL = 'COBOL_CALL',
  COBOL_VARIABLE = 'COBOL_VARIABLE',

  // Generic
  EOF = 'EOF',
  UNKNOWN = 'UNKNOWN',
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  /** Raw text of the entire line */
  raw: string;
}

// ---- AST Node Types ----

export enum ASTNodeType {
  // JCL nodes
  JCL_JOB = 'JCL_JOB',
  JCL_STEP = 'JCL_STEP',
  JCL_EXEC = 'JCL_EXEC',
  JCL_DD = 'JCL_DD',
  JCL_PROC_CALL = 'JCL_PROC_CALL',

  // COBOL nodes
  COBOL_PROGRAM = 'COBOL_PROGRAM',
  COBOL_DIVISION_NODE = 'COBOL_DIVISION_NODE',
  COBOL_SECTION_NODE = 'COBOL_SECTION_NODE',
  COBOL_PARAGRAPH_NODE = 'COBOL_PARAGRAPH_NODE',
  COBOL_PERFORM_NODE = 'COBOL_PERFORM_NODE',
  COBOL_CALL_NODE = 'COBOL_CALL_NODE',
  COBOL_EXEC_SQL_NODE = 'COBOL_EXEC_SQL_NODE',
  COBOL_EXEC_CICS_NODE = 'COBOL_EXEC_CICS_NODE',
  COBOL_COPY_NODE = 'COBOL_COPY_NODE',
  COBOL_VARIABLE_NODE = 'COBOL_VARIABLE_NODE',
  COBOL_COMPUTE_NODE = 'COBOL_COMPUTE_NODE',
  COBOL_MOVE_NODE = 'COBOL_MOVE_NODE',
  COBOL_IF_NODE = 'COBOL_IF_NODE',
  COBOL_ELSE_NODE = 'COBOL_ELSE_NODE',
  COBOL_EVALUATE_NODE = 'COBOL_EVALUATE_NODE',
  COBOL_WHEN_NODE = 'COBOL_WHEN_NODE',
  COBOL_CONDITION_88_NODE = 'COBOL_CONDITION_88_NODE',
  COBOL_REDEFINES_NODE = 'COBOL_REDEFINES_NODE',

  // PL/I nodes
  PLI_PROGRAM = 'PLI_PROGRAM',
  PLI_PROC_NODE = 'PLI_PROC_NODE',
  PLI_DECLARE_NODE = 'PLI_DECLARE_NODE',
  PLI_CALL_NODE = 'PLI_CALL_NODE',
  PLI_IF_NODE = 'PLI_IF_NODE',
  PLI_SELECT_NODE = 'PLI_SELECT_NODE',
  PLI_EXEC_SQL_NODE = 'PLI_EXEC_SQL_NODE',

  // REXX nodes
  REXX_SCRIPT = 'REXX_SCRIPT',
  REXX_SAY_NODE = 'REXX_SAY_NODE',
  REXX_CALL_NODE = 'REXX_CALL_NODE',
  REXX_DO_NODE = 'REXX_DO_NODE',
  REXX_IF_NODE = 'REXX_IF_NODE',
  REXX_PARSE_NODE = 'REXX_PARSE_NODE',
}

export interface ASTNode {
  type: ASTNodeType;
  name: string;
  children: ASTNode[];
  /** Metadata extracted during parsing */
  meta: Record<string, unknown>;
  /** Source location for traceability */
  loc: { startLine: number; endLine: number };
}

// ---- Knowledge Graph Edge Types ----

export enum EdgeType {
  EXECUTES = 'EXECUTES',     // JCL step runs a program
  READS = 'READS',           // Program reads a dataset/table
  WRITES = 'WRITES',         // Program writes a dataset/table
  MODIFIES = 'MODIFIES',     // Program reads + writes (DISP=OLD)
  DATA_ACCESS = 'DATA_ACCESS', // Program accesses a database resource
  CALLS = 'CALLS',           // COBOL CALL to another program
  EXTERNAL_CALL = 'EXTERNAL_CALL', // Program transfers control to an external service/program
  PERFORMS = 'PERFORMS',      // COBOL PERFORM to a paragraph
  INCLUDES = 'INCLUDES',     // COBOL COPY or JCL INCLUDE
  TRANSACTS = 'TRANSACTS',   // CICS transaction
}

export interface GraphEdge {
  source: string;
  target: string;
  type: EdgeType;
  /** Source location where this edge was detected */
  loc: { file: string; line: number };
}

export interface GraphNode {
  id: string;
  label: string;
  type:
    | 'PROGRAM'
    | 'DATASET'
    | 'TABLE'
    | 'COPYBOOK'
    | 'TRANSACTION'
    | 'JOB'
    | 'PARAGRAPH'
    | 'FILE'
    | 'MAP'
    | 'QUEUE';
  file?: string;
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
