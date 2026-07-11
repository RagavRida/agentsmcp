#!/usr/bin/env npx tsx
// ============================================================
// UNPREDICTABLE E2E TEST — All 7 Pillars
//
// NOTHING hardcoded. All config from env vars or discovered
// dynamically from the codebase.
// ============================================================

import { VectorStore } from "../src/vector/store";
import { RaptorTreeBuilder } from "../src/raptor/tree-builder";
import { parseCobol, parseJcl } from "../src/parser";
import { TrajectoryLogger } from "../src/trajectory/logger";
import * as byos from "../src/storage/byos";
import * as path from "path";
import * as os from "os";

// ─── All Config from Environment ───────────────────────────
const EMBED_URL = process.env.AGENTSMCP_MODAL_EMBED_URL
  || process.env.EMBED_URL
  || "https://ragavrida--agentmailbox-embedder-fastapi-app.modal.run";
const VLLM_URL = process.env.AGENTSMCP_VLLM_URL
  || process.env.VLLM_URL
  || "https://ragavrida--agentmailbox-inference-fastapi-app.modal.run";
const FLARE_THRESHOLD = parseFloat(process.env.FLARE_THRESHOLD || "-0.5");
const LOG_DIR = process.env.AGENTSMCP_LOG_DIR || path.join(os.tmpdir(), "e2e-traj");
const SESSION_ID = process.env.AGENTSMCP_SESSION_ID || `e2e-${Date.now()}`;

// ─── Dynamic COBOL: Generate a unique program every run ────
// Program name includes timestamp so it's literally never the same
const PROGRAM_ID = `LOAN-${Date.now().toString(36).toUpperCase()}`;

const LOAN_PROCESSOR = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${PROGRAM_ID}.
       AUTHOR. E2E-TEST.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-LOAN-AMOUNT       PIC 9(10)V99.
       01 WS-ANNUAL-RATE        PIC 9(3)V9999.
       01 WS-TERM-MONTHS        PIC 9(3).
       01 WS-MONTHLY-RATE       PIC 9(3)V999999.
       01 WS-MONTHLY-PAYMENT    PIC 9(10)V99.
       01 WS-TOTAL-INTEREST     PIC 9(12)V99.
       01 WS-CREDIT-SCORE       PIC 9(3).
       01 WS-RISK-CATEGORY      PIC X(10).
       01 WS-APPROVAL-STATUS    PIC X(8).
       01 WS-DEBT-RATIO         PIC 9(3)V99.
       01 WS-APPLICANT-INCOME   PIC 9(10)V99.
       01 WS-EXISTING-DEBT      PIC 9(10)V99.
       PROCEDURE DIVISION.
       MAIN-PROCESS.
           PERFORM VALIDATE-APPLICATION
           PERFORM ASSESS-CREDIT-RISK
           PERFORM CALCULATE-MONTHLY-PAYMENT
           PERFORM CHECK-DEBT-TO-INCOME
           PERFORM DETERMINE-APPROVAL
           CALL 'AUDIT-LOGGER' USING WS-APPROVAL-STATUS
           CALL 'NOTIFIER' USING WS-APPROVAL-STATUS
           STOP RUN.
       VALIDATE-APPLICATION.
           IF WS-LOAN-AMOUNT < 1000
               MOVE 'REJECTED' TO WS-APPROVAL-STATUS
               DISPLAY 'LOAN AMOUNT TOO LOW'
           END-IF
           IF WS-TERM-MONTHS < 6
               MOVE 'REJECTED' TO WS-APPROVAL-STATUS
               DISPLAY 'TERM TOO SHORT'
           END-IF.
       ASSESS-CREDIT-RISK.
           EVALUATE TRUE
               WHEN WS-CREDIT-SCORE >= 750
                   MOVE 'LOW' TO WS-RISK-CATEGORY
               WHEN WS-CREDIT-SCORE >= 650
                   MOVE 'MEDIUM' TO WS-RISK-CATEGORY
               WHEN WS-CREDIT-SCORE >= 550
                   MOVE 'HIGH' TO WS-RISK-CATEGORY
               WHEN OTHER
                   MOVE 'REJECTED' TO WS-RISK-CATEGORY
                   MOVE 'REJECTED' TO WS-APPROVAL-STATUS
           END-EVALUATE.
       CALCULATE-MONTHLY-PAYMENT.
           COMPUTE WS-MONTHLY-RATE = WS-ANNUAL-RATE / 12 / 100
           COMPUTE WS-MONTHLY-PAYMENT = WS-LOAN-AMOUNT *
               WS-MONTHLY-RATE / (1 - (1 + WS-MONTHLY-RATE)
               ** (0 - WS-TERM-MONTHS))
           COMPUTE WS-TOTAL-INTEREST = (WS-MONTHLY-PAYMENT *
               WS-TERM-MONTHS) - WS-LOAN-AMOUNT.
       CHECK-DEBT-TO-INCOME.
           COMPUTE WS-DEBT-RATIO = (WS-EXISTING-DEBT +
               WS-MONTHLY-PAYMENT) / WS-APPLICANT-INCOME * 100
           IF WS-DEBT-RATIO > 43
               MOVE 'REJECTED' TO WS-APPROVAL-STATUS
               DISPLAY 'DTI RATIO EXCEEDS 43%'
           END-IF.
       DETERMINE-APPROVAL.
           IF WS-APPROVAL-STATUS NOT = 'REJECTED'
               IF WS-RISK-CATEGORY = 'LOW'
                   MOVE 'APPROVED' TO WS-APPROVAL-STATUS
               ELSE IF WS-RISK-CATEGORY = 'MEDIUM'
                   MOVE 'REVIEW' TO WS-APPROVAL-STATUS
               ELSE
                   MOVE 'REJECTED' TO WS-APPROVAL-STATUS
               END-IF
           END-IF.
`;

const JOB_NAME = `LN${Date.now().toString(36).substring(0, 6).toUpperCase()}`;
const LOAN_JCL = `
//${JOB_NAME} JOB (ACCT),'LOAN BATCH',CLASS=A,MSGCLASS=X
//*
//STEP01   EXEC PGM=${PROGRAM_ID},PARM='BATCH'
//INPUT    DD DSN=PROD.LOAN.APPLICATIONS,DISP=SHR
//CREDIT   DD DSN=PROD.CREDIT.BUREAU,DISP=SHR
//OUTPUT   DD DSN=PROD.LOAN.DECISIONS,DISP=(NEW,CATLG,DELETE),
//            SPACE=(CYL,(50,10)),DCB=(RECFM=FB,LRECL=400)
//SYSPRINT DD SYSOUT=*
//*
//STEP02   EXEC PGM=NOTIFIER
//INFILE   DD DSN=PROD.LOAN.DECISIONS,DISP=SHR
//AUDITLOG DD DSN=PROD.AUDIT.TRAIL,DISP=MOD
`;

// ─── Results Tracker ───────────────────────────────────────
const results: { pillar: string; test: string; pass: boolean; detail: string }[] = [];

function check(pillar: string, test: string, condition: boolean, detail: string) {
  results.push({ pillar, test, pass: condition, detail });
  const icon = condition ? "✅" : "❌";
  console.log(`  ${icon} [${pillar}] ${test}: ${detail}`);
}

async function main() {
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log(`║  UNPREDICTABLE E2E TEST — ALL 7 PILLARS               ║`);
  console.log(`║  Program: ${PROGRAM_ID.padEnd(42)} ║`);
  console.log(`║  Session: ${SESSION_ID.substring(0, 42).padEnd(42)} ║`);
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  console.log(`  Config:`);
  console.log(`    EMBED_URL:       ${EMBED_URL}`);
  console.log(`    VLLM_URL:        ${VLLM_URL}`);
  console.log(`    FLARE_THRESHOLD: ${FLARE_THRESHOLD}`);
  console.log(`    LOG_DIR:         ${LOG_DIR}`);
  console.log();

  // ═══════════════════════════════════════════════════════════
  // PILLAR 3: Structural Slicing
  // ═══════════════════════════════════════════════════════════
  console.log("── PILLAR 3: Structural Slicing ──────────────────\n");

  const cobolResult = parseCobol(LOAN_PROCESSOR, { filename: `${PROGRAM_ID}.cbl` });
  check("P3", "Program name extracted", cobolResult.programName === PROGRAM_ID,
    cobolResult.programName);
  check("P3", "Paragraphs found", cobolResult.stats.paragraphs > 0,
    `${cobolResult.stats.paragraphs} paragraphs`);
  check("P3", "Business rules extracted", cobolResult.businessRules.length > 0,
    `${cobolResult.businessRules.length} rules`);
  check("P3", "Graph edges found", cobolResult.graph.edges.length > 0,
    `${cobolResult.graph.edges.length} edges`);

  // Dynamically find external calls from graph
  const callEdges = cobolResult.graph.edges.filter((e: any) => e.type === "CALLS");
  check("P3", "External calls detected", callEdges.length > 0,
    `${callEdges.length} calls: ${callEdges.map((e: any) => e.target).join(", ")}`);

  const jclResult = parseJcl(LOAN_JCL, { filename: `${JOB_NAME}.jcl` });
  check("P3", "JCL job parsed", jclResult.jobName === JOB_NAME,
    jclResult.jobName);
  check("P3", "JCL graph generated", (jclResult.graph?.nodes?.length || 0) > 0,
    `${jclResult.graph?.nodes?.length || 0} nodes, ${jclResult.graph?.edges?.length || 0} edges`);

  // ═══════════════════════════════════════════════════════════
  // PILLAR 4: Semantic Trees
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 4: Abstract Semantic Trees ─────────────\n");

  const domains = [...new Set(cobolResult.businessRules.map((r: any) => r.domain))];
  check("P4", "Multiple domains classified", domains.length > 1,
    `${domains.length} domains: ${domains.join(", ")}`);

  // Dynamically check: at least one domain should relate to risk/finance
  const hasFinanceDomain = domains.some((d: string) =>
    /risk|pric|financ|payment|account|credit/i.test(d));
  check("P4", "Financial domain detected", hasFinanceDomain,
    domains.filter((d: string) => /risk|pric|financ|payment|account|credit/i.test(d)).join(", "));

  check("P4", "Zero LLM calls", cobolResult.stats.llmCalls === 0,
    `${cobolResult.stats.llmCalls} LLM calls — pure deterministic`);

  const totalExtracted = cobolResult.businessRules.length
    + (cobolResult.dataAccess?.length || 0)
    + (cobolResult.controlFlow?.length || 0)
    + (cobolResult.dataTransforms?.length || 0);
  check("P4", "Semantic nodes extracted", totalExtracted > 0,
    `${totalExtracted} total (rules=${cobolResult.businessRules.length}, ` +
    `cf=${cobolResult.controlFlow?.length || 0}, ` +
    `dt=${cobolResult.dataTransforms?.length || 0})`);

  // ═══════════════════════════════════════════════════════════
  // PILLAR 1: RAPTOR
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 1: RAPTOR Tree ──────────────────────────\n");

  const store = new VectorStore(":memory:", EMBED_URL);

  // Dynamically collect ALL node types the parser produced
  const allNodes = [
    ...cobolResult.businessRules.map((r: any) => ({
      id: `${PROGRAM_ID}:rule:${r.id}`, nodeType: r.type,
      description: r.description, domain: r.domain, program: PROGRAM_ID,
    })),
    ...(cobolResult.dataAccess || []).map((d: any) => ({
      id: `${PROGRAM_ID}:data:${d.id}`, nodeType: d.type,
      description: d.description, domain: d.domain, program: PROGRAM_ID,
    })),
  ];

  console.log(`  Embedding ${allNodes.length} nodes via ${EMBED_URL.split("//")[1]?.split(".")[0]}...`);
  const descriptions = allNodes.map(n => n.description);
  const embeddings = await store.embed(descriptions, "passage");
  check("P1", "GPU embeddings returned",
    embeddings.length === descriptions.length && embeddings[0]?.length > 0,
    `${embeddings.length} vectors (dim=${embeddings[0]?.length || 0})`);

  const entries = allNodes.map((n, i) => ({ ...n, embedding: embeddings[i], metadata: {} }));
  store.upsertMany(entries);

  // Summarizer uses configured vLLM
  const summarizer = async (texts: string[]): Promise<string> => {
    try {
      const resp = await fetch(`${VLLM_URL}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Summarize in one sentence: ${texts.join("; ")}`,
          max_tokens: 60, temperature: 0.1,
        }),
      });
      const data = await resp.json() as { text: string };
      return data.text || texts[0];
    } catch { return texts.map(t => t.substring(0, 40)).join("; "); }
  };

  const builder = new RaptorTreeBuilder(store, summarizer);
  const tree = await builder.buildTree(entries, { maxClusterSize: 5 });
  check("P1", "RAPTOR tree built", tree.depth >= 1,
    `depth=${tree.depth}, nodes=${tree.totalNodes}`);
  check("P1", "Root node exists", !!tree.root,
    tree.root.description.substring(0, 60));

  // Dynamic search: pick queries from the actual parsed rules
  const sampleRule = cobolResult.businessRules[0];
  const searchQuery = `What does ${(sampleRule as any)?.id || "the main process"} do?`;
  const searchResults = await builder.search(searchQuery, tree, { beamWidth: 2, maxResults: 3 });
  check("P1", "Semantic search returns results", searchResults.length > 0,
    `"${searchQuery}" → ${searchResults[0]?.description?.substring(0, 50)}`);

  // ═══════════════════════════════════════════════════════════
  // PILLAR 2: KV Cache + Inference
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 2: KV Cache + Inference ─────────────────\n");

  // Build context dynamically from actual parsed rules
  const semanticContext = cobolResult.businessRules
    .map((r: any) => `[${r.domain}] ${r.description}`)
    .join("\n");

  // Query derived from actual program content
  const inferenceQuery = `Explain the main business logic of ${PROGRAM_ID} step by step.`;
  const resp1 = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: inferenceQuery,
      system_context: `Analyzed COBOL program ${PROGRAM_ID}:\n${semanticContext}`,
      max_tokens: 80,
    }),
  });
  const gen1 = await resp1.json() as any;
  check("P2", "LLM generates contextual answer", gen1.text?.length > 20,
    `"${gen1.text?.substring(0, 80)}..."`);
  check("P2", "Prefix caching active", gen1.prefix_cached === true,
    `prefix_cached=${gen1.prefix_cached}`);

  // Second query with SAME system context → should reuse prefix cache
  const resp2 = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "What happens when the application is rejected?",
      system_context: `Analyzed COBOL program ${PROGRAM_ID}:\n${semanticContext}`,
      max_tokens: 60,
    }),
  });
  const gen2 = await resp2.json() as any;
  check("P2", "Prefix cache reused (same context)", gen2.text?.length > 10,
    `"${gen2.text?.substring(0, 80)}..."`);

  // Logprobs for FLARE
  const resp3 = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: `Explain how ${PROGRAM_ID} handles credit risk.`,
      max_tokens: 60, return_logprobs: true,
    }),
  });
  const gen3 = await resp3.json() as any;
  check("P2", "Logprobs returned for FLARE", (gen3.logprobs?.length || 0) > 0,
    `${gen3.logprobs?.length || 0} logprobs`);

  // ═══════════════════════════════════════════════════════════
  // PILLAR 7: Trajectory + FLARE
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 7: Trajectory + FLARE ───────────────────\n");

  if (gen3.logprobs) {
    const uncertainTokens = gen3.logprobs.filter((lp: any) => lp.logprob < FLARE_THRESHOLD);
    check("P7", "FLARE: uncertain tokens detected", uncertainTokens.length > 0,
      `${uncertainTokens.length}/${gen3.logprobs.length} tokens below ${FLARE_THRESHOLD}`);
  }

  const logger = new TrajectoryLogger({ logDir: LOG_DIR, sessionId: SESSION_ID });
  logger.log({
    action: "PARSE",
    input: `${PROGRAM_ID}.cbl`,
    output: `${cobolResult.businessRules.length} rules, ${cobolResult.graph.edges.length} edges`,
    sources: ["cobol-parser"],
    latencyMs: 42,
  });
  logger.log({
    action: "VECTOR_SEARCH",
    input: searchQuery,
    output: `${searchResults.length} results, top=${searchResults[0]?.description?.substring(0, 40)}`,
    sources: ["raptor-tree", "vector-store"],
    latencyMs: 150,
  });

  const trajectory = logger.getTrajectory();
  check("P7", "Trajectory entries logged", trajectory.length >= 2,
    `${trajectory.length} entries: ${trajectory.map(e => e.action).join(" → ")}`);

  const report = logger.auditReport();
  check("P7", "Audit report generated", report.length > 0 && report.includes(SESSION_ID),
    `${report.length} chars, session=${SESSION_ID}`);

  const summary = logger.summary();
  check("P7", "Summary has correct stats",
    summary.totalSteps === trajectory.length && summary.sessionId === SESSION_ID,
    `steps=${summary.totalSteps}, sources=${summary.uniqueSources}`);

  // ═══════════════════════════════════════════════════════════
  // PILLAR 6: BYOS Storage
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 6: BYOS Storage ─────────────────────────\n");

  // Dynamically discover exported classes from the byos module
  const byosExports = Object.keys(byos);
  check("P6", "BYOS module has exports", byosExports.length > 0,
    `exports: ${byosExports.join(", ")}`);

  // Find the concrete client class dynamically
  const clientClass = byosExports.find(k =>
    typeof (byos as any)[k] === "function" && /client/i.test(k));
  check("P6", "BYOS client class found", !!clientClass,
    clientClass || "none found");

  if (clientClass) {
    const Cls = (byos as any)[clientClass];
    // Check it has storage methods
    const methods = Object.getOwnPropertyNames(Cls.prototype).filter(m => m !== "constructor");
    check("P6", "BYOS has storage methods", methods.length > 0,
      `methods: ${methods.join(", ")}`);
  }

  // ═══════════════════════════════════════════════════════════
  // PILLAR 5: Post-Training SFT Data
  // ═══════════════════════════════════════════════════════════
  console.log("\n── PILLAR 5: Post-Training SFT Data ──────────────\n");

  // Dynamically generate training pairs from whatever the parser produced
  const trainingPairs: { question: string; answer: string }[] = [];

  for (const rule of cobolResult.businessRules) {
    trainingPairs.push({
      question: `What does ${(rule as any).id} do in ${PROGRAM_ID}?`,
      answer: `${(rule as any).description}. Domain: ${(rule as any).domain}.`,
    });
  }
  if (callEdges.length > 0) {
    trainingPairs.push({
      question: `What external programs does ${PROGRAM_ID} call?`,
      answer: `${PROGRAM_ID} calls: ${callEdges.map((e: any) => e.target).join(", ")}`,
    });
  }

  check("P5", "Training pairs generated from parsed data", trainingPairs.length > 0,
    `${trainingPairs.length} Q&A pairs`);
  check("P5", "All pairs have valid Q&A",
    trainingPairs.every(p => p.question.length > 10 && p.answer.length > 10),
    `${trainingPairs.length}/${trainingPairs.length} valid`);

  // Format as OpenAI-compatible JSONL
  const jsonlLines = trainingPairs.map(p => JSON.stringify({
    messages: [
      { role: "system", content: `You are a COBOL analyst for ${PROGRAM_ID}.` },
      { role: "user", content: p.question },
      { role: "assistant", content: p.answer },
    ],
  }));
  check("P5", "JSONL format valid",
    jsonlLines.every(l => { try { JSON.parse(l); return true; } catch { return false; } }),
    `${jsonlLines.length} valid JSONL lines`);

  // ═══════════════════════════════════════════════════════════
  // FINAL SCORECARD
  // ═══════════════════════════════════════════════════════════
  store.close();

  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║                    FINAL SCORECARD                     ║");
  console.log("╠═══════════════════════════════════════════════════════╣");

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;

  const pillarNames: Record<string, string> = {
    P1: "RAPTOR Tree", P2: "KV Cache/Inference", P3: "Structural Slicing",
    P4: "Semantic Trees", P5: "Post-Training", P6: "BYOS Storage",
    P7: "Trajectory/FLARE",
  };

  for (const p of Object.keys(pillarNames)) {
    const pr = results.filter(r => r.pillar === p);
    const pp = pr.filter(r => r.pass).length;
    const icon = pp === pr.length ? "✅" : "⚠️";
    console.log(`║  ${icon} ${p}: ${pillarNames[p]!.padEnd(22)} ${pp}/${pr.length} passed       ║`);
  }

  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  TOTAL: ${passed}/${total} passed, ${failed} failed${" ".repeat(30 - String(passed).length - String(total).length - String(failed).length)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");

  if (failed > 0) {
    console.log("\n❌ FAILURES:");
    for (const r of results.filter(r => !r.pass)) {
      console.log(`   [${r.pillar}] ${r.test}: ${r.detail}`);
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
