import type { IngestedBusinessRule, IngestionInventory, IngestionInventoryEntry, IngestionSourceDetails } from "../ingestion/contracts";

export interface ImpactAnalyzeRequest {
  sourceId?: string;
  ruleId?: string;
  target?: string;
  maxResults?: number;
}

export interface ImpactAffectedSource {
  sourceId: string;
  filename: string;
  program?: string;
  dataset: string;
  relationship: "selected_source" | "same_program" | "same_dataset" | "rule_overlap" | "target_match";
  score: number;
  evidence: string[];
}

export interface ImpactAffectedRule extends IngestedBusinessRule {
  sourceId: string;
  program?: string;
  score: number;
  evidence: string[];
}

export interface ImpactAnalysisResult {
  target: string;
  targetSource?: IngestionSourceDetails;
  riskLevel: "low" | "medium" | "high";
  affectedSources: ImpactAffectedSource[];
  affectedRules: ImpactAffectedRule[];
  affectedDatasets: string[];
  affectedPrograms: string[];
  totalAffected: number;
  evidence: string[];
}

export interface ImpactInventoryProvider {
  inventory(): Promise<IngestionInventory>;
  sourceDetails(sourceId: string): Promise<IngestionSourceDetails | null>;
}

export async function analyzeInventoryImpact(
  provider: ImpactInventoryProvider,
  request: ImpactAnalyzeRequest,
): Promise<ImpactAnalysisResult> {
  const inventory = await provider.inventory();
  const maxResults = request.maxResults ?? 25;
  const selectedEntry = selectEntry(inventory, request);
  const selectedDetails = selectedEntry ? await provider.sourceDetails(selectedEntry.sourceId) : null;
  const targetRule = selectedDetails?.businessRules.find((rule) => rule.id === request.ruleId);
  const targetText = [
    request.target,
    request.ruleId,
    selectedEntry?.sourceId,
    selectedEntry?.filename,
    selectedEntry?.program,
    targetRule?.description,
    targetRule?.domain,
  ].filter(Boolean).join(" ");
  const targetTerms = terms(targetText);

  const detailPairs = await Promise.all(inventory.files.map(async (entry) => ({
    entry,
    details: await provider.sourceDetails(entry.sourceId),
  })));

  const affectedSources = detailPairs
    .map(({ entry, details }) => scoreSourceImpact(entry, details, selectedEntry, targetTerms))
    .filter((item): item is ImpactAffectedSource => item !== null)
    .sort((a, b) => b.score - a.score || a.filename.localeCompare(b.filename))
    .slice(0, maxResults);

  const affectedRules = detailPairs
    .flatMap(({ entry, details }) => (details?.businessRules ?? []).map((rule) => scoreRuleImpact(entry, rule, selectedEntry?.sourceId, targetRule, targetTerms)))
    .filter((item): item is ImpactAffectedRule => item !== null)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, maxResults);

  const affectedDatasets = [...new Set(affectedSources.map((source) => source.dataset))].sort();
  const affectedPrograms = [...new Set(affectedSources.map((source) => source.program).filter((program): program is string => Boolean(program)))].sort();
  const totalAffected = affectedSources.length + affectedRules.length;

  return {
    target: request.target ?? request.ruleId ?? request.sourceId ?? "workspace",
    targetSource: selectedDetails ?? undefined,
    riskLevel: totalAffected >= 12 ? "high" : totalAffected >= 5 ? "medium" : "low",
    affectedSources,
    affectedRules,
    affectedDatasets,
    affectedPrograms,
    totalAffected,
    evidence: buildEvidence(selectedEntry, targetRule, targetTerms),
  };
}

function selectEntry(inventory: IngestionInventory, request: ImpactAnalyzeRequest): IngestionInventoryEntry | undefined {
  if (request.sourceId) return inventory.files.find((file) => file.sourceId === request.sourceId);
  if (!request.target) return undefined;
  const target = request.target.toLowerCase();
  return inventory.files.find((file) => [
    file.sourceId,
    file.filename,
    file.program,
    file.dataset,
  ].filter(Boolean).some((value) => value!.toLowerCase() === target || value!.toLowerCase().includes(target)));
}

function scoreSourceImpact(
  entry: IngestionInventoryEntry,
  details: IngestionSourceDetails | null,
  selected: IngestionInventoryEntry | undefined,
  targetTerms: Set<string>,
): ImpactAffectedSource | null {
  const evidence: string[] = [];
  let score = 0;
  let relationship: ImpactAffectedSource["relationship"] = "target_match";

  if (selected && entry.sourceId === selected.sourceId) {
    score += 100;
    relationship = "selected_source";
    evidence.push("selected source");
  }
  if (selected?.program && entry.program === selected.program) {
    score += 30;
    relationship = relationship === "selected_source" ? relationship : "same_program";
    evidence.push(`program ${entry.program}`);
  }
  if (selected?.dataset && entry.dataset === selected.dataset) {
    score += 12;
    relationship = relationship === "selected_source" || relationship === "same_program" ? relationship : "same_dataset";
    evidence.push(`dataset ${entry.dataset}`);
  }

  const haystack = [
    entry.sourceId,
    entry.filename,
    entry.program,
    entry.dataset,
    ...(details?.businessRules.map((rule) => `${rule.id} ${rule.domain ?? ""} ${rule.description}`) ?? []),
  ].join(" ");
  const overlap = overlapTerms(targetTerms, terms(haystack));
  if (overlap.length > 0) {
    score += overlap.length * 8;
    relationship = relationship === "selected_source" ? relationship : "rule_overlap";
    evidence.push(`matched ${overlap.slice(0, 5).join(", ")}`);
  }

  if (score <= 0) return null;
  return {
    sourceId: entry.sourceId,
    filename: entry.filename,
    program: entry.program,
    dataset: entry.dataset,
    relationship,
    score,
    evidence,
  };
}

function scoreRuleImpact(
  entry: IngestionInventoryEntry,
  rule: IngestedBusinessRule,
  selectedSourceId: string | undefined,
  targetRule: IngestedBusinessRule | undefined,
  targetTerms: Set<string>,
): ImpactAffectedRule | null {
  const haystackTerms = terms(`${rule.id} ${rule.type} ${rule.domain ?? ""} ${rule.description}`);
  const overlap = overlapTerms(targetTerms, haystackTerms);
  let score = overlap.length * 10;
  const evidence = overlap.length > 0 ? [`matched ${overlap.slice(0, 5).join(", ")}`] : [];

  if (targetRule && rule.id === targetRule.id && entry.sourceId === selectedSourceId) {
    score += 100;
    evidence.unshift("selected rule");
  }
  if (targetRule?.domain && rule.domain === targetRule.domain) {
    score += 8;
    evidence.push(`domain ${rule.domain}`);
  }
  if (score <= 0) return null;
  return {
    ...rule,
    sourceId: entry.sourceId,
    program: entry.program,
    score,
    evidence,
  };
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9-]+/).filter((term) => term.length > 2));
}

function overlapTerms(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((term) => b.has(term)).sort();
}

function buildEvidence(selected: IngestionInventoryEntry | undefined, rule: IngestedBusinessRule | undefined, targetTerms: Set<string>): string[] {
  return [
    selected ? `source ${selected.sourceId}` : undefined,
    selected?.program ? `program ${selected.program}` : undefined,
    rule ? `rule ${rule.id}` : undefined,
    targetTerms.size > 0 ? `terms ${[...targetTerms].slice(0, 8).join(", ")}` : undefined,
  ].filter((item): item is string => Boolean(item));
}
