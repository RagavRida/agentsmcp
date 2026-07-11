// ============================================================
// Copybook Resolver — Recursive COPY/INCLUDE Expansion
// Simulates the COBOL preprocessor by inlining Copybook
// definitions into the parent program before parsing.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';

export interface CopybookLibrary {
  /** Base directories to search for Copybooks */
  searchPaths: string[];
  /** File extensions to try (in order) */
  extensions: string[];
}

const DEFAULT_LIBRARY: CopybookLibrary = {
  searchPaths: ['.'],
  extensions: ['.cpy', '.cbl', '.cob', '.CPY', '.CBL', '.COB', ''],
};

/**
 * Resolves all COPY statements in COBOL source by inlining
 * the referenced Copybook files. Works recursively (Copybooks
 * can include other Copybooks).
 *
 * This is a deterministic preprocessor — no LLM involved.
 */
export class CopybookResolver {
  private library: CopybookLibrary;
  private resolved: Map<string, string> = new Map();
  private resolveStack: Set<string> = new Set(); // Circular dependency guard

  constructor(library?: Partial<CopybookLibrary>) {
    this.library = { ...DEFAULT_LIBRARY, ...library };
  }

  /**
   * Resolve all COPY statements in the source.
   * Returns the expanded source with Copybooks inlined.
   */
  resolve(source: string, currentFile?: string): string {
    const lines = source.split('\n');
    const result: string[] = [];

    for (const line of lines) {
      // Check if this line is a COPY statement
      // COBOL COPY format: "      COPY copybook-name." (in area B, columns 12-72)
      const copyMatch = line.match(/COPY\s+([A-Z0-9][\w-]*)\s*\./i);

      if (copyMatch) {
        const copybookName = copyMatch[1].toUpperCase();

        // Guard against circular dependencies
        if (this.resolveStack.has(copybookName)) {
          result.push(`      * CIRCULAR DEPENDENCY DETECTED: ${copybookName}`);
          continue;
        }

        // Try to find and inline the Copybook
        const copybookSource = this.findCopybook(copybookName);

        if (copybookSource !== null) {
          this.resolveStack.add(copybookName);

          // Add markers for traceability
          result.push(`      * >>> BEGIN COPY ${copybookName}`);

          // Recursively resolve any COPY statements inside the Copybook
          const expanded = this.resolve(copybookSource, copybookName);
          result.push(expanded);

          result.push(`      * <<< END COPY ${copybookName}`);

          this.resolveStack.delete(copybookName);
        } else {
          // Copybook not found — leave a marker but don't fail
          result.push(`      * COPYBOOK NOT FOUND: ${copybookName}`);
          result.push(line); // Keep the original COPY statement
        }
      } else {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  /**
   * Search for a Copybook file in the configured library paths.
   * Returns the file contents if found, or null.
   */
  private findCopybook(name: string): string | null {
    // Check the in-memory cache first
    if (this.resolved.has(name)) {
      return this.resolved.get(name)!;
    }

    // Search all configured paths
    for (const searchPath of this.library.searchPaths) {
      for (const ext of this.library.extensions) {
        const candidates = [
          path.join(searchPath, name + ext),
          path.join(searchPath, name.toLowerCase() + ext),
        ];

        for (const filePath of candidates) {
          try {
            if (fs.existsSync(filePath)) {
              const content = fs.readFileSync(filePath, 'utf-8');
              this.resolved.set(name, content);
              return content;
            }
          } catch {
            // File access error — continue searching
          }
        }
      }
    }

    return null;
  }

  /**
   * Register a Copybook directly (for in-memory / testing use).
   * This avoids needing files on disk.
   */
  registerCopybook(name: string, source: string): void {
    this.resolved.set(name.toUpperCase(), source);
  }

  /**
   * Get all Copybook names that were successfully resolved.
   */
  getResolvedCopybooks(): string[] {
    return Array.from(this.resolved.keys());
  }
}
