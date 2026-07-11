import type { MainframeLanguage } from "../parser";

export interface SourceArtifact {
  sourceId: string;
  filename: string;
  code: string;
  language?: MainframeLanguage;
  dataset?: string;
  version?: string;
  encoding?: string;
  metadata?: Record<string, string>;
  copybooks?: Record<string, string>;
}

export interface IngestionRequest { dataset: string; files: SourceArtifact[]; connectorRunId?: string; }
export interface IngestionFileResult { sourceId: string; filename: string; status: "indexed" | "skipped" | "failed"; checksum: string; program?: string; rulesExtracted?: number; error?: string; }
export interface IngestionResponse { dataset: string; connectorRunId?: string; indexed: number; skipped: number; failed: number; files: IngestionFileResult[]; }
export interface IngestionProcessor { process(file: SourceArtifact, dataset: string): Promise<{ program: string; rulesExtracted: number }>; }
export interface SourceConnector { readonly name: string; scan(): Promise<SourceArtifact[]>; }
