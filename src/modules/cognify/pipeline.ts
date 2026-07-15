import { createHash } from "node:crypto";
import type { VectorEntry } from "../../vector/store";
import { resolve as resolveStoreOp } from "../../vector/interface";
import type { MainframeLanguage, ParseCobolResult, ParseMainframeResult, SemanticNodeCompact } from "../../parser";
import { parseMainframeSourceAsync } from "../../parser";
import type { MemoryConfig } from "../../memory/api";
import type { RaptorTree } from "../../raptor/tree-builder";
import { Pipeline, type PipelineOptions, type Task, type TaskExecutionView } from "../../pipeline/orchestrator";

export const COGNIFY_TASK_IDS = {
  parse: "cognify.parse",
  embed: "cognify.embed",
  vector: "cognify.vector",
  raptor: "cognify.raptor",
  graph: "cognify.graph",
  byos: "cognify.byos",
  trajectory: "cognify.trajectory",
} as const;

export interface CognifyOptions {
  source: string;
  sessionId?: string;
  dataset: string;
  filename?: string;
  language?: MainframeLanguage;
}

export interface CognifyContext {
  options: CognifyOptions;
  config: MemoryConfig;
  startedAt: number;
  setTree: (program: string, tree: RaptorTree) => void;
}

interface ParsedOutput {
  parsed: ParseCobolResult | ParseMainframeResult;
  programName: string;
  nodes: SemanticNodeCompact[];
}

interface EmbeddedOutput extends ParsedOutput {
  entries: VectorEntry[];
}

interface VectorOutput extends EmbeddedOutput {
  vectorsStored: number;
}

interface RaptorOutput extends VectorOutput {
  treeDepth: number;
}

interface GraphOutput extends RaptorOutput {
  graphNodesSynced: number;
}

interface ByosOutput extends GraphOutput {
  byosUploaded: boolean;
}

export interface CognifyOutput {
  status: "completed";
  program: string;
  rulesExtracted: number;
  businessRules: Array<{
    id: string;
    type: string;
    domain?: string;
    description: string;
  }>;
  vectorsStored: number;
  graphNodesSynced: number;
  raptorTreeDepth: number;
  byosUploaded: boolean;
  elapsedMs: number;
}

function flattenNodes(node: SemanticNodeCompact): SemanticNodeCompact[] {
  const nodes: SemanticNodeCompact[] = [node];
  for (const child of node.children) nodes.push(...flattenNodes(child));
  return nodes;
}

function parseStats(parsed: ParseCobolResult | ParseMainframeResult): { paragraphs: number; variables: number } {
  return {
    paragraphs: "paragraphs" in parsed.stats ? parsed.stats.paragraphs : 0,
    variables: "variables" in parsed.stats ? parsed.stats.variables : 0,
  };
}

class ParseTask implements Task<CognifyContext, ParsedOutput> {
  id = COGNIFY_TASK_IDS.parse;

  async execute(context: CognifyContext): Promise<ParsedOutput> {
    const { options, config } = context;
    const parsed = config.parser
      ? await config.parser(options.source, {
          filename: options.filename,
          language: options.language,
        })
      : await parseMainframeSourceAsync(options.source, {
          filename: options.filename,
          language: options.language,
        });
    const programName = parsed.programName ?? "UNKNOWN";
    const nodes = [...flattenNodes(parsed.semanticTree), ...parsed.businessRules];

    if (options.sessionId) {
      config.sessionManager?.set(options.sessionId, config.sessionAgentId ?? "memory-api", "lastProgram", programName, { source: "pipeline" });
      config.sessionManager?.set(options.sessionId, config.sessionAgentId ?? "memory-api", "lastParseRules", nodes.length, { source: "pipeline" });
      config.sessionManager?.set(options.sessionId, config.sessionAgentId ?? "memory-api", "lastParseTime", new Date().toISOString(), { source: "pipeline" });
    }

    return { parsed, programName, nodes };
  }
}

class EmbedTask implements Task<CognifyContext, EmbeddedOutput> {
  id = COGNIFY_TASK_IDS.embed;
  dependencies = [COGNIFY_TASK_IDS.parse];

  async execute(context: CognifyContext, results: TaskExecutionView): Promise<EmbeddedOutput> {
    const parsed = results.require<ParsedOutput>(COGNIFY_TASK_IDS.parse);
    const embeddings = await context.config.embedder(parsed.nodes.map((node) => node.description));
    const entries: VectorEntry[] = parsed.nodes.map((node, index) => ({
      id: `${parsed.programName}::${node.id}`,
      program: parsed.programName,
      nodeType: node.type,
      domain: node.domain ?? "unknown",
      description: node.description,
      embedding: embeddings[index],
      metadata: { dataset: context.options.dataset, source: "cognify" },
    }));
    return { ...parsed, entries };
  }
}

class VectorSyncTask implements Task<CognifyContext, VectorOutput> {
  id = COGNIFY_TASK_IDS.vector;
  dependencies = [COGNIFY_TASK_IDS.embed];

  async execute(_context: CognifyContext, results: TaskExecutionView): Promise<VectorOutput> {
    const embedded = results.require<EmbeddedOutput>(COGNIFY_TASK_IDS.embed);
    await resolveStoreOp(_context.config.vectorStore.upsertMany(embedded.entries));
    return { ...embedded, vectorsStored: embedded.entries.length };
  }

  async rollback(context: CognifyContext, results: TaskExecutionView): Promise<void> {
    const parsed = results.get<ParsedOutput>(COGNIFY_TASK_IDS.parse);
    if (parsed) await resolveStoreOp(context.config.vectorStore.deleteByProgram(parsed.programName));
  }
}

class RaptorTask implements Task<CognifyContext, RaptorOutput> {
  id = COGNIFY_TASK_IDS.raptor;
  dependencies = [COGNIFY_TASK_IDS.vector];

  async execute(context: CognifyContext, results: TaskExecutionView): Promise<RaptorOutput> {
    const vector = results.require<VectorOutput>(COGNIFY_TASK_IDS.vector);
    const tree = await context.config.raptorBuilder.buildTree(vector.entries);
    context.setTree(vector.programName, tree);
    await context.config.raptorTreeStore.save(vector.programName, tree);
    return { ...vector, treeDepth: tree.depth };
  }

  async rollback(context: CognifyContext, results: TaskExecutionView): Promise<void> {
    const parsed = results.get<ParsedOutput>(COGNIFY_TASK_IDS.parse);
    if (parsed) await context.config.raptorTreeStore.delete(parsed.programName);
  }
}

class GraphSyncTask implements Task<CognifyContext, GraphOutput> {
  id = COGNIFY_TASK_IDS.graph;
  dependencies = [COGNIFY_TASK_IDS.parse, COGNIFY_TASK_IDS.raptor];

  async execute(context: CognifyContext, results: TaskExecutionView): Promise<GraphOutput> {
    const parsed = results.require<ParsedOutput>(COGNIFY_TASK_IDS.parse);
    const raptor = results.require<RaptorOutput>(COGNIFY_TASK_IDS.raptor);
    let graphNodesSynced = 0;
    if (context.config.neo4jSync) {
      const syncResult = await context.config.neo4jSync.syncCobol({
        programName: parsed.programName,
        graph: parsed.parsed.graph,
        semanticTree: {
          description: parsed.parsed.semanticTree.description,
          domain: parsed.parsed.semanticTree.domain ?? "unknown",
        },
        businessRules: parsed.nodes.map((node) => ({
          id: node.id,
          description: node.description,
          domain: node.domain ?? "unknown",
        })),
        stats: parseStats(parsed.parsed),
      });
      graphNodesSynced = syncResult.nodesCreated;
    }
    return { ...raptor, graphNodesSynced };
  }

  async rollback(context: CognifyContext, results: TaskExecutionView): Promise<void> {
    const parsed = results.get<ParsedOutput>(COGNIFY_TASK_IDS.parse);
    if (parsed && context.config.neo4jSync) await context.config.neo4jSync.deleteProgram(parsed.programName);
  }
}

class ByosTask implements Task<CognifyContext, ByosOutput> {
  id = COGNIFY_TASK_IDS.byos;
  dependencies = [COGNIFY_TASK_IDS.graph];

  async execute(context: CognifyContext, results: TaskExecutionView): Promise<ByosOutput> {
    const graph = results.require<GraphOutput>(COGNIFY_TASK_IDS.graph);
    let byosUploaded = false;
    if (context.config.byosClient) {
      await context.config.byosClient.storeVectors(graph.programName, Buffer.from(JSON.stringify(graph.parsed)));
      byosUploaded = true;
    }
    return { ...graph, byosUploaded };
  }
}

class TrajectoryTask implements Task<CognifyContext, CognifyOutput> {
  id = COGNIFY_TASK_IDS.trajectory;
  dependencies = [COGNIFY_TASK_IDS.byos];

  async execute(context: CognifyContext, results: TaskExecutionView): Promise<CognifyOutput> {
    const output = results.require<ByosOutput>(COGNIFY_TASK_IDS.byos);
    const businessRules = output.nodes
      .filter((node) => node.type === "BUSINESS_RULE")
      .map((node) => ({
        id: node.id,
        type: node.type,
        domain: node.domain,
        description: node.description,
      }));
    const result: CognifyOutput = {
      status: "completed",
      program: output.programName,
      rulesExtracted: output.nodes.length,
      businessRules,
      vectorsStored: output.vectorsStored,
      graphNodesSynced: output.graphNodesSynced,
      raptorTreeDepth: output.treeDepth,
      byosUploaded: output.byosUploaded,
      elapsedMs: Date.now() - context.startedAt,
    };
    context.config.trajectory?.logParse(output.programName, {
      programName: output.programName,
      businessRules: output.nodes.length,
      graphNodes: output.graphNodesSynced,
    }, result.elapsedMs);
    return result;
  }
}

export function cognifyStateFile(options: CognifyOptions): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ source: options.source, dataset: options.dataset, filename: options.filename, language: options.language }))
    .digest("hex");
  const root = process.env.AGENTSMCP_PIPELINE_STATE_DIR ?? ".agentmailbox/pipelines";
  return `${root}/cognify-${digest}.json`;
}

export function createCognifyPipeline(options: CognifyOptions, config: MemoryConfig, pipelineOptions: PipelineOptions = {}): Pipeline<CognifyContext> {
  // A persisted completion is only safe when the vector/graph stores are also
  // durable and shared by the resumed process. Operators opt into that mode;
  // the default executes idempotent tasks against the active store instance.
  const stateFile = pipelineOptions.stateFile ?? (
    process.env.AGENTSMCP_PIPELINE_RESUME === "true" ? cognifyStateFile(options) : undefined
  );
  return new Pipeline<CognifyContext>([
    new ParseTask(),
    new EmbedTask(),
    new VectorSyncTask(),
    new RaptorTask(),
    new GraphSyncTask(),
    new ByosTask(),
    new TrajectoryTask(),
  ], {
    stateFile,
    rollbackOnFailure: pipelineOptions.rollbackOnFailure ?? true,
    ...pipelineOptions,
  });
}

export async function runCognifyPipeline(
  options: CognifyOptions,
  config: MemoryConfig,
  setTree: (program: string, tree: RaptorTree) => void = () => undefined,
  pipelineOptions: PipelineOptions = {},
): Promise<CognifyOutput> {
  const pipeline = createCognifyPipeline(options, config, pipelineOptions);
  const result = await pipeline.run({ options, config, startedAt: Date.now(), setTree });
  if (result.status === "FAILED") {
    const state = pipeline.getState();
    throw new Error(`Cognify pipeline failed at ${result.failed}: ${state?.tasks[result.failed ?? ""]?.error ?? "unknown error"}`);
  }
  return result.outputs[COGNIFY_TASK_IDS.trajectory] as CognifyOutput;
}
