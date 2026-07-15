import { createHash, randomUUID } from "node:crypto";
import type { IngestionInventoryEntry, IngestionSourceDetails } from "../ingestion/contracts";
import { getProductCapabilityMatrix } from "../product/capabilities";
import { analyzeInventoryImpact, type ImpactAnalysisResult, type ImpactInventoryProvider } from "../impact/analysis";

export interface EvidenceExportRequest {
  sourceId?: string;
  ruleId?: string;
  target?: string;
  tenantId?: string;
  maxResults?: number;
}

export interface EvidenceExportMetadata {
  exportId: string;
  generatedAt: string;
  format: "json";
  version: string;
  request: EvidenceExportRequest;
  contentHash: string;
}

export interface EvidenceBundle {
  metadata: EvidenceExportMetadata;
  source?: IngestionSourceDetails;
  inventoryEntry?: IngestionInventoryEntry;
  impact: ImpactAnalysisResult;
  productCapabilities: ReturnType<typeof getProductCapabilityMatrix>;
  audit: {
    chainOfCustody: string[];
    evidenceTerms: string[];
    limitations: string[];
  };
}

export interface EvidenceAuditRecord {
  exportId: string;
  generatedAt: string;
  tenantId?: string;
  sourceId?: string;
  ruleId?: string;
  target?: string;
  contentHash: string;
}

export interface EvidenceProvider extends ImpactInventoryProvider {
  recordEvidenceExport?(bundle: EvidenceBundle): Promise<void>;
}

export async function createEvidenceBundle(
  provider: EvidenceProvider,
  request: EvidenceExportRequest,
  options: { version?: string; now?: Date } = {},
): Promise<EvidenceBundle> {
  const now = options.now ?? new Date();
  const inventory = await provider.inventory();
  const impact = await analyzeInventoryImpact(provider, request);
  const source = (request.sourceId ? await provider.sourceDetails(request.sourceId) : impact.targetSource) ?? undefined;
  const inventoryEntry = source
    ? inventory.files.find((file) => file.sourceId === source.sourceId)
    : request.target
      ? inventory.files.find((file) => file.sourceId === request.target || file.program === request.target || file.filename === request.target)
      : undefined;

  const draft = {
    source,
    inventoryEntry,
    impact,
    productCapabilities: getProductCapabilityMatrix(now),
    audit: {
      chainOfCustody: [
        "repository inventory manifest",
        "source details document",
        "inventory-backed impact analysis",
        "product capability matrix",
      ],
      evidenceTerms: impact.evidence,
      limitations: [
        "Impact analysis is based on indexed source inventory and extracted rules.",
        "Runtime scheduler, telemetry, and Neo4j dependency-chain enrichment may add affected systems not present in this bundle.",
      ],
    },
  };
  const contentHash = hashEvidenceContent(draft);
  const bundle: EvidenceBundle = {
    metadata: {
      exportId: `ev_${now.getTime().toString(36)}_${randomUUID().slice(0, 8)}`,
      generatedAt: now.toISOString(),
      format: "json",
      version: options.version ?? "unknown",
      request,
      contentHash,
    },
    ...draft,
  };
  await provider.recordEvidenceExport?.(bundle);
  return bundle;
}

export function evidenceAuditRecord(bundle: EvidenceBundle): EvidenceAuditRecord {
  return {
    exportId: bundle.metadata.exportId,
    generatedAt: bundle.metadata.generatedAt,
    sourceId: bundle.metadata.request.sourceId,
    tenantId: bundle.metadata.request.tenantId,
    ruleId: bundle.metadata.request.ruleId,
    target: bundle.metadata.request.target,
    contentHash: bundle.metadata.contentHash,
  };
}

function hashEvidenceContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
