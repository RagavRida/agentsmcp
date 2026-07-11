import { createHash } from "node:crypto";
import type { Memory } from "../memory/api";
import type { StorageAdapter } from "../storage/interfaces";
import type { IngestionProcessor, IngestionRequest, IngestionResponse, SourceArtifact, IngestionFileResult } from "./contracts";

interface IngestionManifest { sourceId: string; checksum: string; version?: string; indexedAt: string; program?: string; }
export interface IngestionServiceOptions { processor: IngestionProcessor; manifestStorage: StorageAdapter; manifestPrefix?: string; }

export class IngestionService {
  private readonly processor: IngestionProcessor;
  private readonly storage: StorageAdapter;
  private readonly prefix: string;
  constructor(options: IngestionServiceOptions) { this.processor = options.processor; this.storage = options.manifestStorage; this.prefix = options.manifestPrefix ?? "ingestion/manifests"; }

  async ingest(request: IngestionRequest): Promise<IngestionResponse> {
    const files: IngestionFileResult[] = [];
    for (const file of request.files) {
      const checksum = checksumFor(file);
      const previous = await this.readManifest(file.sourceId);
      if (previous?.checksum === checksum) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "skipped", checksum, program: previous.program }); continue; }
      try {
        const result = await this.processor.process(file, request.dataset);
        await this.writeManifest(file, checksum, result.program);
        files.push({ sourceId: file.sourceId, filename: file.filename, status: "indexed", checksum, ...result });
      } catch (error) { files.push({ sourceId: file.sourceId, filename: file.filename, status: "failed", checksum, error: String(error) }); }
    }
    return { dataset: request.dataset, connectorRunId: request.connectorRunId, indexed: files.filter((file) => file.status === "indexed").length, skipped: files.filter((file) => file.status === "skipped").length, failed: files.filter((file) => file.status === "failed").length, files };
  }

  private manifestKey(sourceId: string): string { return `${this.prefix}/${createHash("sha256").update(sourceId).digest("hex")}.json`; }
  private async readManifest(sourceId: string): Promise<IngestionManifest | null> { const raw = await this.storage.read(this.manifestKey(sourceId)); if (!raw) return null; try { return JSON.parse(raw.toString("utf8")) as IngestionManifest; } catch { return null; } }
  private async writeManifest(file: SourceArtifact, checksum: string, program: string): Promise<void> { await this.storage.write(this.manifestKey(file.sourceId), JSON.stringify({ sourceId: file.sourceId, checksum, version: file.version, indexedAt: new Date().toISOString(), program } satisfies IngestionManifest, null, 2)); }
}

export function checksumFor(file: SourceArtifact): string { return createHash("sha256").update(file.code, "utf8").update(JSON.stringify(file.copybooks ?? {})).digest("hex"); }
export function createMemoryIngestionProcessor(memory: Pick<Memory, "remember">): IngestionProcessor { return { async process(file, dataset) { const result = await memory.remember(file.code, { dataset, filename: file.filename, language: file.language }); if (result.status !== "completed") throw new Error(result.error ?? `Failed to index ${file.sourceId}`); return { program: result.program, rulesExtracted: result.rulesExtracted }; } }; }
