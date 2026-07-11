// ============================================================
// Edge Extractor — Deterministic Knowledge Graph Builder
// Extracts execution edges from JCL and COBOL ASTs
// using pure pattern matching — zero LLM calls
// ============================================================

import {
  ASTNode, ASTNodeType, EdgeType,
  GraphEdge, GraphNode, KnowledgeGraph,
} from './types.js';

/**
 * Extracts a complete Knowledge Graph from a set of parsed ASTs.
 */
export class EdgeExtractor {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];

  /**
   * Process a JCL AST and extract all execution edges.
   */
  extractFromJCL(ast: ASTNode, sourceFile: string): void {
    if (ast.type !== ASTNodeType.JCL_JOB) return;

    // Register the JOB as a graph node
    this.addNode(ast.name, ast.name, 'JOB', sourceFile);

    for (const child of ast.children) {
      this.extractJCLStep(child, ast.name, sourceFile);
    }
  }

  /**
   * Process a COBOL AST and extract all internal edges.
   */
  extractFromCOBOL(ast: ASTNode, sourceFile: string): void {
    if (ast.type !== ASTNodeType.COBOL_PROGRAM) return;

    this.addNode(ast.name, ast.name, 'PROGRAM', sourceFile);

    // Walk the entire tree recursively
    this.walkCOBOL(ast, ast.name, sourceFile);
  }

  /**
   * Return the assembled Knowledge Graph.
   */
  getGraph(): KnowledgeGraph {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: [...this.edges],
    };
  }

  // ---- JCL Edge Extraction ----

  private extractJCLStep(node: ASTNode, jobName: string, file: string): void {
    // EXEC PGM=PROGRAM
    if (node.type === ASTNodeType.JCL_EXEC) {
      const program = (node.meta['target'] as string) || 'UNKNOWN';
      this.addNode(program, program, 'PROGRAM');
      this.addEdge(jobName, program, EdgeType.EXECUTES, file, node.loc.startLine);

      // Process DD children for dataset edges
      for (const dd of node.children) {
        this.extractDDEdge(dd, program, file);
      }
    }

    // EXEC PROC=PROCNAME
    if (node.type === ASTNodeType.JCL_PROC_CALL) {
      const proc = (node.meta['target'] as string) || 'UNKNOWN';
      this.addNode(proc, proc, 'PROGRAM');
      this.addEdge(jobName, proc, EdgeType.EXECUTES, file, node.loc.startLine);

      for (const dd of node.children) {
        this.extractDDEdge(dd, proc, file);
      }
    }
  }

  /**
   * Extract dataset read/write edges from DD statements.
   *
   * DISP rules (deterministic, no guessing):
   *   SHR         → READS
   *   OLD         → MODIFIES (read + write)
   *   (NEW,...)   → WRITES
   *   MOD         → WRITES (append)
   */
  private extractDDEdge(dd: ASTNode, programName: string, file: string): void {
    if (dd.type !== ASTNodeType.JCL_DD) return;

    const dsn = (dd.meta['dsn'] as string) || '';
    const disp = ((dd.meta['disp'] as string) || '').toUpperCase();

    // Skip SYSOUT (printer) and empty DSN
    if (dd.meta['sysout'] || !dsn) return;

    this.addNode(dsn, dsn, 'DATASET');

    // Parse the DISP parameter
    // DISP can be: SHR, OLD, NEW, MOD, or (status,normal,abnormal)
    const dispNorm = disp.replace(/[()]/g, '');
    const dispParts = dispNorm.split(',');
    const status = dispParts[0]?.trim() || '';

    if (status === 'SHR') {
      this.addEdge(programName, dsn, EdgeType.READS, file, dd.loc.startLine);
    } else if (status === 'OLD') {
      this.addEdge(programName, dsn, EdgeType.MODIFIES, file, dd.loc.startLine);
    } else if (status === 'NEW' || status === 'MOD') {
      this.addEdge(programName, dsn, EdgeType.WRITES, file, dd.loc.startLine);
    } else {
      // Default: assume reads
      this.addEdge(programName, dsn, EdgeType.READS, file, dd.loc.startLine);
    }
  }

  // ---- COBOL Edge Extraction ----

  private walkCOBOL(node: ASTNode, programName: string, file: string): void {
    switch (node.type) {
      case ASTNodeType.COBOL_PERFORM_NODE: {
        const target = (node.meta['target'] as string) || node.name;
        this.addNode(target, target, 'PARAGRAPH');
        this.addEdge(programName, target, EdgeType.PERFORMS, file, node.loc.startLine);
        break;
      }

      case ASTNodeType.COBOL_CALL_NODE: {
        const target = (node.meta['target'] as string) || node.name;
        this.addNode(target, target, 'PROGRAM');
        this.addEdge(programName, target, EdgeType.CALLS, file, node.loc.startLine);
        break;
      }

      case ASTNodeType.COBOL_EXEC_SQL_NODE: {
        const table = (node.meta['table'] as string) || '';
        const tables = normalizeStringArray(node.meta['tables']);
        const operation = (node.meta['operation'] as string) || 'UNKNOWN';
        const targets = tables.length > 0 ? tables : (table ? [table] : []);

        for (const sqlTable of targets) {
          if (!sqlTable || sqlTable === 'UNKNOWN') continue;
          this.addNode(sqlTable, sqlTable, 'TABLE');
          this.addEdge(programName, sqlTable, EdgeType.DATA_ACCESS, file, node.loc.startLine);
          if (operation === 'SELECT' || operation === 'DECLARE_CURSOR' || operation === 'FETCH' || operation === 'OPEN') {
            this.addEdge(programName, sqlTable, EdgeType.READS, file, node.loc.startLine);
          } else if (operation === 'INSERT') {
            this.addEdge(programName, sqlTable, EdgeType.WRITES, file, node.loc.startLine);
          } else if (operation === 'UPDATE' || operation === 'DELETE' || operation === 'MERGE') {
            this.addEdge(programName, sqlTable, EdgeType.MODIFIES, file, node.loc.startLine);
          }
        }
        break;
      }

      case ASTNodeType.COBOL_EXEC_CICS_NODE: {
        const command = (node.meta['command'] as string) || 'UNKNOWN';
        const transid = (node.meta['transid'] as string) || '';
        const program = (node.meta['program'] as string) || '';
        const cicsFile = (node.meta['file'] as string) || '';
        const map = (node.meta['map'] as string) || '';
        const queue = (node.meta['queue'] as string) || '';

        if ((command === 'LINK' || command === 'XCTL') && program) {
          this.addNode(program, program, 'PROGRAM');
          this.addEdge(programName, program, EdgeType.EXTERNAL_CALL, file, node.loc.startLine);
          this.addEdge(programName, program, EdgeType.CALLS, file, node.loc.startLine);
        }
        if (transid) {
          this.addNode(transid, transid, 'TRANSACTION');
          this.addEdge(programName, transid, EdgeType.TRANSACTS, file, node.loc.startLine);
        }
        if (cicsFile) {
          this.addNode(cicsFile, cicsFile, 'FILE');
          this.addEdge(programName, cicsFile, EdgeType.DATA_ACCESS, file, node.loc.startLine);
          if (command === 'READ') {
            this.addEdge(programName, cicsFile, EdgeType.READS, file, node.loc.startLine);
          } else if (command === 'WRITE') {
            this.addEdge(programName, cicsFile, EdgeType.WRITES, file, node.loc.startLine);
          } else if (command === 'REWRITE' || command === 'DELETE') {
            this.addEdge(programName, cicsFile, EdgeType.MODIFIES, file, node.loc.startLine);
          }
        }
        if (map) {
          this.addNode(map, map, 'MAP');
          this.addEdge(programName, map, EdgeType.TRANSACTS, file, node.loc.startLine);
        }
        if (queue) {
          this.addNode(queue, queue, 'QUEUE');
          this.addEdge(programName, queue, EdgeType.DATA_ACCESS, file, node.loc.startLine);
        }
        break;
      }

      case ASTNodeType.COBOL_COPY_NODE: {
        const copybook = (node.meta['copybook'] as string) || node.name;
        this.addNode(copybook, copybook, 'COPYBOOK');
        this.addEdge(programName, copybook, EdgeType.INCLUDES, file, node.loc.startLine);
        break;
      }
    }

    // Recurse into children
    for (const child of node.children) {
      this.walkCOBOL(child, programName, file);
    }
  }

  // ---- Graph Helpers ----

  private addNode(id: string, label: string, type: GraphNode['type'], file?: string): void {
    if (!this.nodes.has(id)) {
      this.nodes.set(id, { id, label, type, file });
    }
  }

  private addEdge(source: string, target: string, type: EdgeType, file: string, line: number): void {
    // Deduplicate edges
    const exists = this.edges.some(
      (e) => e.source === source && e.target === target && e.type === type,
    );
    if (!exists) {
      this.edges.push({ source, target, type, loc: { file, line } });
    }
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}
