/**
 * Parser Errors — typed exceptions for the COBOL/JCL parser pipeline.
 *
 * Inspired by Cognee's per-module exception pattern.
 * Each error carries context (program, line, verb) for debugging.
 */

export class ParserError extends Error {
  readonly code: string;
  readonly program?: string;

  constructor(message: string, code: string, program?: string) {
    super(message);
    this.name = "ParserError";
    this.code = code;
    this.program = program;
  }
}

/** Thrown when the parser encounters a COBOL verb it doesn't recognize */
export class UnknownVerbError extends ParserError {
  readonly verb: string;
  readonly line: number;

  constructor(verb: string, line: number, program?: string) {
    super(
      `Unknown COBOL verb "${verb}" at line ${line}${program ? ` in ${program}` : ""}`,
      "UNKNOWN_VERB",
      program
    );
    this.name = "UnknownVerbError";
    this.verb = verb;
    this.line = line;
  }
}

/** Thrown when a COPY statement references a missing copybook */
export class MissingCopybookError extends ParserError {
  readonly copybook: string;

  constructor(copybook: string, program?: string) {
    super(
      `COPY statement references missing copybook "${copybook}"${program ? ` in ${program}` : ""}`,
      "MISSING_COPYBOOK",
      program
    );
    this.name = "MissingCopybookError";
    this.copybook = copybook;
  }
}

/** Thrown when the parser can't determine the PROGRAM-ID */
export class NoProgramIdError extends ParserError {
  constructor() {
    super("No PROGRAM-ID found in source", "NO_PROGRAM_ID");
    this.name = "NoProgramIdError";
  }
}

/** Thrown when the source is empty or contains no COBOL divisions */
export class EmptySourceError extends ParserError {
  constructor(reason: string) {
    super(`Empty or invalid COBOL source: ${reason}`, "EMPTY_SOURCE");
    this.name = "EmptySourceError";
  }
}

/** Thrown when JCL parsing fails */
export class JclParseError extends ParserError {
  readonly step?: string;

  constructor(message: string, step?: string) {
    super(message, "JCL_PARSE_ERROR");
    this.name = "JclParseError";
    this.step = step;
  }
}
