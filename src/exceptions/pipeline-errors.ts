/**
 * Pipeline Errors — typed exceptions for the remember/recall/forget pipeline.
 */

export class PipelineError extends Error {
  readonly code: string;
  readonly stage: string;

  constructor(message: string, code: string, stage: string) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.stage = stage;
  }
}

/** Pipeline timed out */
export class PipelineTimeoutError extends PipelineError {
  readonly timeoutMs: number;

  constructor(stage: string, timeoutMs: number) {
    super(`Pipeline timed out at stage "${stage}" after ${timeoutMs}ms`, "TIMEOUT", stage);
    this.name = "PipelineTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A pipeline stage failed */
export class StageFailureError extends PipelineError {
  readonly cause: string;

  constructor(stage: string, cause: string) {
    super(`Pipeline stage "${stage}" failed: ${cause}`, "STAGE_FAILURE", stage);
    this.name = "StageFailureError";
    this.cause = cause;
  }
}

/** Program already being processed (concurrent remember on same program) */
export class ConcurrentProcessingError extends PipelineError {
  readonly program: string;

  constructor(program: string) {
    super(
      `Program "${program}" is already being processed. Wait for current pipeline to complete.`,
      "CONCURRENT",
      "remember"
    );
    this.name = "ConcurrentProcessingError";
    this.program = program;
  }
}
