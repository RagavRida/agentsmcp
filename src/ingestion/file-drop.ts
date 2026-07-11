import { readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { MainframeLanguage } from "../parser";
import type { SourceArtifact, SourceConnector } from "./contracts";

const LANGUAGE_BY_EXTENSION: Record<string, MainframeLanguage> = { ".cbl": "cobol", ".cob": "cobol", ".cpy": "cobol", ".jcl": "jcl", ".pli": "pli", ".rexx": "rexx", ".rex": "rexx" };
export interface FileDropConnectorOptions { rootDir: string; dataset: string; encoding?: string; includeExtensions?: string[]; }
export class FileDropConnector implements SourceConnector {
  readonly name = "file-drop";
  constructor(private readonly options: FileDropConnectorOptions) { this.options.rootDir = resolve(options.rootDir); }
  async scan(): Promise<SourceArtifact[]> { const paths = await collectFiles(this.options.rootDir); const allowed = new Set((this.options.includeExtensions ?? Object.keys(LANGUAGE_BY_EXTENSION)).map(normalizeExtension)); const artifacts: SourceArtifact[] = []; for (const path of paths) { const extension = normalizeExtension(extname(path)); if (!allowed.has(extension)) continue; const relativePath = relative(this.options.rootDir, path).replace(/\\/g, "/"); artifacts.push({ sourceId: `${this.options.dataset}/${relativePath}`, filename: relativePath, code: await readFile(path, "utf8"), language: LANGUAGE_BY_EXTENSION[extension] ?? "auto", dataset: this.options.dataset, encoding: this.options.encoding ?? "utf-8" }); } return artifacts; }
}
async function collectFiles(directory: string): Promise<string[]> { const entries = await readdir(directory, { withFileTypes: true }); const files: string[] = []; for (const entry of entries) { const path = resolve(directory, entry.name); if (entry.isDirectory()) files.push(...await collectFiles(path)); else if (entry.isFile()) files.push(path); } return files; }
function normalizeExtension(extension: string): string { const lower = extension.toLowerCase(); return lower.startsWith(".") ? lower : `.${lower}`; }
