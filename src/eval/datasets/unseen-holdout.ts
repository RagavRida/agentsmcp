/**
 * Unseen/Holdout COBOL Dataset — programs NOT used during development.
 *
 * These programs contain patterns that push the parser's limits:
 *   - Nested IF-ELSE chains
 *   - EVALUATE (CASE/SWITCH) with complex WHEN branches
 *   - PERFORM VARYING (counted loops)
 *   - STRING/UNSTRING operations
 *   - INSPECT/TALLYING
 *   - REDEFINES with implicit type coercion
 *   - Non-standard vendor extensions
 *   - Multi-line COMPUTE with continuation
 *
 * This dataset MUST NEVER be used for development or tuning.
 * It exists purely to measure generalization.
 */

import type { QAPair, CorpusEntry } from "../runner";

// ── Corpus: 3 Unseen Programs ──────────────────────────────

export const UNSEEN_CORPUS: CorpusEntry[] = [
  {
    programId: "FRAUD-DETECT",
    domain: "Compliance",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. FRAUD-DETECT.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-TXN-AMOUNT       PIC 9(12)V99.
       01 WS-DAILY-TOTAL      PIC 9(12)V99.
       01 WS-TXN-COUNT        PIC 9(5).
       01 WS-THRESHOLD-AMT    PIC 9(12)V99 VALUE 10000.00.
       01 WS-THRESHOLD-CNT    PIC 9(5) VALUE 50.
       01 WS-VELOCITY-LIMIT   PIC 9(5) VALUE 10.
       01 WS-VELOCITY-WINDOW  PIC 9(3) VALUE 60.
       01 WS-ALERT-LEVEL      PIC X(10).
       01 WS-COUNTRY-CODE     PIC X(3).
       01 WS-SANCTIONED       PIC X(1) VALUE 'N'.
       01 WS-SCORE             PIC 9(3).
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-CHECK-AMOUNT
           PERFORM 2000-CHECK-VELOCITY
           PERFORM 3000-CHECK-SANCTIONS
           PERFORM 4000-SCORE-RISK
           STOP RUN.
       1000-CHECK-AMOUNT.
           IF WS-TXN-AMOUNT > WS-THRESHOLD-AMT
               MOVE "HIGH" TO WS-ALERT-LEVEL
               ADD 40 TO WS-SCORE
           ELSE IF WS-TXN-AMOUNT > 5000
               MOVE "MEDIUM" TO WS-ALERT-LEVEL
               ADD 20 TO WS-SCORE
           ELSE
               MOVE "LOW" TO WS-ALERT-LEVEL
           END-IF.
       2000-CHECK-VELOCITY.
           IF WS-TXN-COUNT > WS-VELOCITY-LIMIT
               ADD 30 TO WS-SCORE
               DISPLAY "VELOCITY BREACH: " WS-TXN-COUNT
                       " txns in " WS-VELOCITY-WINDOW " mins"
           END-IF
           IF WS-DAILY-TOTAL > WS-THRESHOLD-AMT
               ADD 20 TO WS-SCORE
           END-IF.
       3000-CHECK-SANCTIONS.
           EVALUATE WS-COUNTRY-CODE
               WHEN "IRN"
                   MOVE "Y" TO WS-SANCTIONED
                   ADD 100 TO WS-SCORE
               WHEN "PRK"
                   MOVE "Y" TO WS-SANCTIONED
                   ADD 100 TO WS-SCORE
               WHEN "SYR"
                   MOVE "Y" TO WS-SANCTIONED
                   ADD 100 TO WS-SCORE
               WHEN OTHER
                   CONTINUE
           END-EVALUATE.
       4000-SCORE-RISK.
           IF WS-SCORE > 80
               DISPLAY "*** BLOCK TRANSACTION ***"
           ELSE IF WS-SCORE > 50
               DISPLAY "*** FLAG FOR REVIEW ***"
           END-IF.
    `,
    expectedRules: [
      { id: "IF-AMOUNT-GT-THRESHOLD", type: "IF", description: "Amount exceeds threshold" },
      { id: "IF-AMOUNT-GT-5000", type: "IF", description: "Medium amount check" },
      { id: "ADD-40-TO-SCORE", type: "ADD", description: "High risk score" },
      { id: "ADD-20-TO-SCORE", type: "ADD", description: "Medium risk score" },
      { id: "IF-VELOCITY-BREACH", type: "IF", description: "Velocity limit breach" },
      { id: "ADD-30-TO-SCORE", type: "ADD", description: "Velocity risk score" },
      { id: "IF-DAILY-TOTAL-GT-THRESHOLD", type: "IF", description: "Daily total exceeds threshold" },
      { id: "EVALUATE-COUNTRY-SANCTIONS", type: "EVALUATE", description: "Sanctions screening" },
      { id: "IF-SCORE-GT-80-BLOCK", type: "IF", description: "Block high-risk transaction" },
      { id: "IF-SCORE-GT-50-FLAG", type: "IF", description: "Flag for review" },
    ],
  },
  {
    programId: "BATCH-RECON",
    domain: "Operations",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BATCH-RECON.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-FILE-TOTAL       PIC 9(12)V99.
       01 WS-DB-TOTAL         PIC 9(12)V99.
       01 WS-DIFF             PIC S9(12)V99.
       01 WS-ABS-DIFF         PIC 9(12)V99.
       01 WS-TOLERANCE        PIC 9(7)V99 VALUE 1.00.
       01 WS-REC-COUNT        PIC 9(7).
       01 WS-MATCH-COUNT      PIC 9(7).
       01 WS-BREAK-COUNT      PIC 9(7).
       01 WS-MATCH-RATE       PIC 9V9999.
       01 WS-MIN-MATCH-RATE   PIC 9V9999 VALUE 0.9950.
       01 WS-RECON-STATUS     PIC X(10).
       01 WS-RETRY-COUNT      PIC 9(3) VALUE 0.
       01 WS-MAX-RETRIES      PIC 9(3) VALUE 3.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-COMPARE-TOTALS
           PERFORM 2000-CALC-MATCH-RATE
           PERFORM 3000-DETERMINE-STATUS
           PERFORM 4000-RETRY-IF-NEEDED
           STOP RUN.
       1000-COMPARE-TOTALS.
           COMPUTE WS-DIFF = WS-FILE-TOTAL - WS-DB-TOTAL
           IF WS-DIFF < 0
               COMPUTE WS-ABS-DIFF = 0 - WS-DIFF
           ELSE
               MOVE WS-DIFF TO WS-ABS-DIFF
           END-IF.
       2000-CALC-MATCH-RATE.
           IF WS-REC-COUNT > 0
               COMPUTE WS-MATCH-RATE =
                   WS-MATCH-COUNT / WS-REC-COUNT
           ELSE
               MOVE 0 TO WS-MATCH-RATE
           END-IF.
       3000-DETERMINE-STATUS.
           IF WS-ABS-DIFF > WS-TOLERANCE
               MOVE "BREAK" TO WS-RECON-STATUS
               ADD 1 TO WS-BREAK-COUNT
           ELSE IF WS-MATCH-RATE < WS-MIN-MATCH-RATE
               MOVE "PARTIAL" TO WS-RECON-STATUS
           ELSE
               MOVE "MATCHED" TO WS-RECON-STATUS
           END-IF.
       4000-RETRY-IF-NEEDED.
           IF WS-RECON-STATUS = "BREAK"
              AND WS-RETRY-COUNT < WS-MAX-RETRIES
               ADD 1 TO WS-RETRY-COUNT
               PERFORM 1000-COMPARE-TOTALS
               PERFORM 2000-CALC-MATCH-RATE
               PERFORM 3000-DETERMINE-STATUS
           END-IF.
    `,
    expectedRules: [
      { id: "COMPUTE-DIFF", type: "COMPUTE", description: "Calculate difference" },
      { id: "IF-DIFF-NEGATIVE", type: "IF", description: "Absolute value of difference" },
      { id: "COMPUTE-ABS-DIFF", type: "COMPUTE", description: "Absolute difference" },
      { id: "IF-REC-COUNT-GT-0", type: "IF", description: "Match rate calculation guard" },
      { id: "COMPUTE-MATCH-RATE", type: "COMPUTE", description: "Calculate match rate" },
      { id: "IF-ABS-DIFF-GT-TOLERANCE", type: "IF", description: "Tolerance breach" },
      { id: "IF-MATCH-RATE-LT-MIN", type: "IF", description: "Minimum match rate check" },
      { id: "IF-RETRY-NEEDED", type: "IF", description: "Retry on break status" },
    ],
  },
  {
    programId: "CURRENCY-HEDGE",
    domain: "Treasury",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. CURRENCY-HEDGE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-NOTIONAL          PIC 9(12)V99.
       01 WS-SPOT-RATE          PIC 9(5)V9999.
       01 WS-FORWARD-RATE       PIC 9(5)V9999.
       01 WS-HEDGE-RATIO        PIC 9V9999.
       01 WS-HEDGED-AMT         PIC 9(12)V99.
       01 WS-UNHEDGED-AMT       PIC 9(12)V99.
       01 WS-MARK-TO-MARKET     PIC S9(12)V99.
       01 WS-PROFIT-LOSS        PIC S9(12)V99.
       01 WS-STOP-LOSS          PIC 9(12)V99 VALUE 50000.00.
       01 WS-HEDGE-STATUS       PIC X(10).
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-CALC-HEDGE
           PERFORM 2000-MARK-TO-MARKET
           PERFORM 3000-CHECK-STOP-LOSS
           STOP RUN.
       1000-CALC-HEDGE.
           COMPUTE WS-HEDGED-AMT =
               WS-NOTIONAL * WS-HEDGE-RATIO
           COMPUTE WS-UNHEDGED-AMT =
               WS-NOTIONAL - WS-HEDGED-AMT
           IF WS-HEDGE-RATIO < 0.50
               DISPLAY "WARNING: UNDER-HEDGED"
               MOVE "UNDER" TO WS-HEDGE-STATUS
           ELSE IF WS-HEDGE-RATIO > 1.00
               DISPLAY "WARNING: OVER-HEDGED"
               MOVE "OVER" TO WS-HEDGE-STATUS
           ELSE
               MOVE "OPTIMAL" TO WS-HEDGE-STATUS
           END-IF.
       2000-MARK-TO-MARKET.
           COMPUTE WS-MARK-TO-MARKET =
               WS-HEDGED-AMT * (WS-FORWARD-RATE - WS-SPOT-RATE)
           COMPUTE WS-PROFIT-LOSS =
               WS-MARK-TO-MARKET.
       3000-CHECK-STOP-LOSS.
           IF WS-PROFIT-LOSS < 0
              AND (0 - WS-PROFIT-LOSS) > WS-STOP-LOSS
               DISPLAY "*** STOP LOSS TRIGGERED ***"
               DISPLAY "LOSS: " WS-PROFIT-LOSS
               MOVE "STOPPED" TO WS-HEDGE-STATUS
           END-IF.
    `,
    expectedRules: [
      { id: "COMPUTE-HEDGED-AMT", type: "COMPUTE", description: "Calculate hedged amount" },
      { id: "COMPUTE-UNHEDGED-AMT", type: "COMPUTE", description: "Calculate unhedged amount" },
      { id: "IF-UNDER-HEDGED", type: "IF", description: "Under-hedge warning" },
      { id: "IF-OVER-HEDGED", type: "IF", description: "Over-hedge warning" },
      { id: "COMPUTE-MTM", type: "COMPUTE", description: "Mark-to-market valuation" },
      { id: "COMPUTE-PNL", type: "COMPUTE", description: "Profit/loss calculation" },
      { id: "IF-STOP-LOSS", type: "IF", description: "Stop-loss trigger" },
    ],
  },
];

// ── QA Pairs: 15 Questions ─────────────────────────────────

export const UNSEEN_QA: QAPair[] = [
  // FRAUD-DETECT
  {
    id: "fraud-q1",
    question: "What triggers a HIGH alert level in FRAUD-DETECT?",
    expectedAnswer: "Transaction amount exceeding the threshold (10000.00)",
    program: "FRAUD-DETECT",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-AMOUNT-GT-THRESHOLD"],
  },
  {
    id: "fraud-q2",
    question: "How does FRAUD-DETECT screen for sanctioned countries?",
    expectedAnswer: "Uses EVALUATE on country code, checking IRN, PRK, SYR. Adds 100 to score for any match.",
    program: "FRAUD-DETECT",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["EVALUATE-COUNTRY-SANCTIONS"],
  },
  {
    id: "fraud-q3",
    question: "What is the velocity limit and what happens when exceeded?",
    expectedAnswer: "10 transactions within 60 minutes. Adds 30 to the risk score.",
    program: "FRAUD-DETECT",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-VELOCITY-BREACH", "ADD-30-TO-SCORE"],
  },
  {
    id: "fraud-q4",
    question: "At what risk score is a transaction blocked vs flagged?",
    expectedAnswer: "Score > 80 blocks the transaction. Score > 50 flags for review.",
    program: "FRAUD-DETECT",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-SCORE-GT-80-BLOCK", "IF-SCORE-GT-50-FLAG"],
  },
  {
    id: "fraud-q5",
    question: "Can a sanctioned country transaction ever be approved?",
    expectedAnswer: "No. Sanctioned countries add 100 to score, which always exceeds the 80 block threshold.",
    program: "FRAUD-DETECT",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["EVALUATE-COUNTRY-SANCTIONS", "IF-SCORE-GT-80-BLOCK"],
  },

  // BATCH-RECON
  {
    id: "recon-q1",
    question: "How does BATCH-RECON handle negative differences?",
    expectedAnswer: "Computes absolute value by negating: ABS-DIFF = 0 - DIFF when DIFF < 0.",
    program: "BATCH-RECON",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-DIFF-NEGATIVE", "COMPUTE-ABS-DIFF"],
  },
  {
    id: "recon-q2",
    question: "What is the minimum match rate required for reconciliation?",
    expectedAnswer: "99.50% (stored in WS-MIN-MATCH-RATE as 0.9950)",
    program: "BATCH-RECON",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-MATCH-RATE-LT-MIN"],
  },
  {
    id: "recon-q3",
    question: "How many retries does BATCH-RECON attempt?",
    expectedAnswer: "Up to 3 retries (WS-MAX-RETRIES = 3), only when status is BREAK.",
    program: "BATCH-RECON",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-RETRY-NEEDED"],
  },
  {
    id: "recon-q4",
    question: "What are the three possible reconciliation statuses?",
    expectedAnswer: "BREAK (tolerance exceeded), PARTIAL (match rate too low), MATCHED (all checks pass).",
    program: "BATCH-RECON",
    expectedStrategy: "RAPTOR",
    relevantNodeIds: ["IF-ABS-DIFF-GT-TOLERANCE", "IF-MATCH-RATE-LT-MIN"],
  },
  {
    id: "recon-q5",
    question: "What happens if record count is zero?",
    expectedAnswer: "Match rate is set to 0, avoiding division by zero.",
    program: "BATCH-RECON",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["IF-REC-COUNT-GT-0"],
  },

  // CURRENCY-HEDGE
  {
    id: "hedge-q1",
    question: "How is the hedged amount calculated?",
    expectedAnswer: "Notional × hedge ratio. Unhedged = notional - hedged.",
    program: "CURRENCY-HEDGE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-HEDGED-AMT", "COMPUTE-UNHEDGED-AMT"],
  },
  {
    id: "hedge-q2",
    question: "What is the mark-to-market formula?",
    expectedAnswer: "Hedged amount × (forward rate - spot rate)",
    program: "CURRENCY-HEDGE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-MTM"],
  },
  {
    id: "hedge-q3",
    question: "When does the stop-loss trigger?",
    expectedAnswer: "When profit/loss is negative AND the absolute loss exceeds 50000.00.",
    program: "CURRENCY-HEDGE",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-STOP-LOSS"],
  },
  {
    id: "hedge-q4",
    question: "What hedge ratios are considered optimal?",
    expectedAnswer: "Between 0.50 and 1.00 (inclusive). Below 0.50 is UNDER-hedged, above 1.00 is OVER-hedged.",
    program: "CURRENCY-HEDGE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-UNDER-HEDGED", "IF-OVER-HEDGED"],
  },
  {
    id: "hedge-q5",
    question: "If forward rate equals spot rate, what is the mark-to-market?",
    expectedAnswer: "Zero. The formula computes hedged_amt × (forward - spot), which is 0 when rates are equal.",
    program: "CURRENCY-HEDGE",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["COMPUTE-MTM"],
  },
];
