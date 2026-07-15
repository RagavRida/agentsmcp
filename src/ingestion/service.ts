import { createHash } from "node:crypto";
import type { Memory } from "../memory/api";
import type { StorageAdapter } from "../storage/interfaces";
import type { IngestionInventory, IngestionInventoryEntry, IngestionProcessor, IngestionRequest, IngestionResponse, SourceArtifact, IngestionFileResult, IngestionSourceDetails, TenantScope } from "./contracts";
import { evidenceAuditRecord, type EvidenceAuditRecord, type EvidenceBundle } from "../evidence/export";

interface IngestionManifest { sourceId: string; checksum: string; version?: string; indexedAt: string; program?: string; }
export interface IngestionServiceOptions { processor: IngestionProcessor; manifestStorage: StorageAdapter; manifestPrefix?: string; inventoryKey?: string; detailsPrefix?: string; evidencePrefix?: string; evidenceAuditKey?: string; }

export class IngestionService {
  private readonly processor: IngestionProcessor;
  private readonly storage: StorageAdapter;
  private readonly prefix: string;
  private readonly inventoryKey: string;
  private readonly detailsPrefix: string;
  private readonly evidencePrefix: string;
  private readonly evidenceAuditKey: string;
  constructor(options: IngestionServiceOptions) { this.processor = options.processor; this.storage = options.manifestStorage; this.prefix = options.manifestPrefix ?? "ingestion/manifests"; this.inventoryKey = options.inventoryKey ?? "ingestion/inventory.json"; this.detailsPrefix = options.detailsPrefix ?? "ingestion/details"; this.evidencePrefix = options.evidencePrefix ?? "ingestion/evidence"; this.evidenceAuditKey = options.evidenceAuditKey ?? "ingestion/evidence/audit.json"; }

  async ingest(request: IngestionRequest): Promise<IngestionResponse> {
    const files: IngestionFileResult[] = [];
    const tenantId = tenantForRequest(request);
    for (const file of request.files) {
      const checksum = checksumFor(file);
      const previous = await this.readManifest(file.sourceId, tenantId);
      if (previous?.checksum === checksum) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "skipped", checksum, tenantId, program: previous.program }); continue; }
      try {
        const result = await this.processor.process(file, request.dataset);
        await this.writeManifest(file, checksum, result.program, tenantId);
        await this.writeDetails(request, file, checksum, result, tenantId);
        files.push({ sourceId: file.sourceId, filename: file.filename, status: "indexed", checksum, tenantId, program: result.program, rulesExtracted: result.rulesExtracted });
      } catch (error) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "failed", checksum, tenantId, error: String(error) }); }
    }
    const response = { dataset: request.dataset, connectorRunId: request.connectorRunId, indexed: files.filter((file) => file.status === "indexed").length, skipped: files.filter((file) => file.status === "skipped").length, failed: files.filter((file) => file.status === "failed").length, files };
    await this.updateInventory(request, files);
    return response;
  }

  async inventory(scope: TenantScope = {}): Promise<IngestionInventory> {
    const inventory = await this.readInventory();
    return scope.tenantId ? summarizeInventory(inventory.files.filter((file) => file.tenantId === scope.tenantId)) : inventory;
  }

  async sourceDetails(sourceId: string, scope: TenantScope = {}): Promise<IngestionSourceDetails | null> {
    const raw = await this.storage.read(this.detailsKey(sourceId, scope.tenantId));
    if (!raw) return null;
    try {
      const details = JSON.parse(raw.toString("utf8")) as IngestionSourceDetails;
      if (scope.tenantId && details.tenantId !== scope.tenantId) return null;
      return details;
    } catch { return null; }
  }

  async recordEvidenceExport(bundle: EvidenceBundle): Promise<void> {
    await this.storage.write(`${this.evidencePrefix}/${bundle.metadata.exportId}.json`, JSON.stringify(bundle, null, 2));
    const raw = await this.storage.read(this.evidenceAuditKey);
    const current = raw ? safeParseAudit(raw) : [];
    const next = [evidenceAuditRecord(bundle), ...current.filter((record) => record.exportId !== bundle.metadata.exportId)].slice(0, 500);
    await this.storage.write(this.evidenceAuditKey, JSON.stringify(next, null, 2));
  }

  private manifestKey(sourceId: string, tenantId?: string): string { return `${this.prefix}/${createHash("sha256").update(storageIdentity(sourceId, tenantId)).digest("hex")}.json`; }
  private detailsKey(sourceId: string, tenantId?: string): string { return `${this.detailsPrefix}/${createHash("sha256").update(storageIdentity(sourceId, tenantId)).digest("hex")}.json`; }
  private async readManifest(sourceId: string, tenantId?: string): Promise<IngestionManifest | null> { const raw = await this.storage.read(this.manifestKey(sourceId, tenantId)); if (!raw) return null; try { return JSON.parse(raw.toString("utf8")) as IngestionManifest; } catch { return null; } }
  private async writeManifest(file: SourceArtifact, checksum: string, program: string, tenantId?: string): Promise<void> { await this.storage.write(this.manifestKey(file.sourceId, tenantId), JSON.stringify({ sourceId: file.sourceId, checksum, version: file.version, indexedAt: new Date().toISOString(), program } satisfies IngestionManifest, null, 2)); }
  private async writeDetails(request: IngestionRequest, file: SourceArtifact, checksum: string, result: Awaited<ReturnType<IngestionProcessor["process"]>>, tenantId?: string): Promise<void> {
    const details: IngestionSourceDetails = {
      sourceId: file.sourceId,
      filename: file.filename,
      status: "indexed",
      checksum,
      tenantId,
      dataset: request.dataset,
      connectorRunId: request.connectorRunId,
      language: file.language,
      version: file.version,
      lastSeenAt: new Date().toISOString(),
      program: result.program,
      rulesExtracted: result.rulesExtracted,
      businessRules: result.businessRules ?? [],
    };
    await this.storage.write(this.detailsKey(file.sourceId, tenantId), JSON.stringify(details, null, 2));
  }
  private async readInventory(): Promise<IngestionInventory> { const raw = await this.storage.read(this.inventoryKey); if (!raw) return emptyInventory(); try { return normalizeInventory(JSON.parse(raw.toString("utf8"))); } catch { return emptyInventory(); } }
  private async updateInventory(request: IngestionRequest, files: IngestionFileResult[]): Promise<void> {
    const inventory = await this.readInventory();
    const bySource = new Map(inventory.files.map((file) => [inventoryKeyFor(file.sourceId, file.tenantId), file]));
    const now = new Date().toISOString();
    const tenantId = tenantForRequest(request);
    for (const result of files) {
      const source = request.files.find((file) => file.sourceId === result.sourceId);
      const key = inventoryKeyFor(result.sourceId, tenantId);
      bySource.set(key, {
        ...bySource.get(key),
        ...result,
        tenantId,
        dataset: request.dataset,
        connectorRunId: request.connectorRunId,
        language: source?.language,
        version: source?.version,
        lastSeenAt: now,
      });
    }
    await this.storage.write(this.inventoryKey, JSON.stringify(summarizeInventory([...bySource.values()]), null, 2));
  }
}

export function checksumFor(file: SourceArtifact): string { return createHash("sha256").update(file.code, "utf8").update(JSON.stringify(file.copybooks ?? {})).digest("hex"); }
export function createMemoryIngestionProcessor(memory: Pick<Memory, "remember">): IngestionProcessor { return { async process(file, dataset) { const result = await memory.remember(file.code, { dataset, filename: file.filename, language: file.language }); if (result.status !== "completed") throw new Error(result.error ?? `Failed to index ${file.sourceId}`); return { program: result.program, rulesExtracted: result.rulesExtracted, businessRules: result.businessRules ?? [] }; } }; }

function emptyInventory(): IngestionInventory { return summarizeInventory([]); }
function normalizeInventory(value: unknown): IngestionInventory {
  if (!value || typeof value !== "object" || !Array.isArray((value as IngestionInventory).files)) return emptyInventory();
  return summarizeInventory((value as IngestionInventory).files);
}
function summarizeInventory(files: IngestionInventoryEntry[]): IngestionInventory {
  const sorted = [...files].sort((a, b) => a.dataset.localeCompare(b.dataset) || a.filename.localeCompare(b.filename));
  return {
    datasets: [...new Set(sorted.map((file) => file.dataset))].sort(),
    totalFiles: sorted.length,
    indexed: sorted.filter((file) => file.status === "indexed").length,
    skipped: sorted.filter((file) => file.status === "skipped").length,
    failed: sorted.filter((file) => file.status === "failed").length,
    files: sorted,
  };
}

function tenantForRequest(request: IngestionRequest): string | undefined {
  return request.tenantId ?? request.files.find((file) => file.tenantId)?.tenantId;
}

function storageIdentity(sourceId: string, tenantId?: string): string {
  return tenantId ? `${tenantId}\0${sourceId}` : sourceId;
}

function inventoryKeyFor(sourceId: string, tenantId?: string): string {
  return storageIdentity(sourceId, tenantId);
}

function safeParseAudit(raw: Buffer): EvidenceAuditRecord[] {
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return Array.isArray(parsed) ? parsed as EvidenceAuditRecord[] : [];
  } catch {
    return [];
  }
}
