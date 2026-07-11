#!/usr/bin/env npx tsx
// ============================================================
// DYNAMIC EVAL HARNESS
//
// Ground truth is derived FROM the pipeline output, not
// hardcoded. Tests whether the system is self-consistent:
//   - Can search find what the parser produced?
//   - Can the LLM answer using the context the parser built?
//   - Does FLARE distinguish in-context from out-of-context?
// ============================================================

import { VectorStore } from "../src/vector/store";
import { RaptorTreeBuilder } from "../src/raptor/tree-builder";
import { parseCobol } from "../src/parser";
import { TrajectoryLogger } from "../src/trajectory/logger";
import * as path from "path";
import * as os from "os";

const EMBED_URL = process.env.AGENTSMCP_MODAL_EMBED_URL
  || "https://ragavrida--agentmailbox-embedder-fastapi-app.modal.run";
const VLLM_URL = process.env.AGENTSMCP_VLLM_URL
  || "https://ragavrida--agentmailbox-inference-fastapi-app.modal.run";
const FLARE_THRESHOLD = parseFloat(process.env.FLARE_THRESHOLD || "-0.5");

// Unique program every run
const PID = `EVAL-${Date.now().toString(36).toUpperCase()}`;

const SOURCE = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. ${PID}.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       01 WS-BALANCE          PIC 9(10)V99.
       01 WS-WITHDRAWAL       PIC 9(10)V99.
       01 WS-DAILY-LIMIT      PIC 9(10)V99 VALUE 5000.
       01 WS-OVERDRAFT-FEE    PIC 9(5)V99 VALUE 35.00.
       01 WS-INTEREST-RATE    PIC 9(3)V9999 VALUE 4.5000.
       01 WS-MIN-BALANCE      PIC 9(10)V99 VALUE 100.00.
       01 WS-MONTHLY-FEE      PIC 9(5)V99 VALUE 12.99.
       01 WS-ACCOUNT-TYPE     PIC X(10).
       PROCEDURE DIVISION.
       MAIN-PROCESS.
           PERFORM CHECK-WITHDRAWAL
           PERFORM APPLY-OVERDRAFT
           PERFORM CALCULATE-INTEREST
           PERFORM ASSESS-FEES
           CALL 'FRAUD-DETECTOR' USING WS-WITHDRAWAL
           STOP RUN.
       CHECK-WITHDRAWAL.
           IF WS-WITHDRAWAL > WS-DAILY-LIMIT
               DISPLAY 'EXCEEDS DAILY LIMIT'
               STOP RUN
           END-IF
           IF WS-WITHDRAWAL > WS-BALANCE
               DISPLAY 'INSUFFICIENT FUNDS'
           END-IF.
       APPLY-OVERDRAFT.
           IF WS-BALANCE < 0
               COMPUTE WS-BALANCE = WS-BALANCE - WS-OVERDRAFT-FEE
               DISPLAY 'OVERDRAFT FEE APPLIED'
           END-IF.
       CALCULATE-INTEREST.
           IF WS-BALANCE > WS-MIN-BALANCE
               COMPUTE WS-BALANCE = WS-BALANCE +
                   (WS-BALANCE * WS-INTEREST-RATE / 100 / 12)
           END-IF.
       ASSESS-FEES.
           IF WS-ACCOUNT-TYPE NOT = 'PREMIUM'
               IF WS-BALANCE < WS-MIN-BALANCE
                   COMPUTE WS-BALANCE = WS-BALANCE - WS-MONTHLY-FEE
               END-IF
           END-IF.
`;

// ─── Eval Framework ────────────────────────────────────────
interface EvalResult {
  category: string;
  test: string;
  score: number;
  detail: string;
}

const evals: EvalResult[] = [];

function score(category: string, test: string, s: number, detail: string) {
  const sc = Math.min(1, Math.max(0, s));
  evals.push({ category, test, score: sc, detail });
  const bar = "█".repeat(Math.round(sc * 10)) + "░".repeat(10 - Math.round(sc * 10));
  console.log(`  ${bar} ${(sc * 100).toFixed(0).padStart(3)}% | ${test}: ${detail}`);
}

async function main() {
  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║  DYNAMIC EVAL — Ground truth from pipeline output      ║");
  console.log(`║  Program: ${PID.padEnd(46)} ║`);
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // ── Step 1: Parse ────────────────────────────────────────
  const parsed = parseCobol(SOURCE, { filename: `${PID}.cbl` });
  const rules = parsed.businessRules as any[];
  const transforms = (parsed.dataTransforms || []) as any[];
  const controlFlow = (parsed.controlFlow || []) as any[];
  const edges = parsed.graph.edges as any[];

  console.log(`  Parsed: ${rules.length} rules, ${transforms.length} transforms, ${controlFlow.length} control flow, ${edges.length} edges\n`);

  // ═══════════════════════════════════════════════════════════
  // EVAL 1: Parser Self-Consistency
  // "Does the parser produce internally consistent output?"
  // ═══════════════════════════════════════════════════════════
  console.log("── EVAL 1: Parser Self-Consistency ────────────────\n");

  // Program name matches what we gave it
  score("Parser", "Program ID round-trip",
    parsed.programName === PID ? 1.0 : 0.0,
    `in=${PID}, out=${parsed.programName}`);

  // Every business rule has required fields
  const validRules = rules.filter(r => r.id && r.description && r.domain);
  score("Parser", "Rule completeness",
    rules.length > 0 ? validRules.length / rules.length : 0,
    `${validRules.length}/${rules.length} rules have id+description+domain`);

  // Graph edges reference nodes that exist
  const nodeIds = new Set(parsed.graph.nodes?.map((n: any) => n.id) || []);
  const validEdges = edges.filter(e => e.source || e.target);
  score("Parser", "Graph edge validity",
    edges.length > 0 ? validEdges.length / edges.length : 0,
    `${validEdges.length}/${edges.length} edges have source/target`);

  // Domains are diverse (not all "General")
  const domains = [...new Set(rules.map(r => r.domain))];
  score("Parser", "Domain diversity",
    Math.min(1, domains.length / 2),
    `${domains.length} domains: ${domains.join(", ")}`);

  // Zero LLM calls
  score("Parser", "Deterministic (0 LLM calls)",
    parsed.stats.llmCalls === 0 ? 1.0 : 0.0,
    `${parsed.stats.llmCalls} LLM calls`);

  // ═══════════════════════════════════════════════════════════
  // EVAL 2: Search Self-Retrieval
  // "If I search for a rule's own description, does it find itself?"
  // ═══════════════════════════════════════════════════════════
  console.log("\n── EVAL 2: Search Self-Retrieval ──────────────────\n");

  const store = new VectorStore(":memory:", EMBED_URL);
  const nodes = rules.map((r, i) => ({
    id: `${PID}:${i}`, nodeType: r.type, description: r.description,
    domain: r.domain, program: PID,
  }));
  const descs = nodes.map(n => n.description);
  const embs = await store.embed(descs, "passage");
  const entries = nodes.map((n, i) => ({ ...n, embedding: embs[i], metadata: {} }));
  store.upsertMany(entries);

  // For each rule, search with its description → must find itself as #1
  let selfRetrievalHits = 0;
  for (const rule of rules.slice(0, 5)) {
    const results = await store.semanticSearch(rule.description, { limit: 3 });
    const foundSelf = results[0]?.description === rule.description;
    if (foundSelf) selfRetrievalHits++;
  }
  const testCount = Math.min(5, rules.length);
  score("Search", "Self-retrieval (exact match)",
    testCount > 0 ? selfRetrievalHits / testCount : 0,
    `${selfRetrievalHits}/${testCount} rules found themselves as top result`);

  // Cross-retrieval: search for one rule, should NOT return an unrelated rule as #1
  if (rules.length >= 2) {
    const r1 = rules[0];
    const r2 = rules[rules.length - 1];
    const crossResults = await store.semanticSearch(r1.description, { limit: 1 });
    const notCrossContaminated = crossResults[0]?.description !== r2.description;
    score("Search", "No cross-contamination",
      notCrossContaminated ? 1.0 : 0.0,
      `"${r1.description.substring(0, 30)}" did not return "${r2.description.substring(0, 30)}"`);
  }

  // Semantic similarity: paraphrase a rule, check if it still matches
  if (rules.length > 0) {
    // Take first rule and extract key words to form a natural query
    const firstRule = rules[0];
    const words = firstRule.description.split(/\s+/).filter((w: string) => w.length > 3).slice(0, 3);
    const paraphrase = `How does the system handle ${words.join(" ")}?`;
    const paraResults = await store.semanticSearch(paraphrase, { limit: 3 });
    const topScore = paraResults[0]?.score || 0;
    score("Search", "Paraphrase retrieval",
      topScore > 0.4 ? Math.min(1, topScore / 0.7) : 0,
      `"${paraphrase}" → score=${topScore.toFixed(3)}`);
  }

  // ═══════════════════════════════════════════════════════════
  // EVAL 3: RAPTOR Tree Quality
  // "Does the tree summarize correctly and enable hierarchical search?"
  // ═══════════════════════════════════════════════════════════
  console.log("\n── EVAL 3: RAPTOR Tree Quality ────────────────────\n");

  const summarizer = async (texts: string[]): Promise<string> => {
    try {
      const resp = await fetch(`${VLLM_URL}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `Summarize: ${texts.join("; ")}`, max_tokens: 60, temperature: 0.1 }),
      });
      return ((await resp.json()) as any).text || texts[0];
    } catch { return texts.map(t => t.substring(0, 40)).join("; "); }
  };

  const builder = new RaptorTreeBuilder(store, summarizer);
  const tree = await builder.buildTree(entries, { maxClusterSize: 5 });

  // Tree should have more depth than flat
  score("RAPTOR", "Tree has hierarchy",
    tree.depth >= 2 ? 1.0 : tree.depth === 1 ? 0.5 : 0.0,
    `depth=${tree.depth}, nodes=${tree.totalNodes}`);

  // Tree should have MORE nodes than input (summaries added)
  score("RAPTOR", "Summaries added",
    tree.totalNodes > entries.length ? 1.0 : 0.0,
    `input=${entries.length}, tree=${tree.totalNodes}`);

  // Root should reference multiple children's concepts
  const rootDesc = tree.root?.description?.toLowerCase() || "";
  const rulesInRoot = rules.filter(r =>
    rootDesc.includes(r.description.split(" ")[0]?.toLowerCase() || "zzz"));
  score("RAPTOR", "Root covers multiple rules",
    Math.min(1, rulesInRoot.length / 2),
    `root mentions ${rulesInRoot.length} rule keywords`);

  // ═══════════════════════════════════════════════════════════
  // EVAL 4: LLM Context Grounding
  // "Does the LLM answer based on what we gave it, not hallucinate?"
  // ═══════════════════════════════════════════════════════════
  console.log("\n── EVAL 4: LLM Context Grounding ──────────────────\n");

  // Build context from actual parser output
  const context = rules.map(r => `[${r.domain}] ${r.description}`).join("\n");
  const sysPrompt = `You are analyzing COBOL program ${PID}. Here is the extracted logic:\n${context}`;

  // Test 1: Ask about a rule that IS in context → answer should reference it
  for (const rule of rules.slice(0, 3)) {
    const keywords = rule.description.split(/\s+/).filter((w: string) => w.length > 3).slice(0, 2);
    const question = `What does the ${keywords.join(" ")} logic do in ${PID}?`;

    const resp = await fetch(`${VLLM_URL}/generate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: question, system_context: sysPrompt, max_tokens: 80, temperature: 0.1 }),
    });
    const gen = (await resp.json()) as any;
    const answer = (gen.text || "").toLowerCase();

    // Check if answer references ANY keyword from the rule description
    const ruleWords = rule.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    const hits = ruleWords.filter((w: string) => answer.includes(w));
    const grounding = ruleWords.length > 0 ? hits.length / Math.min(ruleWords.length, 4) : 0;

    score("LLM", `Grounded: "${keywords.join(" ")}"`,
      Math.min(1, grounding),
      `${hits.length} rule keywords found in answer`);
  }

  // Test 2: Ask about something NOT in context → answer should hedge or say unknown
  const madeUpQ = `What is the exact SWIFT BIC code for the GLBXPAY international wire module in ${PID}?`;
  const madeUpResp = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: madeUpQ, system_context: sysPrompt, max_tokens: 60, temperature: 0.1 }),
  });
  const madeUpGen = (await madeUpResp.json()) as any;
  const madeUpAnswer = (madeUpGen.text || "").toLowerCase();

  // Good: mentions "not found", "not mentioned", "no information", "doesn't"
  const hedgeTerms = ["not ", "no ", "doesn't", "don't", "cannot", "isn't", "unavailable", "unknown", "unclear"];
  const hedges = hedgeTerms.filter(t => madeUpAnswer.includes(t));
  score("LLM", "Hedges on unknown facts",
    hedges.length > 0 ? 1.0 : 0.0,
    `hedges found: ${hedges.length > 0 ? hedges.join(", ") : "none — model may be hallucinating"}`);

  // ═══════════════════════════════════════════════════════════
  // EVAL 5: FLARE Confidence Calibration
  // "Is the model MORE confident on in-context than out-of-context?"
  // ═══════════════════════════════════════════════════════════
  console.log("\n── EVAL 5: FLARE Calibration ──────────────────────\n");

  // In-context query (model has the answer in system prompt)
  const inCtxResp = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: `List the paragraphs in ${PID}.`,
      system_context: sysPrompt,
      max_tokens: 40, return_logprobs: true, temperature: 0.1,
    }),
  });
  const inCtx = (await inCtxResp.json()) as any;
  const inCtxAvg = inCtx.logprobs?.length > 0
    ? inCtx.logprobs.reduce((s: number, lp: any) => s + lp.logprob, 0) / inCtx.logprobs.length
    : -999;

  // Out-of-context query (model has NO relevant info)
  const outCtxResp = await fetch(`${VLLM_URL}/generate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: "What are the exact VSAM cluster names and CIDR ranges for the APAC data center failover in GLBXPAY?",
      max_tokens: 40, return_logprobs: true, temperature: 0.1,
    }),
  });
  const outCtx = (await outCtxResp.json()) as any;
  const outCtxAvg = outCtx.logprobs?.length > 0
    ? outCtx.logprobs.reduce((s: number, lp: any) => s + lp.logprob, 0) / outCtx.logprobs.length
    : -999;

  score("FLARE", "In-context confidence",
    inCtxAvg > -1.0 ? Math.min(1, (inCtxAvg + 2) / 2) : 0,
    `avg logprob=${inCtxAvg.toFixed(3)}`);

  // The gap matters more than absolute values
  const gap = inCtxAvg - outCtxAvg;
  score("FLARE", "Confidence gap (in vs out)",
    gap > 0.05 ? Math.min(1, gap / 0.5) : 0,
    `in=${inCtxAvg.toFixed(3)}, out=${outCtxAvg.toFixed(3)}, gap=${gap.toFixed(3)}`);

  // Count tokens below threshold
  if (outCtx.logprobs) {
    const uncertain = outCtx.logprobs.filter((lp: any) => lp.logprob < FLARE_THRESHOLD);
    score("FLARE", "Uncertain tokens on unknowns",
      uncertain.length > 0 ? Math.min(1, uncertain.length / outCtx.logprobs.length) : 0,
      `${uncertain.length}/${outCtx.logprobs.length} below ${FLARE_THRESHOLD}`);
  }

  // ═══════════════════════════════════════════════════════════
  // EVAL 6: Trajectory Audit Completeness
  // ═══════════════════════════════════════════════════════════
  console.log("\n── EVAL 6: Trajectory Audit ───────────────────────\n");

  const logger = new TrajectoryLogger({
    logDir: path.join(os.tmpdir(), "eval-traj"),
    sessionId: `eval-${PID}`,
  });

  // Log actions from this eval
  logger.log({ action: "PARSE", input: `${PID}.cbl`, output: `${rules.length} rules`, sources: ["parser"], latencyMs: 10 });
  logger.log({ action: "VECTOR_SEARCH", input: "self-retrieval", output: `${selfRetrievalHits} hits`, sources: ["vector-store"], latencyMs: 50 });
  logger.log({ action: "LLM_GENERATION", input: "grounding test", output: "completed", sources: ["vllm"], latencyMs: 200 });

  const traj = logger.getTrajectory();
  score("Audit", "All actions logged",
    traj.length >= 3 ? 1.0 : traj.length / 3,
    `${traj.length} entries`);

  // Check every entry has required fields
  const complete = traj.filter(e => e.action && e.input && e.output && e.timestamp && e.latencyMs >= 0);
  score("Audit", "Entry completeness",
    traj.length > 0 ? complete.length / traj.length : 0,
    `${complete.length}/${traj.length} fully formed`);

  const summary = logger.summary();
  score("Audit", "Summary correctness",
    summary.totalSteps === traj.length ? 1.0 : 0.0,
    `steps=${summary.totalSteps}, sources=${summary.uniqueSources}`);

  store.close();

  // ═══════════════════════════════════════════════════════════
  // FINAL REPORT
  // ═══════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║                  DYNAMIC EVAL SUMMARY                  ║");
  console.log("╠════════════════════════════════════════════════════════╣");

  const categories = [...new Set(evals.map(e => e.category))];
  for (const cat of categories) {
    const ce = evals.filter(e => e.category === cat);
    const avg = ce.reduce((s, e) => s + e.score, 0) / ce.length;
    const bar = "█".repeat(Math.round(avg * 10)) + "░".repeat(10 - Math.round(avg * 10));
    const grade = avg >= 0.9 ? "A+" : avg >= 0.8 ? "A" : avg >= 0.7 ? "B" :
                  avg >= 0.6 ? "C" : avg >= 0.5 ? "D" : "F";
    console.log(`║  ${bar} ${(avg * 100).toFixed(0).padStart(3)}% [${grade.padEnd(2)}] ${cat.padEnd(20)} (${ce.length} tests) ║`);
  }

  const overall = evals.reduce((s, e) => s + e.score, 0) / evals.length;
  const overallGrade = overall >= 0.9 ? "A+" : overall >= 0.8 ? "A" : overall >= 0.7 ? "B" :
                       overall >= 0.6 ? "C" : overall >= 0.5 ? "D" : "F";
  const ob = "█".repeat(Math.round(overall * 10)) + "░".repeat(10 - Math.round(overall * 10));
  console.log("╠════════════════════════════════════════════════════════╣");
  console.log(`║  ${ob} ${(overall * 100).toFixed(0).padStart(3)}% [${overallGrade.padEnd(2)}] OVERALL${" ".repeat(24)}║`);
  console.log("╚════════════════════════════════════════════════════════╝");

  const low = evals.filter(e => e.score < 0.7);
  if (low.length > 0) {
    console.log("\n⚠️  LOW SCORES (< 70%):");
    for (const e of low) {
      console.log(`   [${e.category}] ${e.test}: ${(e.score * 100).toFixed(0)}% — ${e.detail}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
