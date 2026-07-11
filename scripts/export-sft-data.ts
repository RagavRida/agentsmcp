#!/usr/bin/env npx tsx
// ============================================================
// Export SFT Training Data from Neo4j Graph → JSONL file
// ============================================================

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  SFT Training Data Export");
  console.log("═══════════════════════════════════════════\n");

  const { Neo4jSync } = require("../src/graph/neo4j-sync");
  const fs = require("fs");

  const neo4j = new Neo4jSync({
    uri: process.env.AGENTSMCP_NEO4J_URI || "bolt://localhost:7687",
    user: process.env.AGENTSMCP_NEO4J_USER || "neo4j",
    password: process.env.AGENTSMCP_NEO4J_PASS || "agentsmcp2026",
  });

  try {
    console.log("Step 1: Generating Q&A pairs from graph...");
    const pairs = await neo4j.generateTrainingPairs(1000);
    console.log(`  Generated ${pairs.length} pairs\n`);

    // Format as JSONL (SFT format)
    const outputPath = "./data/sft_training_data.jsonl";
    fs.mkdirSync("./data", { recursive: true });

    const lines = pairs.map((p: { question: string; answer: string }) =>
      JSON.stringify({
        messages: [
          { role: "system", content: "You are a COBOL mainframe analyst helping with banking code migration." },
          { role: "user", content: p.question },
          { role: "assistant", content: p.answer },
        ],
      })
    );

    fs.writeFileSync(outputPath, lines.join("\n") + "\n");
    console.log(`Step 2: Exported to ${outputPath}`);
    console.log(`  Format: JSONL (OpenAI SFT compatible)\n`);

    // Print sample
    console.log("Step 3: Sample training pairs:\n");
    for (const pair of pairs.slice(0, 5)) {
      console.log(`  Q: ${pair.question}`);
      console.log(`  A: ${pair.answer.substring(0, 120)}...`);
      console.log();
    }

    // Stats
    const totalTokens = lines.reduce((sum: number, l: string) => sum + l.split(/\s+/).length, 0);
    console.log("═══════════════════════════════════════════");
    console.log(`  ✅ ${pairs.length} pairs → ${outputPath}`);
    console.log(`  ~${totalTokens} tokens (estimated)`);
    console.log("═══════════════════════════════════════════");
  } finally {
    await neo4j.close();
  }
}

main().catch(console.error);
