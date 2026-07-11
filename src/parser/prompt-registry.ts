/**
 * Prompt Registry — Version control for LLM prompts.
 *
 * Tracks which prompt version produced which eval score,
 * and supports rollback if a mutation degrades performance.
 *
 * Principle: "Avoid over-patching — old defensive rules break
 * on new models; version prompts."
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { dirname } from "path";

export interface PromptVersion {
  /** Semantic version (e.g., "v2.0.0") */
  version: string;
  /** The full system prompt text */
  prompt: string;
  /** ISO timestamp when this version was created */
  createdAt: string;
  /** F1 score from the last eval run using this prompt */
  evalScore?: number;
  /** LLM Fallback eval accuracy (control/edge/refuse) */
  fallbackEvalAccuracy?: number;
  /** Human-readable notes about what changed */
  notes?: string;
}

export interface PromptRegistryData {
  activeVersion: string;
  versions: PromptVersion[];
}

export class PromptRegistry {
  private data: PromptRegistryData;
  private readonly filePath: string;
  private dirty = false;

  private constructor(filePath: string, data: PromptRegistryData) {
    this.filePath = filePath;
    this.data = data;
  }

  /**
   * Load or create a registry from a JSON file.
   */
  static async load(filePath: string): Promise<PromptRegistry> {
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as PromptRegistryData;
      return new PromptRegistry(filePath, data);
    } catch {
      const data: PromptRegistryData = { activeVersion: "", versions: [] };
      return new PromptRegistry(filePath, data);
    }
  }

  /**
   * Create from in-memory data (useful for tests).
   */
  static fromData(data: PromptRegistryData, filePath = ""): PromptRegistry {
    return new PromptRegistry(filePath, { ...data });
  }

  /**
   * Register a new prompt version.
   */
  register(version: string, prompt: string, notes?: string): void {
    // Check for duplicate versions
    const existing = this.data.versions.find((v) => v.version === version);
    if (existing) {
      throw new Error(`Prompt version ${version} already exists. Bump the version number.`);
    }

    this.data.versions.push({
      version,
      prompt,
      createdAt: new Date().toISOString(),
      notes,
    });
    this.data.activeVersion = version;
    this.dirty = true;
  }

  /**
   * Record an eval score for a specific prompt version.
   */
  recordScore(version: string, evalScore: number, fallbackEvalAccuracy?: number): void {
    const entry = this.data.versions.find((v) => v.version === version);
    if (!entry) {
      throw new Error(`Prompt version ${version} not found in registry.`);
    }
    entry.evalScore = evalScore;
    if (fallbackEvalAccuracy != null) {
      entry.fallbackEvalAccuracy = fallbackEvalAccuracy;
    }
    this.dirty = true;
  }

  /**
   * Get the active prompt version.
   */
  getActive(): PromptVersion | undefined {
    return this.data.versions.find((v) => v.version === this.data.activeVersion);
  }

  /**
   * Get a specific version.
   */
  get(version: string): PromptVersion | undefined {
    return this.data.versions.find((v) => v.version === version);
  }

  /**
   * Get the active version string.
   */
  get activeVersion(): string {
    return this.data.activeVersion;
  }

  /**
   * List all versions (newest first).
   */
  listVersions(): PromptVersion[] {
    return [...this.data.versions].reverse();
  }

  /**
   * Rollback to the previous version.
   * Returns the version we rolled back to, or null if there's nothing to rollback to.
   */
  rollback(): PromptVersion | null {
    const idx = this.data.versions.findIndex(
      (v) => v.version === this.data.activeVersion
    );
    if (idx <= 0) return null;

    const previousVersion = this.data.versions[idx - 1];
    this.data.activeVersion = previousVersion.version;
    this.dirty = true;
    return previousVersion;
  }

  /**
   * Find the best-performing version by eval score.
   */
  getBestVersion(): PromptVersion | null {
    const scored = this.data.versions.filter((v) => v.evalScore != null);
    if (scored.length === 0) return null;
    return scored.reduce((best, v) =>
      (v.evalScore ?? 0) > (best.evalScore ?? 0) ? v : best
    );
  }

  /**
   * Auto-increment the version string (v2.0.0 → v2.1.0).
   */
  static bumpMinor(version: string): string {
    const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return `${version}-next`;
    return `v${match[1]}.${parseInt(match[2]) + 1}.${match[3]}`;
  }

  /**
   * Auto-increment the patch version (v2.1.0 → v2.1.1).
   */
  static bumpPatch(version: string): string {
    const match = version.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return `${version}-patch`;
    return `v${match[1]}.${match[2]}.${parseInt(match[3]) + 1}`;
  }

  /**
   * Persist the registry to disk.
   */
  async save(): Promise<void> {
    if (!this.dirty || !this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      JSON.stringify(this.data, null, 2),
      "utf-8"
    );
    this.dirty = false;
  }
}
