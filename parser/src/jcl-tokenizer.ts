// ============================================================
// JCL Tokenizer — Finite State Machine
// Deterministic, column-based tokenization of IBM JCL
// ============================================================

import { Token, TokenType } from './types.js';

export enum TokenizerState {
  START,
  STATEMENT,
  COMMENT,
  DELIMITER,
  CONTINUATION,
}

/**
 * Tokenizes raw JCL text into a stream of typed tokens.
 *
 * JCL format rules:
 *   - Columns 1-2: "//" marks a JCL statement
 *   - Column 1-3: "//*" marks an inline comment
 *   - Columns 1-2: "/*" marks a delimiter statement
 *   - A trailing comma on a statement signals continuation on the next line
 */
export function tokenizeJCL(source: string): Token[] {
  const lines = source.split('\n');
  const tokens: Token[] = [];
  let state: TokenizerState = TokenizerState.START;
  let continuationBuffer = '';
  let continuationStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;

    // ---- Detect line type using column-based FSM ----

    // Empty line
    if (raw.trim() === '') {
      continue;
    }

    // Inline comment:  //*
    if (raw.startsWith('//*')) {
      tokens.push({
        type: TokenType.JCL_COMMENT,
        value: raw.substring(3).trim(),
        line: lineNum,
        column: 1,
        raw,
      });
      continue;
    }

    // Delimiter:  /*
    if (raw.startsWith('/*')) {
      tokens.push({
        type: TokenType.JCL_DELIMITER,
        value: raw.substring(2).trim(),
        line: lineNum,
        column: 1,
        raw,
      });
      continue;
    }

    // JCL Statement:  //
    if (raw.startsWith('//')) {
      const content = raw.substring(2);

      // Handle continuation from previous line
      if (state === TokenizerState.CONTINUATION) {
        continuationBuffer += ' ' + content.trim();
        // Check if this line also continues
        if (content.trimEnd().endsWith(',')) {
          state = TokenizerState.CONTINUATION;
          continue;
        } else {
          // Emit the full continued statement
          tokens.push({
            type: TokenType.JCL_STATEMENT,
            value: continuationBuffer,
            line: continuationStartLine,
            column: 3,
            raw: continuationBuffer,
          });
          state = TokenizerState.START;
          continuationBuffer = '';
          continue;
        }
      }

      // Check if this line has a continuation (trailing comma)
      if (content.trimEnd().endsWith(',')) {
        state = TokenizerState.CONTINUATION;
        continuationBuffer = content.trim();
        continuationStartLine = lineNum;
        continue;
      }

      // Regular, self-contained statement
      tokens.push({
        type: TokenType.JCL_STATEMENT,
        value: content.trim(),
        line: lineNum,
        column: 3,
        raw,
      });
      continue;
    }

    // Continuation line that doesn't start with // (data)
    if (state === TokenizerState.CONTINUATION) {
      continuationBuffer += ' ' + raw.trim();
      if (!raw.trimEnd().endsWith(',')) {
        tokens.push({
          type: TokenType.JCL_STATEMENT,
          value: continuationBuffer,
          line: continuationStartLine,
          column: 3,
          raw: continuationBuffer,
        });
        state = TokenizerState.START;
        continuationBuffer = '';
      }
      continue;
    }

    // Unrecognized line
    tokens.push({
      type: TokenType.UNKNOWN,
      value: raw,
      line: lineNum,
      column: 1,
      raw,
    });
  }

  // Flush any remaining continuation buffer
  if (continuationBuffer) {
    tokens.push({
      type: TokenType.JCL_STATEMENT,
      value: continuationBuffer,
      line: continuationStartLine,
      column: 3,
      raw: continuationBuffer,
    });
  }

  tokens.push({
    type: TokenType.EOF,
    value: '',
    line: lines.length,
    column: 1,
    raw: '',
  });

  return tokens;
}

/**
 * Parses a JCL statement token into its constituent fields:
 * name, operation, and operands (key=value pairs).
 */
export interface JCLFields {
  name: string;
  operation: string;
  operands: Record<string, string>;
  positionalOperands: string[];
}

export function parseJCLFields(statement: string): JCLFields {
  const parts = statement.trim().split(/\s+/);
  const name = parts[0] || '';
  const operation = parts[1] || '';
  const operandStr = parts.slice(2).join(' ');

  const operands: Record<string, string> = {};
  const positionalOperands: string[] = [];

  if (operandStr) {
    // Split operands by comma, respecting parentheses
    const ops = splitOperands(operandStr);
    for (const op of ops) {
      const eqIdx = op.indexOf('=');
      if (eqIdx !== -1) {
        const key = op.substring(0, eqIdx).trim();
        const val = op.substring(eqIdx + 1).trim();
        operands[key] = val;
      } else {
        positionalOperands.push(op.trim());
      }
    }
  }

  return { name, operation, operands, positionalOperands };
}

/**
 * Splits a comma-separated operand string, respecting parenthesized groups.
 * e.g., "DSN=MY.FILE,DISP=(NEW,CATLG,DELETE)" →
 *        ["DSN=MY.FILE", "DISP=(NEW,CATLG,DELETE)"]
 */
function splitOperands(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;

  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    result.push(current);
  }
  return result;
}
