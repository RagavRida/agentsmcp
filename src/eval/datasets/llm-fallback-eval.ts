/**
 * LLM Fallback Evaluation Suite
 *
 * Tests the LLM Fallback Extractor in isolation (NOT the deterministic parser).
 * Three categories of test fragments:
 *
 *   CONTROL_CASES  — Simple rules the LLM must extract perfectly
 *   EDGE_CASES     — Complex patterns that stress the prompt
 *   MUST_REFUSE    — Code the LLM should NOT extract rules from
 *
 * This is the "start with evals, not prompts" principle in action.
 */

import type { UnrecognizedFragment, LLMExtractedRule } from "../../parser/llm-fallback";

export type EvalCategory = "CONTROL" | "EDGE" | "MUST_REFUSE";

export interface LLMFallbackTestCase {
  id: string;
  category: EvalCategory;
  description: string;
  fragment: UnrecognizedFragment;
  /** Expected rules. For MUST_REFUSE, this should be empty. */
  expectedRules: Array<{
    descriptionContains: string;
    type: string;
    expectedInputs?: string[];
    expectedOutputs?: string[];
    minConfidence?: number;
    maxConfidence?: number;
  }>;
}

// ── CONTROL CASES ─────────────────────────────────────────
// Simple, unambiguous COBOL patterns the LLM must handle correctly.

const CONTROL_CASES: LLMFallbackTestCase[] = [
  {
    id: "ctrl-001",
    category: "CONTROL",
    description: "Simple threshold check with assignment",
    fragment: {
      source: `IF VAR-001 > 10000
                MOVE "HIGH" TO VAR-002
                ADD 40 TO VAR-003
            END-IF.`,
      startLine: 50,
      endLine: 53,
      context: {
        programId: "TEST-PROG",
        paragraphName: "1000-CHECK",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "threshold",
        type: "IF",
        expectedInputs: ["VAR-001"],
        expectedOutputs: ["VAR-002", "VAR-003"],
        minConfidence: 0.8,
      },
    ],
  },
  {
    id: "ctrl-002",
    category: "CONTROL",
    description: "Simple COMPUTE with formula",
    fragment: {
      source: `COMPUTE VAR-001 = VAR-002 * VAR-003 / 100.`,
      startLine: 80,
      endLine: 80,
      context: {
        programId: "TEST-PROG",
        paragraphName: "2000-CALC",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "comput",
        type: "COMPUTE",
        expectedInputs: ["VAR-002", "VAR-003"],
        expectedOutputs: ["VAR-001"],
        minConfidence: 0.8,
      },
    ],
  },
  {
    id: "ctrl-003",
    category: "CONTROL",
    description: "ADD with GIVING",
    fragment: {
      source: `ADD VAR-001 VAR-002 GIVING VAR-003.`,
      startLine: 90,
      endLine: 90,
      context: {
        programId: "TEST-PROG",
        paragraphName: "3000-SUM",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "add",
        type: "ARITHMETIC",
        expectedInputs: ["VAR-001", "VAR-002"],
        expectedOutputs: ["VAR-003"],
        minConfidence: 0.8,
      },
    ],
  },
  {
    id: "ctrl-004",
    category: "CONTROL",
    description: "MOVE with string literal",
    fragment: {
      source: `MOVE "APPROVED" TO VAR-001.`,
      startLine: 100,
      endLine: 100,
      context: {
        programId: "TEST-PROG",
        paragraphName: "4000-STATUS",
        nearbyVariables: ["VAR-001"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "move",
        type: "DATA_ACCESS",
        expectedOutputs: ["VAR-001"],
        minConfidence: 0.7,
      },
    ],
  },
  {
    id: "ctrl-005",
    category: "CONTROL",
    description: "PERFORM with paragraph call",
    fragment: {
      source: `PERFORM 5000-VALIDATE-ACCOUNT
            PERFORM 6000-UPDATE-BALANCE.`,
      startLine: 110,
      endLine: 111,
      context: {
        programId: "TEST-PROG",
        paragraphName: "0000-MAIN",
        nearbyVariables: [],
      },
    },
    expectedRules: [
      {
        descriptionContains: "perform",
        type: "PERFORM",
        minConfidence: 0.7,
      },
    ],
  },
];

// ── EDGE CASES ────────────────────────────────────────────
// Complex patterns that push the LLM's extraction abilities.

const EDGE_CASES: LLMFallbackTestCase[] = [
  {
    id: "edge-001",
    category: "EDGE",
    description: "Nested EVALUATE with ALSO",
    fragment: {
      source: `EVALUATE VAR-001 ALSO VAR-002
                WHEN "A" ALSO "X"
                    MOVE 1 TO VAR-003
                WHEN "B" ALSO "Y"
                    MOVE 2 TO VAR-003
                WHEN OTHER
                    MOVE 0 TO VAR-003
            END-EVALUATE.`,
      startLine: 200,
      endLine: 208,
      context: {
        programId: "COMPLEX-PROG",
        paragraphName: "1000-CLASSIFY",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "evaluat",
        type: "CONTROL_FLOW",
        expectedInputs: ["VAR-001", "VAR-002"],
        expectedOutputs: ["VAR-003"],
        minConfidence: 0.5,
      },
    ],
  },
  {
    id: "edge-002",
    category: "EDGE",
    description: "Multi-line COMPUTE with continuation",
    fragment: {
      source: `COMPUTE VAR-001 =
                (VAR-002 * VAR-003)
                + (VAR-004 / VAR-005)
                - VAR-006.`,
      startLine: 220,
      endLine: 223,
      context: {
        programId: "COMPLEX-PROG",
        paragraphName: "2000-FORMULA",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003", "VAR-004", "VAR-005", "VAR-006"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "comput",
        type: "COMPUTE",
        expectedInputs: ["VAR-002", "VAR-003", "VAR-004", "VAR-005", "VAR-006"],
        expectedOutputs: ["VAR-001"],
        minConfidence: 0.5,
      },
    ],
  },
  {
    id: "edge-003",
    category: "EDGE",
    description: "PERFORM VARYING (counted loop)",
    fragment: {
      source: `PERFORM 3000-PROCESS
                VARYING VAR-001 FROM 1 BY 1
                UNTIL VAR-001 > VAR-002.`,
      startLine: 240,
      endLine: 242,
      context: {
        programId: "COMPLEX-PROG",
        paragraphName: "2500-LOOP",
        nearbyVariables: ["VAR-001", "VAR-002"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "loop",
        type: "CONTROL_FLOW",
        expectedInputs: ["VAR-001", "VAR-002"],
        minConfidence: 0.5,
      },
    ],
  },
  {
    id: "edge-004",
    category: "EDGE",
    description: "STRING concatenation",
    fragment: {
      source: `STRING VAR-001 DELIMITED BY SPACE
                VAR-002 DELIMITED BY SIZE
                INTO VAR-003
                WITH POINTER VAR-004.`,
      startLine: 260,
      endLine: 263,
      context: {
        programId: "COMPLEX-PROG",
        paragraphName: "4000-FORMAT",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003", "VAR-004"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "string",
        type: "DATA_ACCESS",
        expectedInputs: ["VAR-001", "VAR-002"],
        expectedOutputs: ["VAR-003"],
        minConfidence: 0.5,
      },
    ],
  },
  {
    id: "edge-005",
    category: "EDGE",
    description: "Deeply nested IF-ELSE (3 levels)",
    fragment: {
      source: `IF VAR-001 > 0
                IF VAR-002 = "Y"
                    IF VAR-003 < 100
                        MOVE "VALID" TO VAR-004
                    ELSE
                        MOVE "OVER-LIMIT" TO VAR-004
                    END-IF
                ELSE
                    MOVE "INACTIVE" TO VAR-004
                END-IF
            ELSE
                MOVE "NEGATIVE" TO VAR-004
            END-IF.`,
      startLine: 280,
      endLine: 292,
      context: {
        programId: "COMPLEX-PROG",
        paragraphName: "5000-VALIDATE",
        nearbyVariables: ["VAR-001", "VAR-002", "VAR-003", "VAR-004"],
      },
    },
    expectedRules: [
      {
        descriptionContains: "condition",
        type: "IF",
        expectedInputs: ["VAR-001", "VAR-002", "VAR-003"],
        expectedOutputs: ["VAR-004"],
        minConfidence: 0.5,
      },
    ],
  },
];

// ── MUST-REFUSE CASES ─────────────────────────────────────
// The LLM should return ZERO rules or confidence < 0.5 for these.

const MUST_REFUSE: LLMFallbackTestCase[] = [
  {
    id: "refuse-001",
    category: "MUST_REFUSE",
    description: "Dead code after STOP RUN",
    fragment: {
      source: `STOP RUN.
            MOVE "NEVER-REACHED" TO VAR-001.
            ADD 1 TO VAR-002.`,
      startLine: 300,
      endLine: 302,
      context: {
        programId: "DEAD-CODE",
        paragraphName: "9999-UNREACHABLE",
        nearbyVariables: ["VAR-001", "VAR-002"],
      },
    },
    expectedRules: [],
  },
  {
    id: "refuse-002",
    category: "MUST_REFUSE",
    description: "Comments only",
    fragment: {
      source: `      * This paragraph calculates the net settlement
      * amount after all deductions have been applied.
      * Author: J. Smith, 2024-01-15`,
      startLine: 310,
      endLine: 312,
      context: {
        programId: "COMMENTS-ONLY",
        paragraphName: "COMMENT-BLOCK",
        nearbyVariables: [],
      },
    },
    expectedRules: [],
  },
  {
    id: "refuse-003",
    category: "MUST_REFUSE",
    description: "Debug DISPLAY statements only",
    fragment: {
      source: `DISPLAY "DEBUG: Entering validation"
            DISPLAY "VAR-001 = " VAR-001
            DISPLAY "Processing complete".`,
      startLine: 320,
      endLine: 322,
      context: {
        programId: "DEBUG-ONLY",
        paragraphName: "DEBUG-TRACE",
        nearbyVariables: ["VAR-001"],
      },
    },
    expectedRules: [],
  },
  {
    id: "refuse-004",
    category: "MUST_REFUSE",
    description: "Data definition (no procedural logic)",
    fragment: {
      source: `01 WS-RECORD.
              05 WS-NAME       PIC X(30).
              05 WS-AMOUNT     PIC 9(12)V99.
              05 WS-DATE       PIC 9(8).
              05 WS-STATUS     PIC X(10).`,
      startLine: 10,
      endLine: 14,
      context: {
        programId: "DATA-DEF",
        paragraphName: "WORKING-STORAGE",
        nearbyVariables: [],
      },
    },
    expectedRules: [],
  },
  {
    id: "refuse-005",
    category: "MUST_REFUSE",
    description: "Empty paragraph with EXIT only",
    fragment: {
      source: `EXIT.`,
      startLine: 330,
      endLine: 330,
      context: {
        programId: "EXIT-ONLY",
        paragraphName: "9000-EXIT",
        nearbyVariables: [],
      },
    },
    expectedRules: [],
  },
];

// ── All Test Cases ─────────────────────────────────────────

export const LLM_FALLBACK_EVAL_CASES: LLMFallbackTestCase[] = [
  ...CONTROL_CASES,
  ...EDGE_CASES,
  ...MUST_REFUSE,
];

// ── Eval Runner ────────────────────────────────────────────

export interface LLMFallbackEvalResult {
  totalCases: number;
  controlScore: { passed: number; total: number; accuracy: number };
  edgeScore: { passed: number; total: number; accuracy: number };
  refuseScore: { passed: number; total: number; accuracy: number };
  overallAccuracy: number;
  failures: Array<{
    caseId: string;
    category: EvalCategory;
    reason: string;
    expected: unknown;
    actual: unknown;
  }>;
}

/**
 * Score a single test case against the LLM's actual output.
 */
function scoreCase(
  testCase: LLMFallbackTestCase,
  actualRules: LLMExtractedRule[]
): { passed: boolean; reason?: string } {
  if (testCase.category === "MUST_REFUSE") {
    // For refuse cases: pass if zero rules OR all rules have confidence < 0.5
    const highConfRules = actualRules.filter((r) => r.confidence >= 0.5);
    if (highConfRules.length === 0) return { passed: true };
    return {
      passed: false,
      reason: `Expected 0 high-confidence rules but got ${highConfRules.length}: ${highConfRules.map((r) => r.description).join(", ")}`,
    };
  }

  // For CONTROL and EDGE cases: check that expected rules are present
  if (testCase.expectedRules.length === 0) return { passed: true };

  for (const expected of testCase.expectedRules) {
    const match = actualRules.find((actual) => {
      const descMatch = actual.description
        .toLowerCase()
        .includes(expected.descriptionContains.toLowerCase());
      const typeMatch = actual.type === expected.type;
      const confMin =
        expected.minConfidence == null || actual.confidence >= expected.minConfidence;
      const confMax =
        expected.maxConfidence == null || actual.confidence <= expected.maxConfidence;
      return descMatch && typeMatch && confMin && confMax;
    });

    if (!match) {
      return {
        passed: false,
        reason: `Missing rule containing "${expected.descriptionContains}" of type ${expected.type}`,
      };
    }

    // Check inputs if specified
    if (expected.expectedInputs) {
      const missingInputs = expected.expectedInputs.filter(
        (v) => !match.inputs.includes(v)
      );
      if (missingInputs.length > 0) {
        return {
          passed: false,
          reason: `Rule found but missing inputs: ${missingInputs.join(", ")}`,
        };
      }
    }

    // Check outputs if specified
    if (expected.expectedOutputs) {
      const missingOutputs = expected.expectedOutputs.filter(
        (v) => !match.outputs.includes(v)
      );
      if (missingOutputs.length > 0) {
        return {
          passed: false,
          reason: `Rule found but missing outputs: ${missingOutputs.join(", ")}`,
        };
      }
    }
  }

  return { passed: true };
}

/**
 * Run the LLM Fallback eval suite against an extractor.
 *
 * Usage:
 *   const extractor = new LLMFallbackExtractor({ vllmUrl: "..." });
 *   const result = await runLLMFallbackEval(extractor);
 */
export async function runLLMFallbackEval(
  extractFn: (fragment: UnrecognizedFragment) => Promise<LLMExtractedRule[]>
): Promise<LLMFallbackEvalResult> {
  const failures: LLMFallbackEvalResult["failures"] = [];
  const scores = { CONTROL: { passed: 0, total: 0 }, EDGE: { passed: 0, total: 0 }, MUST_REFUSE: { passed: 0, total: 0 } };

  for (const testCase of LLM_FALLBACK_EVAL_CASES) {
    scores[testCase.category].total++;

    let actualRules: LLMExtractedRule[];
    try {
      actualRules = await extractFn(testCase.fragment);
    } catch {
      failures.push({
        caseId: testCase.id,
        category: testCase.category,
        reason: "LLM call threw an error",
        expected: testCase.expectedRules,
        actual: "ERROR",
      });
      continue;
    }

    const { passed, reason } = scoreCase(testCase, actualRules);
    if (passed) {
      scores[testCase.category].passed++;
    } else {
      failures.push({
        caseId: testCase.id,
        category: testCase.category,
        reason: reason || "Unknown failure",
        expected: testCase.expectedRules,
        actual: actualRules,
      });
    }
  }

  const controlScore = {
    ...scores.CONTROL,
    accuracy: scores.CONTROL.total > 0 ? scores.CONTROL.passed / scores.CONTROL.total : 0,
  };
  const edgeScore = {
    ...scores.EDGE,
    accuracy: scores.EDGE.total > 0 ? scores.EDGE.passed / scores.EDGE.total : 0,
  };
  const refuseScore = {
    ...scores.MUST_REFUSE,
    accuracy: scores.MUST_REFUSE.total > 0 ? scores.MUST_REFUSE.passed / scores.MUST_REFUSE.total : 0,
  };

  const totalPassed = controlScore.passed + edgeScore.passed + refuseScore.passed;
  const totalCases = controlScore.total + edgeScore.total + refuseScore.total;

  return {
    totalCases,
    controlScore,
    edgeScore,
    refuseScore,
    overallAccuracy: totalCases > 0 ? totalPassed / totalCases : 0,
    failures,
  };
}
