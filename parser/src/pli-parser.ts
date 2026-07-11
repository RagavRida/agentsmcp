import { parseSQL } from './sql-parser.js';
import { ASTNode, ASTNodeType } from './types.js';

export class PLIParser {
  parse(source: string): ASTNode {
    const statements = splitPLIStatements(source);
    const programName = detectProgramName(statements) ?? 'PLI_PROGRAM';
    const children: ASTNode[] = [];

    for (const statement of statements) {
      const node = this.parseStatement(statement);
      if (node) children.push(node);
    }

    return {
      type: ASTNodeType.PLI_PROGRAM,
      name: programName,
      children,
      meta: { language: 'pli' },
      loc: { startLine: 1, endLine: source.split(/\r?\n/).length },
    };
  }

  private parseStatement(statement: SourceStatement): ASTNode | null {
    const text = statement.text.trim();
    const upper = text.toUpperCase();

    const procMatch = text.match(/^([A-Z][A-Z0-9_$#@-]*)\s*:\s*PROC\b/i)
      ?? text.match(/^([A-Z][A-Z0-9_$#@-]*)\s*:\s*PROCEDURE\b/i)
      ?? text.match(/^([A-Z][A-Z0-9_$#@-]*)\s+PROC\b/i)
      ?? text.match(/^([A-Z][A-Z0-9_$#@-]*)\s+PROCEDURE\b/i);
    if (procMatch) {
      return {
        type: ASTNodeType.PLI_PROC_NODE,
        name: procMatch[1].toUpperCase(),
        children: [],
        meta: { raw: text },
        loc: statement.loc,
      };
    }

    if (/^(DCL|DECLARE)\b/i.test(text)) {
      const declarations = extractDeclarations(text);
      return {
        type: ASTNodeType.PLI_DECLARE_NODE,
        name: declarations[0]?.name ?? 'DECLARE',
        children: [],
        meta: { declarations, raw: text },
        loc: statement.loc,
      };
    }

    if (/^CALL\b/i.test(text)) {
      const callMatch = text.match(/^CALL\s+([A-Z][A-Z0-9_$#@-]*)/i);
      return createCallNode(
        callMatch?.[1]?.toUpperCase() ?? 'UNKNOWN',
        extractCallArguments(text),
        text,
        statement.loc,
      );
    }

    if (/^IF\b/i.test(text)) {
      const conditionMatch = text.match(/^IF\s+(.+?)\s+THEN\b/i);
      return {
        type: ASTNodeType.PLI_IF_NODE,
        name: 'IF',
        children: extractEmbeddedCalls(text, statement.loc),
        meta: {
          condition: conditionMatch?.[1]?.trim() ?? text.replace(/^IF\s+/i, ''),
          raw: text,
        },
        loc: statement.loc,
      };
    }

    if (/^(SELECT|WHEN|OTHERWISE)\b/i.test(text)) {
      return {
        type: ASTNodeType.PLI_SELECT_NODE,
        name: 'SELECT',
        children: extractEmbeddedCalls(text, statement.loc),
        meta: { raw: text },
        loc: statement.loc,
      };
    }

    if (upper.startsWith('EXEC SQL')) {
      const sql = text.replace(/^EXEC\s+SQL\s*/i, '').replace(/;\s*$/g, '').trim();
      const parsed = parseSQL(sql);
      return {
        type: ASTNodeType.PLI_EXEC_SQL_NODE,
        name: `SQL_${parsed.operation}`,
        children: [],
        meta: {
          operation: parsed.operation,
          table: parsed.table || parsed.tables[0] || 'UNKNOWN',
          tables: parsed.tables,
          columns: parsed.columns,
          joins: parsed.joins,
          predicates: parsed.predicates,
          hostVariables: parsed.hostVariables,
          cursorName: parsed.cursorName,
          sql,
          parsedSql: parsed,
        },
        loc: statement.loc,
      };
    }

    return null;
  }
}

interface SourceStatement {
  text: string;
  loc: { startLine: number; endLine: number };
}

function splitPLIStatements(source: string): SourceStatement[] {
  const statements: SourceStatement[] = [];
  const lines = source.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/);
  let buffer = '';
  let startLine = 1;

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;
    if (!buffer) startLine = lineNumber;
    buffer += `${buffer ? ' ' : ''}${line}`;
    if (line.endsWith(';')) {
      statements.push({
        text: buffer.replace(/;\s*$/, ''),
        loc: { startLine, endLine: lineNumber },
      });
      buffer = '';
    }
  }

  if (buffer.trim()) {
    statements.push({
      text: buffer.trim(),
      loc: { startLine, endLine: lines.length },
    });
  }

  return statements;
}

function detectProgramName(statements: SourceStatement[]): string | undefined {
  for (const statement of statements) {
    const match = statement.text.match(/^([A-Z][A-Z0-9_$#@-]*)\s*:?\s*(?:PROC|PROCEDURE)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return undefined;
}

function extractDeclarations(statement: string): Array<{ name: string; type: string }> {
  const body = statement.replace(/^(DCL|DECLARE)\s+/i, '').trim();
  return body
    .split(',')
    .map((part) => part.trim())
    .map((part) => {
      const match = part.match(/^([A-Z][A-Z0-9_$#@-]*)\s*(.*)$/i);
      return {
        name: match?.[1]?.toUpperCase() ?? 'UNKNOWN',
        type: match?.[2]?.trim() ?? '',
      };
    })
    .filter((item) => item.name !== 'UNKNOWN');
}

function extractCallArguments(statement: string): string[] {
  const match = statement.match(/\((.*)\)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function extractEmbeddedCalls(statement: string, loc: { startLine: number; endLine: number }): ASTNode[] {
  const calls: ASTNode[] = [];
  const pattern = /\bCALL\s+([A-Z][A-Z0-9_$#@-]*)\s*(?:\(([^)]*)\))?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(statement)) !== null) {
    calls.push(createCallNode(
      match[1].toUpperCase(),
      match[2]
        ? match[2].split(',').map((arg) => arg.trim()).filter(Boolean)
        : [],
      match[0],
      loc,
    ));
  }
  return calls;
}

function createCallNode(
  target: string,
  args: string[],
  raw: string,
  loc: { startLine: number; endLine: number },
): ASTNode {
  return {
    type: ASTNodeType.PLI_CALL_NODE,
    name: target,
    children: [],
    meta: {
      target,
      arguments: args,
      raw,
    },
    loc,
  };
}
