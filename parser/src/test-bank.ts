// ============================================================
// Test: Real-world Bank Management System COBOL
// ============================================================

import { COBOLParser } from './cobol-parser.js';
import { EdgeExtractor } from './edge-extractor.js';
import { SemanticElevator, type SemanticNode } from './semantic-elevator.js';

const BANK_COBOL = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BANKSYSTEM.

       ENVIRONMENT DIVISION.

       DATA DIVISION.

       WORKING-STORAGE SECTION.

       77 WS-OPTION           PIC 9 VALUE 0.
       77 WS-EXIT             PIC X VALUE 'N'.

       77 WS-TRANSFER-AMOUNT  PIC 9(7)V99 VALUE 0.

       01 WS-CUSTOMER.
          05 WS-ACCOUNT-NO      PIC 9(10) VALUE 1000000001.
          05 WS-NAME            PIC X(30) VALUE
             "JOHN DOE".
          05 WS-BALANCE         PIC 9(9)V99 VALUE 50000.00.
          05 WS-STATUS          PIC X VALUE 'A'.

       01 WS-TARGET.
          05 TARGET-ACCOUNT     PIC 9(10) VALUE 1000000002.
          05 TARGET-NAME        PIC X(30)
             VALUE "ALICE SMITH".
          05 TARGET-BALANCE     PIC 9(9)V99 VALUE 25000.00.

       01 WS-TRANSACTION.
          05 WS-AMOUNT          PIC 9(7)V99.
          05 WS-TYPE            PIC X(15).

       01 WS-INTEREST.
          05 WS-RATE            PIC 99V99 VALUE 5.50.
          05 WS-INTEREST-AMT    PIC 9(7)V99.

       01 WS-ERROR.
          05 ERROR-CODE         PIC 999 VALUE 0.
          05 ERROR-MESSAGE      PIC X(50).

       PROCEDURE DIVISION.

       MAIN-PROGRAM.

           PERFORM UNTIL WS-EXIT = 'Y'

               DISPLAY SPACE
               DISPLAY "======================================"
               DISPLAY "        BANK MANAGEMENT SYSTEM        "
               DISPLAY "======================================"
               DISPLAY "1. CUSTOMER DETAILS"
               DISPLAY "2. DEPOSIT"
               DISPLAY "3. WITHDRAW"
               DISPLAY "4. TRANSFER"
               DISPLAY "5. CALCULATE INTEREST"
               DISPLAY "6. DAILY REPORT"
               DISPLAY "7. EXIT"
               DISPLAY "======================================"
               DISPLAY "ENTER OPTION : "

               ACCEPT WS-OPTION

               EVALUATE WS-OPTION

                   WHEN 1
                       PERFORM SHOW-CUSTOMER

                   WHEN 2
                       PERFORM DEPOSIT-MONEY

                   WHEN 3
                       PERFORM WITHDRAW-MONEY

                   WHEN 4
                       PERFORM TRANSFER-MONEY

                   WHEN 5
                       PERFORM CALCULATE-INTEREST

                   WHEN 6
                       PERFORM DAILY-REPORT

                   WHEN 7
                       MOVE 'Y' TO WS-EXIT

                   WHEN OTHER
                       DISPLAY "INVALID OPTION"

               END-EVALUATE

           END-PERFORM

           STOP RUN.

       SHOW-CUSTOMER.

           DISPLAY SPACE
           DISPLAY "ACCOUNT NUMBER : " WS-ACCOUNT-NO
           DISPLAY "CUSTOMER NAME  : " WS-NAME
           DISPLAY "BALANCE        : " WS-BALANCE
           DISPLAY "STATUS         : " WS-STATUS.

       DEPOSIT-MONEY.

           DISPLAY SPACE
           DISPLAY "ENTER AMOUNT TO DEPOSIT : "
           ACCEPT WS-AMOUNT

           IF WS-AMOUNT > 0

               ADD WS-AMOUNT TO WS-BALANCE

               MOVE "DEPOSIT" TO WS-TYPE

               PERFORM LOG-TRANSACTION

               DISPLAY "DEPOSIT SUCCESSFUL"

               DISPLAY "NEW BALANCE : " WS-BALANCE

           ELSE

               MOVE 101 TO ERROR-CODE
               MOVE "INVALID DEPOSIT AMOUNT"
                   TO ERROR-MESSAGE

               PERFORM DISPLAY-ERROR

           END-IF.

       WITHDRAW-MONEY.

           DISPLAY SPACE
           DISPLAY "ENTER AMOUNT TO WITHDRAW : "
           ACCEPT WS-AMOUNT

           IF WS-AMOUNT <= WS-BALANCE

               SUBTRACT WS-AMOUNT
               FROM WS-BALANCE

               MOVE "WITHDRAWAL"
               TO WS-TYPE

               PERFORM LOG-TRANSACTION

               DISPLAY "WITHDRAWAL SUCCESSFUL"

               DISPLAY "BALANCE : "
               WS-BALANCE

           ELSE

               MOVE 102 TO ERROR-CODE

               MOVE "INSUFFICIENT FUNDS"

               TO ERROR-MESSAGE

               PERFORM DISPLAY-ERROR

           END-IF.

       TRANSFER-MONEY.

           DISPLAY SPACE

           DISPLAY "TRANSFER TO ACCOUNT : "
           TARGET-ACCOUNT

           DISPLAY "ENTER AMOUNT : "

           ACCEPT WS-TRANSFER-AMOUNT

           IF WS-TRANSFER-AMOUNT <= WS-BALANCE

               SUBTRACT WS-TRANSFER-AMOUNT
               FROM WS-BALANCE

               ADD WS-TRANSFER-AMOUNT
               TO TARGET-BALANCE

               MOVE WS-TRANSFER-AMOUNT
               TO WS-AMOUNT

               MOVE "TRANSFER"
               TO WS-TYPE

               PERFORM LOG-TRANSACTION

               DISPLAY "TRANSFER SUCCESSFUL"

               DISPLAY "YOUR BALANCE : "
               WS-BALANCE

           ELSE

               MOVE 103
               TO ERROR-CODE

               MOVE "TRANSFER FAILED"

               TO ERROR-MESSAGE

               PERFORM DISPLAY-ERROR

           END-IF.

       CALCULATE-INTEREST.

           COMPUTE WS-INTEREST-AMT =
               (WS-BALANCE * WS-RATE) / 100

           DISPLAY SPACE

           DISPLAY "CURRENT BALANCE : "
           WS-BALANCE

           DISPLAY "INTEREST : "
           WS-INTEREST-AMT

           ADD WS-INTEREST-AMT
           TO WS-BALANCE

           DISPLAY "UPDATED BALANCE : "
           WS-BALANCE.

       LOG-TRANSACTION.

           DISPLAY SPACE

           DISPLAY "------------------------------"

           DISPLAY "TRANSACTION LOG"

           DISPLAY "ACCOUNT : "
           WS-ACCOUNT-NO

           DISPLAY "TYPE    : "
           WS-TYPE

           DISPLAY "AMOUNT  : "
           WS-AMOUNT

           DISPLAY "BALANCE : "
           WS-BALANCE

           DISPLAY "------------------------------".

       DISPLAY-ERROR.

           DISPLAY SPACE

           DISPLAY "******** ERROR ********"

           DISPLAY "CODE : "
           ERROR-CODE

           DISPLAY "MESSAGE : "
           ERROR-MESSAGE

           DISPLAY "***********************".

       DAILY-REPORT.

           DISPLAY SPACE

           DISPLAY "================================"

           DISPLAY "END OF DAY REPORT"

           DISPLAY "================================"

           DISPLAY "ACCOUNT      : "
           WS-ACCOUNT-NO

           DISPLAY "CUSTOMER     : "
           WS-NAME

           DISPLAY "BALANCE      : "
           WS-BALANCE

           DISPLAY "TARGET ACCT  : "
           TARGET-ACCOUNT

           DISPLAY "TARGET BAL   : "
           TARGET-BALANCE

           DISPLAY "INTEREST RATE: "
           WS-RATE

           DISPLAY "STATUS       : "
           WS-STATUS

           DISPLAY "================================".
`;

// ============================================================
// RUN THE PIPELINE
// ============================================================

console.log('═══════════════════════════════════════════════════════');
console.log(' BANK MANAGEMENT SYSTEM — Full Analysis');
console.log(' Zero LLM. EU Sovereign. Deterministic.');
console.log('═══════════════════════════════════════════════════════\n');

// Phase 1: Parse
console.log('▸ PHASE 1: Syntactic Parsing...');
const parser = new COBOLParser();
const ast = parser.parse(BANK_COBOL);
console.log(`  ✓ Program: ${ast.name}`);

const procDiv = ast.children.find(c => c.name === 'PROCEDURE');
const dataDivs = ast.children.filter(c =>
  c.name === 'DATA' || c.name === 'WORKING-STORAGE' ||
  c.type === 'COBOL_DIVISION_NODE'
);

// Count paragraphs
const allParagraphs: string[] = [];
function findParagraphs(node: import('./types.js').ASTNode) {
  if (node.type === 'COBOL_PARAGRAPH_NODE') allParagraphs.push(node.name);
  for (const c of node.children) findParagraphs(c);
}
findParagraphs(ast);
console.log(`  ✓ Paragraphs found: ${allParagraphs.length}`);
console.log(`    ${allParagraphs.join(', ')}`);

// Phase 2: Knowledge Graph
console.log('\n▸ PHASE 2: Knowledge Graph...');
const extractor = new EdgeExtractor();
extractor.extractFromCOBOL(ast, 'BANKSYSTEM.CBL');
const graph = extractor.getGraph();
console.log(`  ✓ ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
for (const edge of graph.edges) {
  console.log(`    ${edge.source.padEnd(18)} ──${edge.type.padEnd(10)}──▸ ${edge.target}`);
}

// Phase 3: Abstract Semantic Tree
console.log('\n▸ PHASE 3: Abstract Semantic Tree...');
const elevator = new SemanticElevator();
const semantic = elevator.elevate(ast);

console.log('\n  ┌─ BUSINESS SYSTEM ──────────────────────────────');
printSemantic(semantic, '  │ ');

// Phase 4: Business Impact Analysis
console.log('\n═══════════════════════════════════════════════════════');
console.log(' BUSINESS IMPACT ANALYSIS');
console.log('═══════════════════════════════════════════════════════\n');

const rules = collectByType(semantic, 'BUSINESS_RULE');
const dataOps = collectByType(semantic, 'DATA_TRANSFORM');
const controlFlow = collectByType(semantic, 'CONTROL_FLOW');
const dataDefs = collectByType(semantic, 'DATA_DEFINITION');

console.log('  ┌─ Data Definitions ─────────────────────────────');
for (const d of dataDefs) {
  console.log(`  │ • [${d.domain.padEnd(20)}] ${d.description}`);
}

console.log('\n  ┌─ Business Rules ───────────────────────────────');
for (const r of rules) {
  const hasChildren = r.children.length > 0;
  console.log(`  │ • [${r.domain.padEnd(20)}] ${r.description}`);
  if (r.inputs.length) console.log(`  │   ↳ Reads: ${r.inputs.join(', ')}`);
  if (r.outputs.length) console.log(`  │   ↳ Writes: ${r.outputs.join(', ')}`);
  if (r.sideEffects.length) console.log(`  │   ↳ Side Effects: ${r.sideEffects.join(', ')}`);
}

console.log('\n  ┌─ Control Flow ──────────────────────────────────');
for (const c of controlFlow) {
  console.log(`  │ • ${c.description}`);
}

console.log('\n  ┌─ Data Transformations ──────────────────────────');
for (const d of dataOps) {
  console.log(`  │ • ${d.description}`);
  if (d.inputs.length) console.log(`  │   ↳ From: ${d.inputs.join(', ')}`);
  if (d.outputs.length) console.log(`  │   ↳ To: ${d.outputs.join(', ')}`);
}

// Summary
console.log('\n═══════════════════════════════════════════════════════');
console.log(' SUMMARY');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Program:              ${ast.name}`);
console.log(`  Paragraphs:           ${allParagraphs.length}`);
console.log(`  Data definitions:     ${dataDefs.length}`);
console.log(`  Business rules:       ${rules.length}`);
console.log(`  Control flow nodes:   ${controlFlow.length}`);
console.log(`  Data transformations: ${dataOps.length}`);
console.log(`  Graph nodes:          ${graph.nodes.length}`);
console.log(`  Graph edges:          ${graph.edges.length}`);
console.log(`  LLM calls:           0`);
console.log(`  Code sent externally: 0 bytes`);
console.log('═══════════════════════════════════════════════════════\n');


// ---- Helpers ----

function printSemantic(node: SemanticNode, indent: string): void {
  const domain = node.domain !== 'General' ? ` [${node.domain}]` : '';
  console.log(`${indent}├── ${node.description}${domain}`);
  if (node.inputs.length > 0)
    console.log(`${indent}│   ↳ Inputs: ${node.inputs.join(', ')}`);
  if (node.outputs.length > 0)
    console.log(`${indent}│   ↳ Outputs: ${node.outputs.join(', ')}`);
  if (node.sideEffects.length > 0)
    console.log(`${indent}│   ↳ Side Effects: ${node.sideEffects.join(', ')}`);
  for (const child of node.children) {
    printSemantic(child, indent + '│   ');
  }
}

function collectByType(node: SemanticNode, type: string): SemanticNode[] {
  const result: SemanticNode[] = [];
  if (node.type === type) result.push(node);
  for (const child of node.children) {
    result.push(...collectByType(child, type));
  }
  return result;
}
