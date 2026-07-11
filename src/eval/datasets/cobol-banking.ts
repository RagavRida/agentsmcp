/**
 * COBOL Banking QA Dataset — the AgentMailbox equivalent of HotpotQA.
 *
 * 25 question-answer pairs across 5 COBOL programs covering:
 *   - Loan processing (Risk domain)
 *   - Payment batch settlement (Payments domain)
 *   - Account maintenance (Core Banking)
 *   - Inter-bank transfer (SWIFT/Settlement)
 *   - Interest accrual (Treasury)
 *
 * Each QA pair has:
 *   - question: Natural language query an agent would ask
 *   - answer: Ground truth expected answer
 *   - level: easy | medium | hard
 *   - domain: Business domain
 *   - program: Source COBOL program
 *   - searchType: Expected search strategy
 *   - relevantNodes: IDs that should appear in results
 */

import type { QAPair, CorpusEntry } from "../runner";

// ── Corpus: 5 Real-ish COBOL Programs ──────────────────────

export const COBOL_BANKING_CORPUS: CorpusEntry[] = [
  {
    programId: "LOAN-PROC",
    domain: "Risk",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. LOAN-PROC.
       AUTHOR. AGENTSMCP-EVAL.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PRINCIPAL        PIC 9(9)V99.
       01 WS-RATE              PIC 9(3)V9999.
       01 WS-TERM-MONTHS       PIC 9(3).
       01 WS-MONTHLY-PAYMENT   PIC 9(9)V99.
       01 WS-TOTAL-INTEREST    PIC 9(9)V99.
       01 WS-RISK-SCORE        PIC 9(3).
       01 WS-MAX-DTI           PIC 9(3)V99 VALUE 43.00.
       01 WS-DTI               PIC 9(3)V99.
       01 WS-ANNUAL-INCOME     PIC 9(9)V99.
       01 WS-MONTHLY-DEBT      PIC 9(9)V99.
       01 WS-APPROVAL-STATUS   PIC X(8).
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-CALC-DTI
           PERFORM 2000-RISK-CHECK
           PERFORM 3000-CALC-PAYMENT
           STOP RUN.
       1000-CALC-DTI.
           COMPUTE WS-DTI = (WS-MONTHLY-DEBT / WS-ANNUAL-INCOME)
                             * 12 * 100
           IF WS-DTI > WS-MAX-DTI
               MOVE "REJECTED" TO WS-APPROVAL-STATUS
               DISPLAY "DTI EXCEEDS MAXIMUM: " WS-DTI
           END-IF.
       2000-RISK-CHECK.
           IF WS-RISK-SCORE < 620
               MOVE "REJECTED" TO WS-APPROVAL-STATUS
               DISPLAY "RISK SCORE TOO LOW: " WS-RISK-SCORE
           ELSE IF WS-RISK-SCORE < 720
               ADD 50 TO WS-RATE
               DISPLAY "SUBPRIME RATE ADJUSTMENT APPLIED"
           END-IF.
       3000-CALC-PAYMENT.
           COMPUTE WS-MONTHLY-PAYMENT =
               WS-PRINCIPAL * (WS-RATE / 1200)
               / (1 - (1 + WS-RATE / 1200)
               ** (0 - WS-TERM-MONTHS))
           COMPUTE WS-TOTAL-INTEREST =
               (WS-MONTHLY-PAYMENT * WS-TERM-MONTHS)
               - WS-PRINCIPAL.
    `,
    expectedRules: [
      { id: "COMPUTE-WS-DTI", type: "COMPUTE", description: "Calculate debt-to-income ratio" },
      { id: "IF-WS-DTI-GT-WS-MAX-DTI", type: "IF", description: "DTI exceeds maximum threshold" },
      { id: "IF-WS-RISK-SCORE-LT-620", type: "IF", description: "Risk score below minimum" },
      { id: "IF-WS-RISK-SCORE-LT-720", type: "IF", description: "Subprime rate adjustment" },
      { id: "ADD-50-TO-WS-RATE", type: "ADD", description: "Add subprime rate surcharge" },
      { id: "COMPUTE-WS-MONTHLY-PAYMENT", type: "COMPUTE", description: "Amortized payment formula" },
      { id: "COMPUTE-WS-TOTAL-INTEREST", type: "COMPUTE", description: "Total interest over term" },
    ],
  },
  {
    programId: "PAY-SETTLE",
    domain: "Payments",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. PAY-SETTLE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-BATCH-ID         PIC X(12).
       01 WS-TOTAL-DEBITS     PIC 9(12)V99.
       01 WS-TOTAL-CREDITS    PIC 9(12)V99.
       01 WS-NET-POSITION     PIC S9(12)V99.
       01 WS-TOLERANCE        PIC 9(5)V99 VALUE 0.01.
       01 WS-SETTLE-STATUS    PIC X(10).
       01 WS-ERROR-COUNT      PIC 9(5) VALUE 0.
       01 WS-REVERSAL-AMT     PIC 9(12)V99.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-VALIDATE-BATCH
           PERFORM 2000-SETTLE
           PERFORM 3000-RECONCILE
           STOP RUN.
       1000-VALIDATE-BATCH.
           IF WS-TOTAL-DEBITS = 0 AND WS-TOTAL-CREDITS = 0
               MOVE "EMPTY" TO WS-SETTLE-STATUS
               DISPLAY "EMPTY BATCH: " WS-BATCH-ID
           END-IF.
       2000-SETTLE.
           COMPUTE WS-NET-POSITION =
               WS-TOTAL-CREDITS - WS-TOTAL-DEBITS
           IF WS-NET-POSITION > WS-TOLERANCE
              OR WS-NET-POSITION < (0 - WS-TOLERANCE)
               MOVE "IMBALANCE" TO WS-SETTLE-STATUS
               ADD 1 TO WS-ERROR-COUNT
               DISPLAY "SETTLEMENT IMBALANCE: " WS-NET-POSITION
           ELSE
               MOVE "SETTLED" TO WS-SETTLE-STATUS
           END-IF.
       3000-RECONCILE.
           IF WS-SETTLE-STATUS = "IMBALANCE"
               COMPUTE WS-REVERSAL-AMT = WS-NET-POSITION
               DISPLAY "REVERSAL REQUIRED: " WS-REVERSAL-AMT
           END-IF.
    `,
    expectedRules: [
      { id: "IF-EMPTY-BATCH", type: "IF", description: "Empty batch validation" },
      { id: "COMPUTE-WS-NET-POSITION", type: "COMPUTE", description: "Net settlement position" },
      { id: "IF-WS-NET-POSITION-IMBALANCE", type: "IF", description: "Settlement imbalance check" },
      { id: "COMPUTE-WS-REVERSAL-AMT", type: "COMPUTE", description: "Reversal amount calculation" },
    ],
    // Correct settlement: a balanced batch (debits 5000 = credits 5000) with a
    // consistent net settlement leg. Exercises batch-settlement balance,
    // conservation, and debit/credit direction.
    safetyVectors: [
      {
        sourceAccount: "SETTLE-DEBIT",
        targetAccount: "SETTLE-CREDIT",
        amount: 5000.0,
        currency: "USD",
        fees: 0.0,
        sourceBalanceBefore: 10000.0,
        sourceBalanceAfter: 5000.0,
        targetBalanceBefore: 0.0,
        targetBalanceAfter: 5000.0,
        batchEntries: [
          { debit: 3000.0, credit: 0.0 },
          { debit: 2000.0, credit: 0.0 },
          { debit: 0.0, credit: 5000.0 },
        ],
      },
    ],
  },
  {
    programId: "ACCT-MAINT",
    domain: "CoreBanking",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ACCT-MAINT.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-ACCT-NUMBER      PIC 9(10).
       01 WS-ACCT-TYPE         PIC X(3).
       01 WS-BALANCE           PIC S9(12)V99.
       01 WS-MIN-BALANCE       PIC 9(9)V99 VALUE 100.00.
       01 WS-OVERDRAFT-LIMIT   PIC 9(9)V99 VALUE 500.00.
       01 WS-OVERDRAFT-FEE     PIC 9(5)V99 VALUE 35.00.
       01 WS-MONTHLY-FEE       PIC 9(5)V99 VALUE 12.00.
       01 WS-TXN-AMOUNT        PIC S9(12)V99.
       01 WS-NEW-BALANCE       PIC S9(12)V99.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-PROCESS-TXN
           PERFORM 2000-CHECK-OVERDRAFT
           PERFORM 3000-ASSESS-FEES
           STOP RUN.
       1000-PROCESS-TXN.
           COMPUTE WS-NEW-BALANCE = WS-BALANCE + WS-TXN-AMOUNT.
       2000-CHECK-OVERDRAFT.
           IF WS-NEW-BALANCE < 0
               IF WS-ACCT-TYPE = "CHK"
                  AND (0 - WS-NEW-BALANCE) <= WS-OVERDRAFT-LIMIT
                   ADD WS-OVERDRAFT-FEE TO WS-NEW-BALANCE
                   DISPLAY "OVERDRAFT FEE APPLIED"
               ELSE
                   DISPLAY "TRANSACTION DECLINED: INSUFFICIENT FUNDS"
                   MOVE WS-BALANCE TO WS-NEW-BALANCE
               END-IF
           END-IF.
       3000-ASSESS-FEES.
           IF WS-NEW-BALANCE < WS-MIN-BALANCE
               SUBTRACT WS-MONTHLY-FEE FROM WS-NEW-BALANCE
               DISPLAY "BELOW MINIMUM BALANCE FEE: " WS-MONTHLY-FEE
           END-IF.
    `,
    expectedRules: [
      { id: "COMPUTE-WS-NEW-BALANCE", type: "COMPUTE", description: "Apply transaction to balance" },
      { id: "IF-WS-NEW-BALANCE-LT-0", type: "IF", description: "Overdraft check" },
      { id: "IF-CHK-OVERDRAFT-LIMIT", type: "IF", description: "Checking overdraft within limit" },
      { id: "ADD-OVERDRAFT-FEE", type: "ADD", description: "Apply overdraft fee" },
      { id: "IF-BELOW-MIN-BALANCE", type: "IF", description: "Minimum balance fee assessment" },
      { id: "SUBTRACT-MONTHLY-FEE", type: "SUBTRACT", description: "Deduct monthly maintenance fee" },
    ],
  },
  {
    programId: "SWIFT-XFER",
    domain: "Settlement",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SWIFT-XFER.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-SENDER-BIC       PIC X(11).
       01 WS-RECEIVER-BIC     PIC X(11).
       01 WS-AMOUNT            PIC 9(12)V99.
       01 WS-CURRENCY          PIC X(3).
       01 WS-FX-RATE           PIC 9(5)V9999.
       01 WS-CONVERTED-AMT     PIC 9(12)V99.
       01 WS-WIRE-FEE          PIC 9(5)V99 VALUE 25.00.
       01 WS-TOTAL-DEBIT       PIC 9(12)V99.
       01 WS-TOTAL-CREDIT      PIC 9(12)V99.
       01 WS-NOSTRO-BALANCE    PIC S9(12)V99.
       01 WS-XFER-STATUS       PIC X(10).
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-FX-CONVERT
           PERFORM 2000-DEBIT-SENDER
           PERFORM 3000-CREDIT-RECEIVER
           PERFORM 4000-VERIFY-CONSERVATION
           STOP RUN.
       1000-FX-CONVERT.
           IF WS-CURRENCY NOT = "USD"
               COMPUTE WS-CONVERTED-AMT =
                   WS-AMOUNT * WS-FX-RATE ROUNDED
               DISPLAY "FX CONVERSION: " WS-AMOUNT " "
                       WS-CURRENCY " -> " WS-CONVERTED-AMT " USD"
           ELSE
               MOVE WS-AMOUNT TO WS-CONVERTED-AMT
           END-IF.
       2000-DEBIT-SENDER.
           COMPUTE WS-TOTAL-DEBIT =
               WS-CONVERTED-AMT + WS-WIRE-FEE
           IF WS-TOTAL-DEBIT > WS-NOSTRO-BALANCE
               MOVE "REJECTED" TO WS-XFER-STATUS
               DISPLAY "INSUFFICIENT NOSTRO BALANCE"
           ELSE
               SUBTRACT WS-TOTAL-DEBIT FROM WS-NOSTRO-BALANCE
           END-IF.
       3000-CREDIT-RECEIVER.
           MOVE WS-CONVERTED-AMT TO WS-TOTAL-CREDIT.
       4000-VERIFY-CONSERVATION.
           IF WS-TOTAL-DEBIT NOT = (WS-TOTAL-CREDIT + WS-WIRE-FEE)
               MOVE "FAILED" TO WS-XFER-STATUS
               DISPLAY "MONEY CONSERVATION VIOLATED"
           ELSE
               MOVE "COMPLETE" TO WS-XFER-STATUS
           END-IF.
    `,
    expectedRules: [
      { id: "IF-CURRENCY-NOT-USD", type: "IF", description: "FX conversion trigger" },
      { id: "COMPUTE-WS-CONVERTED-AMT", type: "COMPUTE", description: "FX conversion with rounding" },
      { id: "COMPUTE-WS-TOTAL-DEBIT", type: "COMPUTE", description: "Total debit including wire fee" },
      { id: "IF-INSUFFICIENT-NOSTRO", type: "IF", description: "Nostro balance check" },
      { id: "SUBTRACT-DEBIT-FROM-NOSTRO", type: "SUBTRACT", description: "Debit nostro account" },
      { id: "IF-CONSERVATION-VIOLATED", type: "IF", description: "Money conservation invariant" },
    ],
    // Correct cross-currency wire: 1000 EUR @ 1.10 = 1100 USD, +25 wire fee.
    // Source debited 1125, receiver credited 1100. Exercises conservation,
    // currency consistency, debit/credit direction, and banker's rounding.
    safetyVectors: [
      {
        sourceAccount: "NOSTRO-USD",
        targetAccount: "RECEIVER-BIC",
        amount: 1000.0,
        currency: "EUR",
        targetCurrency: "USD",
        exchangeRate: 1.1,
        targetAmount: 1100.0,
        fees: 25.0,
        sourceBalanceBefore: 5000.0,
        sourceBalanceAfter: 3875.0,
        targetBalanceBefore: 0.0,
        targetBalanceAfter: 1100.0,
        roundingMode: "HALF_EVEN",
      },
    ],
  },
  {
    programId: "INT-ACCRUE",
    domain: "Treasury",
    source: `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. INT-ACCRUE.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-PRINCIPAL         PIC 9(12)V99.
       01 WS-ANNUAL-RATE       PIC 9(3)V9999.
       01 WS-DAILY-RATE        PIC 9(3)V999999.
       01 WS-DAYS-IN-YEAR      PIC 9(3) VALUE 360.
       01 WS-ACCRUED-INT       PIC 9(9)V99.
       01 WS-ACCRUAL-DAYS      PIC 9(3).
       01 WS-PREV-ACCRUAL      PIC 9(9)V99.
       01 WS-DELTA              PIC S9(9)V99.
       PROCEDURE DIVISION.
       0000-MAIN.
           PERFORM 1000-CALC-DAILY-RATE
           PERFORM 2000-ACCRUE
           PERFORM 3000-VERIFY-MONOTONIC
           STOP RUN.
       1000-CALC-DAILY-RATE.
           COMPUTE WS-DAILY-RATE =
               WS-ANNUAL-RATE / WS-DAYS-IN-YEAR.
       2000-ACCRUE.
           COMPUTE WS-ACCRUED-INT =
               WS-PRINCIPAL * WS-DAILY-RATE * WS-ACCRUAL-DAYS.
       3000-VERIFY-MONOTONIC.
           COMPUTE WS-DELTA = WS-ACCRUED-INT - WS-PREV-ACCRUAL
           IF WS-DELTA < 0
               DISPLAY "ERROR: ACCRUED INTEREST DECREASED"
               DISPLAY "PREV: " WS-PREV-ACCRUAL
                       " CURR: " WS-ACCRUED-INT
           END-IF.
    `,
    expectedRules: [
      { id: "COMPUTE-WS-DAILY-RATE", type: "COMPUTE", description: "Daily rate from annual (ACT/360)" },
      { id: "COMPUTE-WS-ACCRUED-INT", type: "COMPUTE", description: "Accrued interest calculation" },
      { id: "COMPUTE-WS-DELTA", type: "COMPUTE", description: "Interest delta for monotonic check" },
      { id: "IF-WS-DELTA-LT-0", type: "IF", description: "Monotonic accrual invariant" },
    ],
  },
];

// ── QA Pairs: 25 Questions ─────────────────────────────────

export const COBOL_BANKING_QA: QAPair[] = [
  // ── LOAN-PROC (5 questions) ──────────────────────
  {
    id: "loan-q1",
    question: "What is the maximum allowed debt-to-income ratio in LOAN-PROC?",
    expectedAnswer: "43.00 percent, stored in WS-MAX-DTI",
    program: "LOAN-PROC",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-DTI", "IF-WS-DTI-GT-WS-MAX-DTI"],
  },
  {
    id: "loan-q2",
    question: "What happens when a borrower has a risk score below 620?",
    expectedAnswer: "The loan is rejected. APPROVAL-STATUS is set to REJECTED.",
    program: "LOAN-PROC",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-WS-RISK-SCORE-LT-620"],
  },
  {
    id: "loan-q3",
    question: "How does LOAN-PROC adjust rates for subprime borrowers?",
    expectedAnswer: "Adds 50 basis points to WS-RATE for risk scores between 620-720",
    program: "LOAN-PROC",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-WS-RISK-SCORE-LT-720", "ADD-50-TO-WS-RATE"],
  },
  {
    id: "loan-q4",
    question: "What formula is used to calculate monthly payments?",
    expectedAnswer: "Standard amortization: P * r / (1 - (1+r)^-n) where r is monthly rate",
    program: "LOAN-PROC",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-MONTHLY-PAYMENT"],
  },
  {
    id: "loan-q5",
    question: "Explain the relationship between DTI calculation and loan approval",
    expectedAnswer: "DTI is computed from monthly debt and annual income. If DTI exceeds 43%, loan is rejected.",
    program: "LOAN-PROC",
    expectedStrategy: "RAPTOR",
    relevantNodeIds: ["COMPUTE-WS-DTI", "IF-WS-DTI-GT-WS-MAX-DTI"],
  },

  // ── PAY-SETTLE (5 questions) ─────────────────────
  {
    id: "settle-q1",
    question: "How does PAY-SETTLE detect a batch imbalance?",
    expectedAnswer: "Computes net position (credits - debits). If absolute value exceeds tolerance (0.01), marks as IMBALANCE.",
    program: "PAY-SETTLE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-NET-POSITION", "IF-WS-NET-POSITION-IMBALANCE"],
  },
  {
    id: "settle-q2",
    question: "What is the settlement tolerance in PAY-SETTLE?",
    expectedAnswer: "0.01 (one cent), stored in WS-TOLERANCE",
    program: "PAY-SETTLE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-WS-NET-POSITION-IMBALANCE"],
  },
  {
    id: "settle-q3",
    question: "What happens when settlement fails?",
    expectedAnswer: "A reversal amount equal to the net position is computed and displayed for manual processing.",
    program: "PAY-SETTLE",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["COMPUTE-WS-REVERSAL-AMT"],
  },
  {
    id: "settle-q4",
    question: "Can PAY-SETTLE process an empty batch?",
    expectedAnswer: "Yes but it marks status as EMPTY and displays a warning. No settlement is attempted.",
    program: "PAY-SETTLE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-EMPTY-BATCH"],
  },
  {
    id: "settle-q5",
    question: "What is the impact of changing WS-TOLERANCE on settlement?",
    expectedAnswer: "Increasing tolerance allows larger imbalances to pass. Decreasing it makes settlement stricter.",
    program: "PAY-SETTLE",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["IF-WS-NET-POSITION-IMBALANCE", "COMPUTE-WS-NET-POSITION"],
  },

  // ── ACCT-MAINT (5 questions) ─────────────────────
  {
    id: "acct-q1",
    question: "How much is the overdraft fee in ACCT-MAINT?",
    expectedAnswer: "$35.00 stored in WS-OVERDRAFT-FEE",
    program: "ACCT-MAINT",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["ADD-OVERDRAFT-FEE"],
  },
  {
    id: "acct-q2",
    question: "Under what conditions is an overdraft allowed?",
    expectedAnswer: "Only for checking accounts (CHK) when the overdraft amount is within the $500 limit.",
    program: "ACCT-MAINT",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-WS-NEW-BALANCE-LT-0", "IF-CHK-OVERDRAFT-LIMIT"],
  },
  {
    id: "acct-q3",
    question: "What happens when a savings account goes negative?",
    expectedAnswer: "Transaction is declined. The balance is restored to its original value.",
    program: "ACCT-MAINT",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["IF-WS-NEW-BALANCE-LT-0", "IF-CHK-OVERDRAFT-LIMIT"],
  },
  {
    id: "acct-q4",
    question: "What is the minimum balance requirement?",
    expectedAnswer: "$100.00. Falling below triggers a $12.00 monthly maintenance fee.",
    program: "ACCT-MAINT",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-BELOW-MIN-BALANCE", "SUBTRACT-MONTHLY-FEE"],
  },
  {
    id: "acct-q5",
    question: "Trace the fee cascade: what happens to a $50 checking account after a $60 debit?",
    expectedAnswer: "Balance goes to -$10. Overdraft fee of $35 makes it -$45. Then minimum balance fee of $12 makes it -$57.",
    program: "ACCT-MAINT",
    expectedStrategy: "RAPTOR",
    relevantNodeIds: ["COMPUTE-WS-NEW-BALANCE", "ADD-OVERDRAFT-FEE", "SUBTRACT-MONTHLY-FEE"],
  },

  // ── SWIFT-XFER (5 questions) ─────────────────────
  {
    id: "swift-q1",
    question: "How does SWIFT-XFER handle currency conversion?",
    expectedAnswer: "Multiplies amount by FX rate with ROUNDED mode. USD amounts bypass conversion.",
    program: "SWIFT-XFER",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-CURRENCY-NOT-USD", "COMPUTE-WS-CONVERTED-AMT"],
  },
  {
    id: "swift-q2",
    question: "What is the wire transfer fee?",
    expectedAnswer: "$25.00 stored in WS-WIRE-FEE",
    program: "SWIFT-XFER",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-TOTAL-DEBIT"],
  },
  {
    id: "swift-q3",
    question: "How does SWIFT-XFER verify money conservation?",
    expectedAnswer: "Checks that total debit equals total credit plus wire fee. If not, marks transfer as FAILED.",
    program: "SWIFT-XFER",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["IF-CONSERVATION-VIOLATED"],
  },
  {
    id: "swift-q4",
    question: "What happens when nostro balance is insufficient?",
    expectedAnswer: "Transfer is rejected. No debit is processed. Status set to REJECTED.",
    program: "SWIFT-XFER",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["IF-INSUFFICIENT-NOSTRO"],
  },
  {
    id: "swift-q5",
    question: "If the FX rate changes between 1000-FX-CONVERT and 4000-VERIFY-CONSERVATION, could money conservation fail?",
    expectedAnswer: "No, because the converted amount is stored in WS-CONVERTED-AMT and reused. The rate is captured at conversion time.",
    program: "SWIFT-XFER",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["COMPUTE-WS-CONVERTED-AMT", "IF-CONSERVATION-VIOLATED"],
  },

  // ── INT-ACCRUE (5 questions) ─────────────────────
  {
    id: "accrue-q1",
    question: "What day count convention does INT-ACCRUE use?",
    expectedAnswer: "ACT/360 — actual days accrued divided by 360-day year",
    program: "INT-ACCRUE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-DAILY-RATE"],
  },
  {
    id: "accrue-q2",
    question: "How does INT-ACCRUE detect interest calculation errors?",
    expectedAnswer: "Compares current accrued interest with previous. If delta is negative (interest decreased), logs error.",
    program: "INT-ACCRUE",
    expectedStrategy: "GRAPH",
    relevantNodeIds: ["COMPUTE-WS-DELTA", "IF-WS-DELTA-LT-0"],
  },
  {
    id: "accrue-q3",
    question: "What is the accrued interest formula?",
    expectedAnswer: "Principal × daily rate × accrual days. Daily rate = annual rate / 360.",
    program: "INT-ACCRUE",
    expectedStrategy: "VECTOR",
    relevantNodeIds: ["COMPUTE-WS-ACCRUED-INT", "COMPUTE-WS-DAILY-RATE"],
  },
  {
    id: "accrue-q4",
    question: "Why does INT-ACCRUE check for monotonic accrual?",
    expectedAnswer: "Interest should only increase over time. A decrease indicates a calculation bug or data corruption.",
    program: "INT-ACCRUE",
    expectedStrategy: "FLARE",
    relevantNodeIds: ["IF-WS-DELTA-LT-0"],
  },
  {
    id: "accrue-q5",
    question: "What programs handle money-related computations?",
    expectedAnswer: "LOAN-PROC, PAY-SETTLE, ACCT-MAINT, SWIFT-XFER, and INT-ACCRUE all contain COMPUTE statements for financial calculations.",
    expectedStrategy: "RAPTOR",
    relevantNodeIds: [],
  },
];
