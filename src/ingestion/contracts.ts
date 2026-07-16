import type { MainframeLanguage } from "../parser";

export interface SourceArtifact {
  sourceId: string;
  filename: string;
  code: string;
  tenantId?: string;
  language?: MainframeLanguage;
  dataset?: string;
  version?: string;
  encoding?: string;
  metadata?: Record<string, string>;
  copybooks?: Record<string, string>;
}

export interface TenantScope { tenantId?: string; }
export interface IngestionRequest extends TenantScope { dataset: string; files: SourceArtifact[]; connectorRunId?: string; connector?: string; }
export interface IngestedBusinessRule { id: string; type: string; domain?: string; description: string; }
export interface IngestionFileResult { sourceId: string; filename: string; status: "indexed" | "skipped" | "failed"; checksum: string; tenantId?: string; program?: string; rulesExtracted?: number; error?: string; }
export interface IngestionResponse { dataset: string; connectorRunId?: string; indexed: number; skipped: number; failed: number; files: IngestionFileResult[]; }
export interface IngestionInventoryEntry extends IngestionFileResult { dataset: string; connectorRunId?: string; language?: MainframeLanguage; version?: string; lastSeenAt: string; }
export interface IngestionInventory { datasets: string[]; totalFiles: number; indexed: number; skipped: number; failed: number; files: IngestionInventoryEntry[]; }
export interface IngestionSourceDetails extends IngestionInventoryEntry { businessRules: IngestedBusinessRule[]; }
export interface ConnectorRunRecord extends TenantScope { connectorRunId: string; connector: string; dataset: string; status: "completed" | "completed_with_errors" | "failed"; startedAt: string; completedAt: string; totalFiles: number; indexed: number; skipped: number; failed: number; error?: string; }
export interface IngestionProcessor { process(file: SourceArtifact, dataset: string): Promise<{ program: string; rulesExtracted: number; businessRules?: IngestedBusinessRule[] }>; }
export interface SourceConnector { readonly name: string; scan(): Promise<SourceArtifact[]>; }
