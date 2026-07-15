import { createHash } from "node:crypto";
import type { Memory } from "../memory/api";
import type { StorageAdapter } from "../storage/interfaces";
import type { IngestionInventory, IngestionInventoryEntry, IngestionProcessor, IngestionRequest, IngestionResponse, SourceArtifact, IngestionFileResult, IngestionSourceDetails } from "./contracts";

interface IngestionManifest { sourceId: string; checksum: string; version?: string; indexedAt: string; program?: string; }
export interface IngestionServiceOptions { processor: IngestionProcessor; manifestStorage: StorageAdapter; manifestPrefix?: string; inventoryKey?: string; detailsPrefix?: string; }

export class IngestionService {
  private readonly processor: IngestionProcessor;
  private readonly storage: StorageAdapter;
  private readonly prefix: string;
  private readonly inventoryKey: string;
  private readonly detailsPrefix: string;
  constructor(options: IngestionServiceOptions) { this.processor = options.processor; this.storage = options.manifestStorage; this.prefix = options.manifestPrefix ?? "ingestion/manifests"; this.inventoryKey = options.inventoryKey ?? "ingestion/inventory.json"; this.detailsPrefix = options.detailsPrefix ?? "ingestion/details"; }

  async ingest(request: IngestionRequest): Promise<IngestionResponse> {
    const files: IngestionFileResult[] = [];
    for (const file of request.files) {
      const checksum = checksumFor(file);
      const previous = await this.readManifest(file.sourceId);
      if (previous?.checksum === checksum) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "skipped", checksum, program: previous.program }); continue; }
      try {
        const result = await this.processor.process(file, request.dataset);
        await this.writeManifest(file, checksum, result.program);
        await this.writeDetails(request, file, checksum, result);
        files.push({ sourceId: file.sourceId, filename: file.filename, status: "indexed", checksum, program: result.program, rulesExtracted: result.rulesExtracted });
      } catch (error) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "failed", checksum, error: String(error) }); }
    }
    const response = { dataset: request.dataset, connectorRunId: request.connectorRunId, indexed: files.filter((file) => file.status === "indexed").length, skipped: files.filter((file) => file.status === "skipped").length, failed: files.filter((file) => file.status === "failed").length, files };
    await this.updateInventory(request, files);
    return response;
  }

  async inventory(): Promise<IngestionInventory> {
    return this.readInventory();
  }

  async sourceDetails(sourceId: string): Promise<IngestionSourceDetails | null> {
    const raw = await this.storage.read(this.detailsKey(sourceId));
    if (!raw) return null;
    try { return JSON.parse(raw.toString("utf8")) as IngestionSourceDetails; } catch { return null; }
  }

  private manifestKey(sourceId: string): string { return `${this.prefix}/${createHash("sha256").update(sourceId).digest("hex")}.json`; }
  private detailsKey(sourceId: string): string { return `${this.detailsPrefix}/${createHash("sha256").update(sourceId).digest("hex")}.json`; }
  private async readManifest(sourceId: string): Promise<IngestionManifest | null> { const raw = await this.storage.read(this.manifestKey(sourceId)); if (!raw) return null; try { return JSON.parse(raw.toString("utf8")) as IngestionManifest; } catch { return null; } }
  private async writeManifest(file: SourceArtifact, checksum: string, program: string): Promise<void> { await this.storage.write(this.manifestKey(file.sourceId), JSON.stringify({ sourceId: file.sourceId, checksum, version: file.version, indexedAt: new Date().toISOString(), program } satisfies IngestionManifest, null, 2)); }
  private async writeDetails(request: IngestionRequest, file: SourceArtifact, checksum: string, result: Awaited<ReturnType<IngestionProcessor["process"]>>): Promise<void> {
    const details: IngestionSourceDetails = {
      sourceId: file.sourceId,
      filename: file.filename,
      status: "indexed",
      checksum,
      dataset: request.dataset,
      connectorRunId: request.connectorRunId,
      language: file.language,
      version: file.version,
      lastSeenAt: new Date().toISOString(),
      program: result.program,
      rulesExtracted: result.rulesExtracted,
      businessRules: result.businessRules ?? [],
    };
    await this.storage.write(this.detailsKey(file.sourceId), JSON.stringify(details, null, 2));
  }
  private async readInventory(): Promise<IngestionInventory> { const raw = await this.storage.read(this.inventoryKey); if (!raw) return emptyInventory(); try { return normalizeInventory(JSON.parse(raw.toString("utf8"))); } catch { return emptyInventory(); } }
  private async updateInventory(request: IngestionRequest, files: IngestionFileResult[]): Promise<void> {
    const inventory = await this.readInventory();
    const bySource = new Map(inventory.files.map((file) => [file.sourceId, file]));
    const now = new Date().toISOString();
    for (const result of files) {
      const source = request.files.find((file) => file.sourceId === result.sourceId);
      bySource.set(result.sourceId, {
        ...bySource.get(result.sourceId),
        ...result,
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
