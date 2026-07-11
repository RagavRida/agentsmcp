import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";
import type { RaptorNode, RaptorTree } from "./tree-builder";

interface SerializedRaptorTree {
  program: string;
  root: RaptorNode;
  levels: Record<string, RaptorNode[]>;
  totalNodes: number;
  depth: number;
  savedAt: string;
}

export class RaptorTreeStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = resolve(dir ?? ".agentmailbox/raptor-trees");
  }

  async save(program: string, tree: RaptorTree): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const payload: SerializedRaptorTree = {
      program,
      root: tree.root,
      levels: Object.fromEntries(
        [...tree.levels.entries()].map(([level, nodes]) => [String(level), nodes]),
      ),
      totalNodes: tree.totalNodes,
      depth: tree.depth,
      savedAt: new Date().toISOString(),
    };
    const safeName = program.replace(/[^a-zA-Z0-9_-]/g, "_");
    await writeFile(
      join(this.dir, `${safeName}.json`),
      JSON.stringify(payload, null, 2),
      "utf-8",
    );
  }

  async load(program: string): Promise<RaptorTree | null> {
    const safeName = program.replace(/[^a-zA-Z0-9_-]/g, "_");
    try {
      const raw = await readFile(join(this.dir, `${safeName}.json`), "utf-8");
      return deserializeTree(JSON.parse(raw) as SerializedRaptorTree);
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<Map<string, RaptorTree>> {
    const trees = new Map<string, RaptorTree>();
    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await readFile(join(this.dir, file), "utf-8");
        const data = JSON.parse(raw) as SerializedRaptorTree;
        trees.set(data.program, deserializeTree(data));
      }
    } catch {
      // Directory may not exist yet
    }
    return trees;
  }

  async delete(program: string): Promise<void> {
    const safeName = program.replace(/[^a-zA-Z0-9_-]/g, "_");
    await rm(join(this.dir, `${safeName}.json`), { force: true });
  }
}

function deserializeTree(data: SerializedRaptorTree): RaptorTree {
  const levels = new Map<number, RaptorNode[]>();
  for (const [level, nodes] of Object.entries(data.levels)) {
    levels.set(Number(level), nodes);
  }
  return {
    root: data.root,
    levels,
    totalNodes: data.totalNodes,
    depth: data.depth,
  };
}
