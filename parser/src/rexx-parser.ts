import { ASTNode, ASTNodeType } from './types.js';

export class REXXParser {
  parse(source: string): ASTNode {
    const lines = source.split(/\r?\n/);
    const children: ASTNode[] = [];
    const scriptName = detectScriptName(source) ?? 'REXX_SCRIPT';

    for (let index = 0; index < lines.length; index++) {
      const raw = stripInlineComment(lines[index]).trim();
      if (!raw) continue;
      const node = this.parseLine(raw, index + 1);
      if (node) children.push(node);
    }

    return {
      type: ASTNodeType.REXX_SCRIPT,
      name: scriptName,
      children,
      meta: { language: 'rexx' },
      loc: { startLine: 1, endLine: lines.length },
    };
  }

  private parseLine(line: string, lineNumber: number): ASTNode | null {
    const upper = line.toUpperCase();
    const loc = { startLine: lineNumber, endLine: lineNumber };

    if (upper.startsWith('SAY ')) {
      return {
        type: ASTNodeType.REXX_SAY_NODE,
        name: 'SAY',
        children: [],
        meta: { message: line.replace(/^SAY\s+/i, '').trim(), raw: line },
        loc,
      };
    }

    if (upper.startsWith('CALL ')) {
      const match = line.match(/^CALL\s+([A-Z0-9_$#@.-]+)/i);
      return {
        type: ASTNodeType.REXX_CALL_NODE,
        name: match?.[1]?.toUpperCase() ?? 'UNKNOWN',
        children: [],
        meta: {
          target: match?.[1]?.toUpperCase() ?? 'UNKNOWN',
          arguments: extractArguments(line.replace(/^CALL\s+[A-Z0-9_$#@.-]+/i, '').trim()),
          raw: line,
        },
        loc,
      };
    }

    if (upper === 'DO' || upper.startsWith('DO ')) {
      return {
        type: ASTNodeType.REXX_DO_NODE,
        name: 'DO',
        children: [],
        meta: { condition: line.replace(/^DO\s*/i, '').trim(), raw: line },
        loc,
      };
    }

    if (upper.startsWith('IF ')) {
      const condition = line.replace(/^IF\s+/i, '').replace(/\s+THEN\b[\s\S]*$/i, '').trim();
      return {
        type: ASTNodeType.REXX_IF_NODE,
        name: 'IF',
        children: [],
        meta: { condition, raw: line },
        loc,
      };
    }

    if (upper.startsWith('PARSE ')) {
      const match = line.match(/^PARSE\s+(\S+)\s+(.+)$/i);
      return {
        type: ASTNodeType.REXX_PARSE_NODE,
        name: 'PARSE',
        children: [],
        meta: {
          source: match?.[1]?.toUpperCase() ?? '',
          template: match?.[2]?.trim() ?? '',
          raw: line,
        },
        loc,
      };
    }

    return null;
  }
}

function stripInlineComment(line: string): string {
  return line.replace(/\/\*.*?\*\//g, '');
}

function detectScriptName(source: string): string | undefined {
  const match = source.match(/\/\*\s*REXX\s+([A-Z0-9_$#@.-]+)\s*\*\//i)
    ?? source.match(/^\s*\/\*\s*([A-Z0-9_$#@.-]+)\s*\*\//im);
  return match?.[1]?.toUpperCase();
}

function extractArguments(value: string): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
