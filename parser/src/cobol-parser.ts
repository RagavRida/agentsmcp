// ============================================================
// COBOL Parser — Recursive Descent for COBOL programs
// Extracts divisions, sections, paragraphs, and statements
// ============================================================

import { ASTNode, ASTNodeType } from './types.js';
import { parseCICS } from './cics-parser.js';
import { parseSQL } from './sql-parser.js';

/**
 * Parse raw COBOL source into an AST.
 *
 * COBOL structure:
 *   IDENTIFICATION DIVISION.
 *   DATA DIVISION.
 *     WORKING-STORAGE SECTION.
 *       01 WS-VAR PIC X(10).
 *   PROCEDURE DIVISION.
 *     MAIN-PARAGRAPH.
 *       PERFORM CALCULATE-TAX.
 *       EXEC SQL ... END-EXEC.
 *       EXEC CICS ... END-EXEC.
 *       CALL 'SUBPROG'.
 */
export class COBOLParser {
  private lines: string[] = [];
  private pos = 0;

  parse(source: string): ASTNode {
    // COBOL uses columns 7-72. Column 7 is the indicator area.
    // We normalize by trimming the sequence number area (cols 1-6)
    // and the identification area (cols 73-80).
    const rawLines = source.split('\n');
    const processed: string[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (line.length < 7) { processed.push(''); continue; }

      const indicator = line[6];

      // Column 7: '*' = comment, 'D' = debug — skip
      if (indicator === '*' || indicator === 'D') { processed.push(''); continue; }

      // Column 7: '-' = continuation — append to previous line
      if (indicator === '-') {
        const continuation = line.substring(7, Math.min(line.length, 72)).trimStart();
        // Find the last non-empty processed line and append
        for (let j = processed.length - 1; j >= 0; j--) {
          if (processed[j].trim() !== '') {
            processed[j] = processed[j] + ' ' + continuation;
            break;
          }
        }
        processed.push(''); // Placeholder for this line
        continue;
      }

      // Normal line: extract program text (columns 8-72)
      processed.push(line.substring(7, Math.min(line.length, 72)).trimEnd());
    }

    this.lines = processed;
    this.pos = 0;

    return this.parseProgram();
  }

  // ---- Helpers ----

  private peek(): string {
    while (this.pos < this.lines.length && this.lines[this.pos].trim() === '') {
      this.pos++;
    }
    return this.pos < this.lines.length ? this.lines[this.pos] : '';
  }

  private advance(): string {
    const line = this.peek();
    this.pos++;
    return line;
  }

  private isEOF(): boolean {
    return this.pos >= this.lines.length && this.peek() === '';
  }

  private currentLine(): number {
    return this.pos + 1;
  }

  // ---- Recursive Descent ----

  private parseProgram(): ASTNode {
    const children: ASTNode[] = [];
    let programName = 'UNNAMED';
    const startLine = 1;

    while (!this.isEOF()) {
      const line = this.peek().trim().toUpperCase();

      // Detect DIVISION headers
      if (line.includes('DIVISION')) {
        const div = this.parseDivision();
        if (div.type === ASTNodeType.COBOL_DIVISION_NODE && div.name === 'IDENTIFICATION') {
          // Extract PROGRAM-ID from IDENTIFICATION DIVISION
          for (const child of div.children) {
            if (child.name.startsWith('PROGRAM-ID')) {
              programName = (child.meta['value'] as string) || programName;
            }
          }
        }
        children.push(div);
        continue;
      }

      this.advance();
    }

    return {
      type: ASTNodeType.COBOL_PROGRAM,
      name: programName,
      children,
      meta: {},
      loc: { startLine, endLine: this.lines.length },
    };
  }

  private parseDivision(): ASTNode {
    const line = this.advance().trim().toUpperCase();
    const divName = line.replace(/\s*DIVISION\s*\.?\s*/, '').trim();
    const startLine = this.currentLine();
    const children: ASTNode[] = [];

    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();

      // Stop if we hit another DIVISION
      if (next.includes('DIVISION') && next !== line) break;

      // Detect SECTION headers
      if (next.includes('SECTION')) {
        children.push(this.parseSection());
        continue;
      }

      // Inside IDENTIFICATION DIVISION, look for PROGRAM-ID
      if (divName === 'IDENTIFICATION' && next.startsWith('PROGRAM-ID')) {
        const stmt = this.advance().trim();
        const value = stmt.replace(/PROGRAM-ID\s*\.\s*/i, '').replace(/\.$/, '').trim();
        children.push({
          type: ASTNodeType.COBOL_VARIABLE_NODE,
          name: 'PROGRAM-ID',
          children: [],
          meta: { value },
          loc: { startLine: this.currentLine(), endLine: this.currentLine() },
        });
        continue;
      }

      // Inside PROCEDURE DIVISION, detect paragraphs
      if (divName === 'PROCEDURE') {
        if (this.isParagraphHeader(next)) {
          children.push(this.parseParagraph());
          continue;
        }
      }

      // Inside DATA DIVISION (outside a SECTION), detect variables
      if (divName === 'DATA' || divName === 'WORKING-STORAGE') {
        if (/^\d{2}\s+/.test(next)) {
          children.push(this.parseVariable());
          continue;
        }
      }

      this.advance();
    }

    return {
      type: ASTNodeType.COBOL_DIVISION_NODE,
      name: divName,
      children,
      meta: {},
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseSection(): ASTNode {
    const line = this.advance().trim().toUpperCase();
    const secName = line.replace(/\s*SECTION\s*\.?\s*/, '').trim();
    const startLine = this.currentLine();
    const children: ASTNode[] = [];

    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      if (next.includes('DIVISION') || next.includes('SECTION')) break;

      // Detect variable declarations (level numbers)
      if (/^\d{2}\s+/.test(next)) {
        children.push(this.parseVariable());
        continue;
      }

      // Detect paragraphs
      if (this.isParagraphHeader(next)) {
        children.push(this.parseParagraph());
        continue;
      }

      this.advance();
    }

    return {
      type: ASTNodeType.COBOL_SECTION_NODE,
      name: secName,
      children,
      meta: {},
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseParagraph(): ASTNode {
    const headerLine = this.advance().trim();
    const paraName = headerLine.replace(/\.$/, '').trim().toUpperCase();
    const startLine = this.currentLine();
    const children: ASTNode[] = [];

    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();

      // Stop at next paragraph, section, or division
      if (next.includes('DIVISION') || next.includes('SECTION')) break;
      if (this.isParagraphHeader(next) && next.replace(/\.$/, '').trim() !== paraName) break;

      // ---- Extract meaningful statements ----

      // PERFORM
      if (next.startsWith('PERFORM')) {
        children.push(this.parsePerform());
        continue;
      }

      // CALL
      if (next.startsWith('CALL')) {
        children.push(this.parseCall());
        continue;
      }

      // EXEC SQL
      if (next.startsWith('EXEC SQL')) {
        children.push(this.parseExecSQL());
        continue;
      }

      // EXEC CICS
      if (next.startsWith('EXEC CICS')) {
        children.push(this.parseExecCICS());
        continue;
      }

      // COPY
      if (next.startsWith('COPY')) {
        children.push(this.parseCopy());
        continue;
      }

      // COMPUTE
      if (next.startsWith('COMPUTE')) {
        children.push(this.parseCompute());
        continue;
      }

      // MATH (ADD, SUBTRACT, MULTIPLY, DIVIDE)
      if (/^(ADD|SUBTRACT|MULTIPLY|DIVIDE)\b/.test(next)) {
        children.push(this.parseMath());
        continue;
      }

      // MOVE
      if (next.startsWith('MOVE')) {
        children.push(this.parseMove());
        continue;
      }

      // IF
      if (next.startsWith('IF')) {
        children.push(this.parseIf());
        continue;
      }

      // EVALUATE (switch/case)
      if (next.startsWith('EVALUATE')) {
        children.push(this.parseEvaluate());
        continue;
      }

      this.advance();
    }

    return {
      type: ASTNodeType.COBOL_PARAGRAPH_NODE,
      name: paraName,
      children,
      meta: {},
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  // ---- Statement Parsers ----

  private collectStatement(firstLine: string): string {
    let stmt = firstLine;
    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      if (next.includes('DIVISION') || next.includes('SECTION') || this.isParagraphHeader(next)) break;
      // Stop collecting when we hit the start of another statement
      if (/^(PERFORM|CALL|EXEC|COPY|COMPUTE|MOVE|IF|ELSE|END-IF|DISPLAY|ACCEPT|ADD|SUBTRACT|MULTIPLY|DIVIDE|STOP|EVALUATE|WHEN|END-EVALUATE|END-PERFORM|GO\b)/.test(next)) break;
      stmt += ' ' + this.advance().trim();
    }
    return stmt.trim();
  }

  private parsePerform(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    const match = stmt.match(/PERFORM\s+(\S+)/i);
    const target = match ? match[1].replace(/\.$/, '') : 'UNKNOWN';
    const untilMatch = stmt.match(/UNTIL\s+(.+?)(?:\.|$)/i);

    return {
      type: ASTNodeType.COBOL_PERFORM_NODE,
      name: target,
      children: [],
      meta: {
        target,
        until: untilMatch ? untilMatch[1].trim() : '',
      },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseCall(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    
    // Match CALL 'PROGRAM-NAME' or CALL PROGRAM-NAME
    const quotedMatch = stmt.match(/CALL\s+'([^']+)'/i);
    const unquotedMatch = stmt.match(/CALL\s+([A-Z0-9][A-Z0-9-]*)/i);
    const target = quotedMatch ? quotedMatch[1] : (unquotedMatch ? unquotedMatch[1] : 'UNKNOWN');

    // Extract USING parameters
    const usingMatch = stmt.match(/USING\s+(.+?)(?:\.|$)/i);
    const params = usingMatch
      ? usingMatch[1].split(/\s+/).filter((p) => p && p !== '.')
      : [];

    return {
      type: ASTNodeType.COBOL_CALL_NODE,
      name: target,
      children: [],
      meta: { target, params },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseExecSQL(): ASTNode {
    const startLine = this.currentLine();
    let sql = '';
    let line = this.advance().trim();

    // Collect everything between EXEC SQL and END-EXEC
    sql += line.replace(/EXEC\s+SQL\s*/i, '');
    while (!this.isEOF() && !sql.toUpperCase().includes('END-EXEC')) {
      line = this.advance().trim();
      sql += ' ' + line;
    }
    sql = sql.replace(/END-EXEC\s*\.?/i, '').trim();

    const parsed = parseSQL(sql);
    const operation = parsed.operation;
    const table = parsed.table || parsed.tables[0] || 'UNKNOWN';

    return {
      type: ASTNodeType.COBOL_EXEC_SQL_NODE,
      name: `SQL_${operation}`,
      children: [],
      meta: {
        operation,
        table,
        tables: parsed.tables,
        columns: parsed.columns,
        joins: parsed.joins,
        predicates: parsed.predicates,
        hostVariables: parsed.hostVariables,
        cursorName: parsed.cursorName,
        sql,
        parsedSql: parsed,
      },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseExecCICS(): ASTNode {
    const startLine = this.currentLine();
    let cics = '';
    let line = this.advance().trim();

    cics += line.replace(/EXEC\s+CICS\s*/i, '');
    while (!this.isEOF() && !cics.toUpperCase().includes('END-EXEC')) {
      line = this.advance().trim();
      cics += ' ' + line;
    }
    cics = cics.replace(/END-EXEC\s*\.?/i, '').trim();

    const parsed = parseCICS(cics);

    return {
      type: ASTNodeType.COBOL_EXEC_CICS_NODE,
      name: `CICS_${parsed.operation}`,
      children: [],
      meta: {
        command: parsed.operation,
        target: parsed.target,
        targetType: parsed.targetType,
        program: parsed.program,
        transid: parsed.transid,
        file: parsed.file,
        map: parsed.map,
        mapset: parsed.mapset,
        queue: parsed.queue,
        channel: parsed.channel,
        commarea: parsed.commarea,
        options: parsed.options,
        raw: cics,
        parsedCics: parsed,
      },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseCopy(): ASTNode {
    const line = this.advance().trim();
    const match = line.match(/COPY\s+(\S+)/i);
    const copybook = match ? match[1].replace(/\.$/, '') : 'UNKNOWN';

    return {
      type: ASTNodeType.COBOL_COPY_NODE,
      name: copybook,
      children: [],
      meta: { copybook },
      loc: { startLine: this.currentLine(), endLine: this.currentLine() },
    };
  }

  private parseVariable(): ASTNode {
    const line = this.advance().trim();
    const match = line.match(/^(\d{2})\s+(\S+)\s*(.*?)\.?\s*$/);

    const level = match ? match[1] : '01';
    const name = match ? match[2] : 'UNKNOWN';
    const definition = match ? match[3].trim() : '';

    // Check for REDEFINES
    const redefinesMatch = definition.match(/REDEFINES\s+(\S+)/i);
    if (redefinesMatch) {
      const redefinesTarget = redefinesMatch[1].replace(/\.$/, '');

      // Extract PIC from the REDEFINES line (may or may not have one)
      const picMatch = definition.match(/PIC\s+(\S+)/i);
      const pic = picMatch ? picMatch[1] : '';

      // Collect child variables of the REDEFINES group
      const children: ASTNode[] = [];
      while (!this.isEOF()) {
        const next = this.peek().trim().toUpperCase();
        // Sub-level items (05, 10, etc.) belong to this REDEFINES
        if (/^\d{2}\s+/.test(next)) {
          const nextLevel = parseInt(next.substring(0, 2), 10);
          const parentLevel = parseInt(level, 10);
          if (nextLevel > parentLevel) {
            children.push(this.parseVariable());
          } else {
            break;
          }
        } else {
          break;
        }
      }

      return {
        type: ASTNodeType.COBOL_REDEFINES_NODE,
        name,
        children,
        meta: { level, pic, redefinesTarget },
        loc: { startLine: this.currentLine(), endLine: this.currentLine() },
      };
    }

    // Extract PIC clause
    const picMatch = definition.match(/PIC\s+(\S+)/i);
    const pic = picMatch ? picMatch[1] : '';

    // Extract VALUE clause
    const valMatch = definition.match(/VALUE\s+(.+?)(?:\.|$)/i);
    const value = valMatch ? valMatch[1].trim().replace(/['.]/g, '') : '';

    // Check for Level 88 condition names that follow this variable
    const children: ASTNode[] = [];
    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      if (/^88\s+/.test(next)) {
        children.push(this.parseLevel88(name));
      } else {
        break;
      }
    }

    return {
      type: ASTNodeType.COBOL_VARIABLE_NODE,
      name,
      children,
      meta: { level, pic, value },
      loc: { startLine: this.currentLine(), endLine: this.currentLine() },
    };
  }

  private parseCompute(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    const match = stmt.match(/COMPUTE\s+(\S+)\s*=\s*(.+?)\.?\s*$/i);
    const target = match ? match[1] : 'UNKNOWN';
    const expression = match ? match[2].trim() : '';

    return {
      type: ASTNodeType.COBOL_COMPUTE_NODE,
      name: target,
      children: [],
      meta: { target, expression },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseMath(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    
    let target = 'UNKNOWN';
    let expression = 'UNKNOWN';
    
    if (stmt.toUpperCase().startsWith('ADD ')) {
      const match = stmt.match(/ADD\s+(.+?)\s+TO\s+(.+?)\.?\s*$/i);
      if (match) {
        expression = `${match[2].trim()} + ${match[1].trim()}`;
        target = match[2].trim();
      }
    } else if (stmt.toUpperCase().startsWith('SUBTRACT ')) {
      const match = stmt.match(/SUBTRACT\s+(.+?)\s+FROM\s+(.+?)\.?\s*$/i);
      if (match) {
        expression = `${match[2].trim()} - ${match[1].trim()}`;
        target = match[2].trim();
      }
    } else if (stmt.toUpperCase().startsWith('MULTIPLY ')) {
      const match = stmt.match(/MULTIPLY\s+(.+?)\s+BY\s+(.+?)\.?\s*$/i);
      if (match) {
        expression = `${match[2].trim()} * ${match[1].trim()}`;
        target = match[2].trim();
      }
    } else if (stmt.toUpperCase().startsWith('DIVIDE ')) {
      const match = stmt.match(/DIVIDE\s+(.+?)\s+INTO\s+(.+?)\.?\s*$/i);
      if (match) {
        expression = `${match[2].trim()} / ${match[1].trim()}`;
        target = match[2].trim();
      }
    }

    // Map all basic math directly to COMPUTE node for semantic elevator
    return {
      type: ASTNodeType.COBOL_COMPUTE_NODE,
      name: target,
      children: [],
      meta: { target, expression },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseMove(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    const match = stmt.match(/MOVE\s+(.+?)\s+TO\s+(.+?)\.?\s*$/i);
    const source = match ? match[1].trim() : 'UNKNOWN';
    const target = match ? match[2].trim() : 'UNKNOWN';

    return {
      type: ASTNodeType.COBOL_MOVE_NODE,
      name: `MOVE_TO_${target}`,
      children: [],
      meta: { source, target },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  private parseIf(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    const condMatch = stmt.match(/IF\s+(.+?)(?:\s+THEN)?$/i);
    const condition = condMatch ? condMatch[1].trim() : '';

    // Collect the IF-body (true branch)
    const thenChildren = this.collectIfBody();

    // Check for ELSE branch
    let elseChildren: ASTNode[] = [];
    if (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      if (next.startsWith('ELSE')) {
        this.advance(); // consume ELSE
        elseChildren = this.collectIfBody();
      }
    }

    // Consume END-IF if present
    if (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      if (next.startsWith('END-IF')) {
        this.advance();
      }
    }

    // Build children: true-branch statements, then optionally an ELSE node
    const children: ASTNode[] = [...thenChildren];
    if (elseChildren.length > 0) {
      children.push({
        type: ASTNodeType.COBOL_ELSE_NODE,
        name: 'ELSE',
        children: elseChildren,
        meta: {},
        loc: { startLine: this.currentLine(), endLine: this.currentLine() },
      });
    }

    return {
      type: ASTNodeType.COBOL_IF_NODE,
      name: 'IF',
      children,
      meta: { condition },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  /**
   * Collect statements inside an IF or ELSE block.
   * Stops at ELSE, END-IF, or paragraph/section boundary.
   */
  private collectIfBody(): ASTNode[] {
    const children: ASTNode[] = [];

    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();

      // Stop at ELSE or END-IF
      if (next.startsWith('ELSE') || next.startsWith('END-IF')) break;
      // Stop at structural boundaries
      if (next.includes('DIVISION') || next.includes('SECTION')) break;
      if (this.isParagraphHeader(next)) break;

      // Parse nested statements
      if (next.startsWith('PERFORM')) { children.push(this.parsePerform()); continue; }
      if (next.startsWith('MOVE')) { children.push(this.parseMove()); continue; }
      if (next.startsWith('COMPUTE')) { children.push(this.parseCompute()); continue; }
      if (/^(ADD|SUBTRACT|MULTIPLY|DIVIDE)\b/.test(next)) { children.push(this.parseMath()); continue; }
      if (next.startsWith('CALL')) { children.push(this.parseCall()); continue; }
      if (next.startsWith('EXEC SQL')) { children.push(this.parseExecSQL()); continue; }
      if (next.startsWith('EXEC CICS')) { children.push(this.parseExecCICS()); continue; }
      if (next.startsWith('IF')) { children.push(this.parseIf()); continue; } // Nested IF!
      if (next.startsWith('EVALUATE')) { children.push(this.parseEvaluate()); continue; }

      this.advance();
    }

    return children;
  }

  /**
   * Parse EVALUATE ... END-EVALUATE (COBOL's switch/case).
   * Extracts each WHEN branch as a child node.
   */
  private parseEvaluate(): ASTNode {
    const startLine = this.currentLine();
    const stmt = this.collectStatement(this.advance().trim());
    const subjectMatch = stmt.match(/EVALUATE\s+(.+?)$/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : 'UNKNOWN';

    const children: ASTNode[] = [];

    // Consume until END-EVALUATE
    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();

      if (next.startsWith('END-EVALUATE')) {
        this.advance();
        break;
      }

      if (next.startsWith('WHEN OTHER')) {
        this.advance();
        // Collect statements inside WHEN OTHER
        const whenChildren = this.collectWhenBody();
        children.push({
          type: ASTNodeType.COBOL_WHEN_NODE,
          name: 'WHEN_OTHER',
          children: whenChildren,
          meta: { condition: 'OTHER (default)' },
          loc: { startLine: this.currentLine(), endLine: this.currentLine() },
        });
        continue;
      }

      if (next.startsWith('WHEN')) {
        const whenLine = this.advance().trim();
        const condMatch = whenLine.match(/WHEN\s+(.+?)$/i);
        const condition = condMatch ? condMatch[1].trim() : 'UNKNOWN';

        // Collect statements inside this WHEN branch
        const whenChildren = this.collectWhenBody();

        children.push({
          type: ASTNodeType.COBOL_WHEN_NODE,
          name: `WHEN_${condition}`,
          children: whenChildren,
          meta: { condition },
          loc: { startLine: this.currentLine(), endLine: this.currentLine() },
        });
        continue;
      }

      this.advance();
    }

    return {
      type: ASTNodeType.COBOL_EVALUATE_NODE,
      name: 'EVALUATE',
      children,
      meta: { subject },
      loc: { startLine, endLine: this.currentLine() },
    };
  }

  /**
   * Collect statements inside a WHEN branch until the next WHEN or END-EVALUATE.
   */
  private collectWhenBody(): ASTNode[] {
    const children: ASTNode[] = [];

    while (!this.isEOF()) {
      const next = this.peek().trim().toUpperCase();
      // Stop at next WHEN or END-EVALUATE
      if (next.startsWith('WHEN') || next.startsWith('END-EVALUATE')) break;
      if (next.includes('DIVISION') || next.includes('SECTION')) break;
      if (this.isParagraphHeader(next)) break;

      if (next.startsWith('PERFORM')) { children.push(this.parsePerform()); continue; }
      if (next.startsWith('MOVE')) { children.push(this.parseMove()); continue; }
      if (next.startsWith('COMPUTE')) { children.push(this.parseCompute()); continue; }
      if (/^(ADD|SUBTRACT|MULTIPLY|DIVIDE)\b/.test(next)) { children.push(this.parseMath()); continue; }
      if (next.startsWith('CALL')) { children.push(this.parseCall()); continue; }
      if (next.startsWith('IF')) { children.push(this.parseIf()); continue; }

      this.advance();
    }

    return children;
  }

  /**
   * Parse Level 88 condition names.
   * 88 WS-EOF-YES VALUE 'Y'.
   * These define named boolean conditions on their parent variable.
   */
  private parseLevel88(parentVarName: string): ASTNode {
    const line = this.advance().trim();
    const match = line.match(/^88\s+(\S+)\s+VALUE[S]?\s+(.+?)\.?\s*$/i);
    const condName = match ? match[1] : 'UNKNOWN';
    const condValue = match ? match[2].trim().replace(/'/g, '"') : '';

    return {
      type: ASTNodeType.COBOL_CONDITION_88_NODE,
      name: condName,
      children: [],
      meta: {
        parentVariable: parentVarName,
        conditionValue: condValue,
      },
      loc: { startLine: this.currentLine(), endLine: this.currentLine() },
    };
  }

  // ---- Utility ----

  /**
   * Determines if a line is a paragraph header.
   * Paragraph headers are names ending with a period,
   * NOT starting with a level number, and NOT containing keywords.
   */
  private isParagraphHeader(line: string): boolean {
    const trimmed = line.trim().toUpperCase();
    if (!trimmed) return false;
    if (/^\d{2}\s+/.test(trimmed)) return false;
    if (trimmed.includes('DIVISION')) return false;
    if (trimmed.includes('SECTION')) return false;
    if (trimmed.startsWith('PERFORM')) return false;
    if (trimmed.startsWith('CALL')) return false;
    if (trimmed.startsWith('EXEC')) return false;
    if (trimmed.startsWith('MOVE')) return false;
    if (trimmed.startsWith('COMPUTE')) return false;
    if (trimmed.startsWith('IF')) return false;
    if (trimmed.startsWith('COPY')) return false;
    if (trimmed.startsWith('STOP')) return false;
    if (trimmed.startsWith('DISPLAY')) return false;
    if (trimmed.startsWith('EVALUATE')) return false;
    if (trimmed.startsWith('WHEN')) return false;
    if (trimmed.startsWith('END-')) return false;
    if (trimmed.startsWith('ADD')) return false;
    if (trimmed.startsWith('SUBTRACT')) return false;
    if (trimmed.startsWith('MULTIPLY')) return false;
    if (trimmed.startsWith('DIVIDE')) return false;
    if (trimmed.startsWith('ACCEPT')) return false;
    // A paragraph header is a single name followed by a period
    return /^[A-Z0-9][\w-]*\s*\.\s*$/.test(trimmed);
  }
}
