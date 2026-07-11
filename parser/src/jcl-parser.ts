// ============================================================
// JCL Recursive Descent Parser — Builds AST from tokens
// Deterministic, zero-LLM parsing
// ============================================================

import { Token, TokenType, ASTNode, ASTNodeType } from './types.js';
import { tokenizeJCL, parseJCLFields, type JCLFields } from './jcl-tokenizer.js';

export class JCLParser {
  private tokens: Token[] = [];
  private pos = 0;

  /**
   * Parse raw JCL source into an AST.
   */
  parse(source: string): ASTNode {
    this.tokens = tokenizeJCL(source);
    this.pos = 0;
    return this.parseJob();
  }

  // ---- Helpers ----

  private peek(): Token {
    return this.tokens[this.pos] || { type: TokenType.EOF, value: '', line: 0, column: 0, raw: '' };
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    this.pos++;
    return t;
  }

  private isEOF(): boolean {
    return this.pos >= this.tokens.length || this.peek().type === TokenType.EOF;
  }

  // ---- Recursive Descent ----

  /**
   * Parse a JCL JOB — the top-level container.
   * JOB card followed by one or more EXEC steps.
   */
  private parseJob(): ASTNode {
    const children: ASTNode[] = [];
    let jobName = 'UNNAMED_JOB';
    let startLine = 1;
    let endLine = 1;

    while (!this.isEOF()) {
      const token = this.peek();

      // Skip comments
      if (token.type === TokenType.JCL_COMMENT) {
        this.advance();
        continue;
      }

      // Skip delimiters
      if (token.type === TokenType.JCL_DELIMITER) {
        this.advance();
        continue;
      }

      if (token.type === TokenType.JCL_STATEMENT) {
        const fields = parseJCLFields(token.value);

        if (fields.operation === 'JOB') {
          jobName = fields.name;
          startLine = token.line;
          this.advance();
          continue;
        }

        if (fields.operation === 'EXEC') {
          children.push(this.parseExecStep());
          continue;
        }

        if (fields.operation === 'DD') {
          children.push(this.parseDDStatement(fields, token));
          this.advance();
          continue;
        }

        // Unknown statement — skip
        this.advance();
        continue;
      }

      this.advance();
    }

    endLine = this.tokens[this.tokens.length - 1]?.line || startLine;

    return {
      type: ASTNodeType.JCL_JOB,
      name: jobName,
      children,
      meta: {},
      loc: { startLine, endLine },
    };
  }

  /**
   * Parse an EXEC step — either PGM= or PROC=.
   */
  private parseExecStep(): ASTNode {
    const token = this.advance();
    const fields = parseJCLFields(token.value);
    const children: ASTNode[] = [];
    const startLine = token.line;

    let stepType: ASTNodeType;
    let target: string;

    if (fields.operands['PGM']) {
      stepType = ASTNodeType.JCL_EXEC;
      target = fields.operands['PGM'];
    } else if (fields.operands['PROC']) {
      stepType = ASTNodeType.JCL_PROC_CALL;
      target = fields.operands['PROC'];
    } else if (fields.positionalOperands.length > 0) {
      // Positional EXEC — e.g., "// EXEC MYPROC"
      stepType = ASTNodeType.JCL_PROC_CALL;
      target = fields.positionalOperands[0];
    } else {
      stepType = ASTNodeType.JCL_EXEC;
      target = 'UNKNOWN';
    }

    // Collect DD statements that belong to this step
    while (!this.isEOF()) {
      const next = this.peek();
      if (next.type === TokenType.JCL_COMMENT) {
        this.advance();
        continue;
      }
      if (next.type === TokenType.JCL_STATEMENT) {
        const nextFields = parseJCLFields(next.value);
        if (nextFields.operation === 'DD') {
          children.push(this.parseDDStatement(nextFields, next));
          this.advance();
          continue;
        }
        // If we hit another EXEC or JOB, stop
        break;
      }
      break;
    }

    const endLine = children.length > 0
      ? children[children.length - 1].loc.endLine
      : token.line;

    return {
      type: stepType,
      name: fields.name,
      children,
      meta: {
        target,
        parm: fields.operands['PARM'] || '',
      },
      loc: { startLine, endLine },
    };
  }

  /**
   * Parse a DD (Data Definition) statement.
   */
  private parseDDStatement(fields: JCLFields, token: Token): ASTNode {
    const dsn = fields.operands['DSN'] || fields.operands['DSNAME'] || '';
    const disp = fields.operands['DISP'] || '';

    return {
      type: ASTNodeType.JCL_DD,
      name: fields.name,
      children: [],
      meta: {
        dsn,
        disp,
        sysout: fields.operands['SYSOUT'] || '',
        space: fields.operands['SPACE'] || '',
        dcb: fields.operands['DCB'] || '',
      },
      loc: { startLine: token.line, endLine: token.line },
    };
  }
}
