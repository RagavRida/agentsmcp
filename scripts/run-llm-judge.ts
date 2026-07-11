import { detectModelConfig } from "../src/model/provider";
import { buildCorpusIndex } from "../src/eval/index-corpus";
import { evaluateAnswerQuality } from "../src/eval/answer-quality";
import { loadDataset } from "../src/eval/registry";

async function main(): Promise<void> {
  const datasetId = process.argv.includes("--dataset") ? process.argv[process.argv.indexOf("--dataset") + 1] : "sample";
  const dataset = loadDataset(datasetId);
  const provider = detectModelConfig();
  console.log(`Dataset: ${dataset.meta.name}`);
  console.log(`Judge provider: ${provider.provider} (${provider.model})`);
  console.log(`Questions: ${dataset.qaPairs.length}`);
  if (provider.provider === "none") { console.log("NOT MEASURED: configure AGENTSMCP_VLLM_URL, OLLAMA_URL, OPENAI_API_KEY, or another model provider."); process.exitCode = 2; return; }
  if (!process.env.AGENTSMCP_MODAL_EMBED_URL) { console.log("NOT MEASURED: configure AGENTSMCP_MODAL_EMBED_URL for grounded retrieval context."); process.exitCode = 2; return; }
  const store = await buildCorpusIndex(dataset.corpus);
  if (!store) throw new Error("Embedding index could not be created");
  try {
    const result = await evaluateAnswerQuality(store, dataset.corpus, dataset.qaPairs, 5);
    if (!result.aggregate) throw new Error("LLM judge returned no aggregate metrics");
    console.log(JSON.stringify({ provider, dataset: datasetId, metrics: result.aggregate }, null, 2));
  } finally { store.close(); }
}
main().catch((error) => { console.error(`LLM judge failed: ${String(error)}`); process.exitCode = 1; });
