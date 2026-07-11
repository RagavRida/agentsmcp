/**
 * Unit tests for typed exceptions — error classes, codes, hierarchy.
 */
import { describe, it, expect } from "vitest";
import {
  // Parser
  ParserError, UnknownVerbError, MissingCopybookError,
  NoProgramIdError, EmptySourceError,
  // Storage
  StorageError, StorageNotInitializedError, ConnectionError as StorageConnectionError,
  AgentNotFoundError, BYOSError, GraphSyncError,
  // Search
  SearchError, EmbeddingError, NoResultsError,
  RaptorTreeNotFoundError, FlareExhaustedError, RouteError,
  // Verification
  VerificationError, MoneyConservationError, SignFlipError,
  RuleDroppedError, RoundingModeError, BatchImbalanceError,
  // Pipeline
  PipelineError, PipelineTimeoutError, StageFailureError,
  ConcurrentProcessingError,
} from "../../src/exceptions";

describe("Exceptions", () => {
  // ── Parser Errors ──────────────────────────────

  describe("Parser Errors", () => {
    it("UnknownVerbError carries verb and line", () => {
      const err = new UnknownVerbError("FOOBAR", 42, "LOAN-PROC");
      expect(err).toBeInstanceOf(ParserError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("UNKNOWN_VERB");
      expect(err.verb).toBe("FOOBAR");
      expect(err.line).toBe(42);
      expect(err.program).toBe("LOAN-PROC");
      expect(err.message).toContain("FOOBAR");
    });

    it("MissingCopybookError carries copybook name", () => {
      const err = new MissingCopybookError("FEE-TABLE", "PAY-PROC");
      expect(err.code).toBe("MISSING_COPYBOOK");
      expect(err.copybook).toBe("FEE-TABLE");
    });

    it("NoProgramIdError has correct code", () => {
      const err = new NoProgramIdError();
      expect(err.code).toBe("NO_PROGRAM_ID");
    });

    it("EmptySourceError includes reason", () => {
      const err = new EmptySourceError("no IDENTIFICATION DIVISION");
      expect(err.message).toContain("no IDENTIFICATION DIVISION");
    });
  });

  // ── Storage Errors ─────────────────────────────

  describe("Storage Errors", () => {
    it("StorageNotInitializedError names backend", () => {
      const err = new StorageNotInitializedError("SQLite");
      expect(err).toBeInstanceOf(StorageError);
      expect(err.code).toBe("NOT_INITIALIZED");
      expect(err.message).toContain("SQLite");
    });

    it("BYOSError carries operation and key", () => {
      const err = new BYOSError("PUT", "main/LOAN-PROC/parsed.json", "Access Denied");
      expect(err.operation).toBe("PUT");
      expect(err.key).toBe("main/LOAN-PROC/parsed.json");
      expect(err.message).toContain("Access Denied");
    });

    it("AgentNotFoundError carries agentId", () => {
      const err = new AgentNotFoundError("agent-xyz");
      expect(err.agentId).toBe("agent-xyz");
    });
  });

  // ── Verification Errors ────────────────────────

  describe("Verification Errors", () => {
    it("MoneyConservationError is CRITICAL", () => {
      const err = new MoneyConservationError(1000.00, 999.99);
      expect(err).toBeInstanceOf(VerificationError);
      expect(err.severity).toBe("CRITICAL");
      expect(err.difference).toBeCloseTo(0.01, 4);
    });

    it("SignFlipError carries field and directions", () => {
      const err = new SignFlipError("WS-BALANCE", "SUBTRACT", "ADD");
      expect(err.severity).toBe("CRITICAL");
      expect(err.field).toBe("WS-BALANCE");
      expect(err.cobolDirection).toBe("SUBTRACT");
      expect(err.migratedDirection).toBe("ADD");
    });

    it("BatchImbalanceError carries totals", () => {
      const err = new BatchImbalanceError(50000.00, 49999.50);
      expect(err.totalDebits).toBe(50000.00);
      expect(err.totalCredits).toBe(49999.50);
    });

    it("RoundingModeError names both modes", () => {
      const err = new RoundingModeError("HALF_EVEN", "HALF_UP");
      expect(err.message).toContain("HALF_EVEN");
      expect(err.message).toContain("HALF_UP");
    });
  });

  // ── Pipeline Errors ────────────────────────────

  describe("Pipeline Errors", () => {
    it("PipelineTimeoutError carries stage and timeout", () => {
      const err = new PipelineTimeoutError("embed", 30000);
      expect(err).toBeInstanceOf(PipelineError);
      expect(err.stage).toBe("embed");
      expect(err.timeoutMs).toBe(30000);
    });

    it("ConcurrentProcessingError names program", () => {
      const err = new ConcurrentProcessingError("LOAN-PROC");
      expect(err.program).toBe("LOAN-PROC");
      expect(err.stage).toBe("remember");
    });
  });

  // ── Search Errors ──────────────────────────────

  describe("Search Errors", () => {
    it("EmbeddingError carries endpoint", () => {
      const err = new EmbeddingError("https://modal.run/embed", "timeout");
      expect(err).toBeInstanceOf(SearchError);
      expect(err.endpoint).toContain("modal");
    });

    it("FlareExhaustedError carries iterations", () => {
      const err = new FlareExhaustedError(5, 5);
      expect(err.iterations).toBe(5);
      expect(err.maxIterations).toBe(5);
    });

    it("RaptorTreeNotFoundError names program", () => {
      const err = new RaptorTreeNotFoundError("PAY-BATCH");
      expect(err.program).toBe("PAY-BATCH");
      expect(err.message).toContain("remember()");
    });
  });

  // ── instanceof chain ───────────────────────────

  it("errors chain: specific → category → Error", () => {
    const err = new MoneyConservationError(100, 99);
    expect(err instanceof MoneyConservationError).toBe(true);
    expect(err instanceof VerificationError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
