/**
 * Verification Errors — typed exceptions for banking semantic verification.
 * These represent safety-critical failures that MUST block a migration.
 */

export class VerificationError extends Error {
  readonly code: string;
  readonly severity: "CRITICAL" | "WARNING";

  constructor(message: string, code: string, severity: "CRITICAL" | "WARNING" = "CRITICAL") {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    this.severity = severity;
  }
}

/** Conservation of money violated — total debits ≠ total credits + fees */
export class MoneyConservationError extends VerificationError {
  readonly expected: number;
  readonly actual: number;
  readonly difference: number;

  constructor(expected: number, actual: number) {
    const diff = Math.abs(expected - actual);
    super(
      `CONSERVATION OF MONEY VIOLATED: expected ${expected.toFixed(4)}, got ${actual.toFixed(4)} (diff: ${diff.toFixed(4)})`,
      "MONEY_CONSERVATION",
      "CRITICAL"
    );
    this.name = "MoneyConservationError";
    this.expected = expected;
    this.actual = actual;
    this.difference = diff;
  }
}

/** Debit/credit direction reversed — source balance increased or target decreased */
export class SignFlipError extends VerificationError {
  readonly field: string;
  readonly cobolDirection: "SUBTRACT" | "ADD";
  readonly migratedDirection: "SUBTRACT" | "ADD";

  constructor(field: string, cobolDirection: "SUBTRACT" | "ADD", migratedDirection: "SUBTRACT" | "ADD") {
    super(
      `SIGN FLIP in "${field}": COBOL ${cobolDirection}s, migrated ${migratedDirection}s. Debits and credits may be reversed.`,
      "SIGN_FLIP",
      "CRITICAL"
    );
    this.name = "SignFlipError";
    this.field = field;
    this.cobolDirection = cobolDirection;
    this.migratedDirection = migratedDirection;
  }
}

/** Business rule dropped during migration */
export class RuleDroppedError extends VerificationError {
  readonly ruleId: string;
  readonly domain: string;

  constructor(ruleId: string, domain: string) {
    super(
      `Business rule "${ruleId}" (domain: ${domain}) exists in COBOL but NOT in migrated code`,
      "RULE_DROPPED",
      "CRITICAL"
    );
    this.name = "RuleDroppedError";
    this.ruleId = ruleId;
    this.domain = domain;
  }
}

/** Rounding mode changed — COBOL ROUNDED (HALF_EVEN) ≠ migrated rounding */
export class RoundingModeError extends VerificationError {
  readonly cobolMode: string;
  readonly migratedMode: string;

  constructor(cobolMode: string, migratedMode: string) {
    super(
      `Rounding mode changed: COBOL="${cobolMode}" → migrated="${migratedMode}". At scale, this causes cent-level discrepancies.`,
      "ROUNDING_MODE",
      "CRITICAL"
    );
    this.name = "RoundingModeError";
    this.cobolMode = cobolMode;
    this.migratedMode = migratedMode;
  }
}

/** Batch settlement imbalance */
export class BatchImbalanceError extends VerificationError {
  readonly totalDebits: number;
  readonly totalCredits: number;

  constructor(totalDebits: number, totalCredits: number) {
    super(
      `Batch imbalance: debits=${totalDebits.toFixed(4)} ≠ credits=${totalCredits.toFixed(4)}. Settlement will fail.`,
      "BATCH_IMBALANCE",
      "CRITICAL"
    );
    this.name = "BatchImbalanceError";
    this.totalDebits = totalDebits;
    this.totalCredits = totalCredits;
  }
}
