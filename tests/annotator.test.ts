import { describe, expect, it } from "vitest";
import { Annotator, type AnnotatorAgent } from "../src/annotator";
import type {
  CodebaseIndexEntry,
  GraphEdge,
  GraphNode,
} from "../src/storage/interface";

/** Build a mock AnnotatorAgent from a static map of index entries + graph data. */
function makeMockAgent(opts: {
  index?: Record<string, CodebaseIndexEntry>;
  graph?: Record<string, { nodes: GraphNode[]; edges: GraphEdge[] }>;
}): AnnotatorAgent {
  return {
    async getIndex(key) {
      return opts.index?.[key] ?? null;
    },
    async queryGraph(query) {
      return opts.graph?.[query] ?? { nodes: [], edges: [] };
    },
  };
}

describe("annotator — analyzeFile", () => {
  it("produces depends/usedBy from graph edges", async () => {
    const agent = makeMockAgent({
      index: {
        "file:src/auth.ts": {
          key: "file:src/auth.ts",
          category: "file",
          summary: "auth module",
          metadata: {},
          updatedAt: 0,
        },
        "sym:loginHandler": {
          key: "sym:loginHandler",
          category: "symbol",
          summary: "handles user login",
          metadata: {},
          updatedAt: 0,
        },
      },
      graph: {
        "sym:loginHandler": {
          nodes: [],
          edges: [
            {
              sourceId: "sym:loginHandler",
              targetId: "file:keys.ts",
              type: "depends_on",
            },
            {
              sourceId: "file:routes.ts",
              targetId: "sym:loginHandler",
              type: "references",
            },
          ],
        },
      },
    });

    const annotator = new Annotator(agent);
    const src = "export function loginHandler() {}";
    const result = await annotator.analyzeFile("src/auth.ts", src);
    expect(result.blockAnnotations).toHaveLength(1);
    expect(result.blockAnnotations[0].annotation.context).toBe("handles user login");
    expect(result.blockAnnotations[0].annotation.depends).toEqual(["file:keys.ts"]);
    expect(result.blockAnnotations[0].annotation.usedBy).toEqual(["file:routes.ts"]);
  });

  it("symbols without graph data get minimal annotation", async () => {
    const agent = makeMockAgent({});
    const annotator = new Annotator(agent);
    const src = "export function foo() {}";
    const result = await annotator.analyzeFile("src/foo.ts", src);
    expect(result.blockAnnotations).toHaveLength(1);
    expect(result.blockAnnotations[0].annotation.context).toBe("Exported symbol foo");
    expect(result.blockAnnotations[0].annotation.depends).toBeUndefined();
    expect(result.blockAnnotations[0].annotation.usedBy).toBeUndefined();
  });

  it("pulls why from connected decision nodes", async () => {
    const agent = makeMockAgent({
      graph: {
        "sym:loginHandler": {
          nodes: [
            {
              id: "decision:jwt",
              type: "decision",
              name: "Use JWT",
              description: "JWT chosen for stateless auth",
              updatedAt: 0,
            },
          ],
          edges: [],
        },
      },
    });
    const annotator = new Annotator(agent);
    const src = "export function loginHandler() {}";
    const result = await annotator.analyzeFile("src/auth.ts", src);
    expect(result.blockAnnotations[0].annotation.why).toBe(
      "JWT chosen for stateless auth"
    );
  });

  it("pulls gotcha/pattern/config from index metadata", async () => {
    const agent = makeMockAgent({
      index: {
        "sym:foo": {
          key: "sym:foo",
          category: "symbol",
          summary: "does foo",
          metadata: {
            pattern: "factory",
            knownIssues: "fails on empty input",
            config: ["DATABASE_URL", "API_KEY"],
          },
          updatedAt: 0,
        },
      },
    });
    const annotator = new Annotator(agent);
    const src = "export function foo() {}";
    const result = await annotator.analyzeFile("src/foo.ts", src);
    const ann = result.blockAnnotations[0].annotation;
    expect(ann.pattern).toBe("factory");
    expect(ann.gotcha).toBe("fails on empty input");
    expect(ann.config).toEqual(["DATABASE_URL", "API_KEY"]);
  });

  it("derives file annotation from index parentKey", async () => {
    const agent = makeMockAgent({
      index: {
        "file:src/auth.ts": {
          key: "file:src/auth.ts",
          category: "file",
          summary: "authentication entry point",
          metadata: { owner: "platform-team" },
          parentKey: "module:auth",
          updatedAt: 0,
        },
      },
    });
    const annotator = new Annotator(agent);
    const result = await annotator.analyzeFile(
      "src/auth.ts",
      "export const x = 1;"
    );
    expect(result.fileAnnotation.module).toBe("auth");
    expect(result.fileAnnotation.context).toBe("authentication entry point");
    expect(result.fileAnnotation.owner).toBe("platform-team");
    expect(result.fileAnnotation.contentHash).toBeDefined();
    expect(result.fileAnnotation.contentHash).toHaveLength(16);
  });
});

describe("annotator — annotateFile / postEditAnnotate", () => {
  it("annotateFile inserts both file and block annotations", async () => {
    const agent = makeMockAgent({});
    const annotator = new Annotator(agent);
    const src = "export function foo() {}";
    const out = await annotator.annotateFile("src/foo.ts", src);
    expect(out).toContain("@file");
    expect(out).toContain("@context");
    expect(out).toContain("export function foo");
  });

  it("postEditAnnotate stamps @changed on every block", async () => {
    const agent = makeMockAgent({});
    const annotator = new Annotator(agent);
    const src = "export function foo() {}\nexport function bar() {}";
    const out = await annotator.postEditAnnotate(
      "src/foo.ts",
      src,
      "added bar param"
    );
    expect(out).toContain("@changed");
    expect(out).toContain("added bar param");
    // Both foo and bar should have @changed
    const matches = out.match(/@changed/g);
    expect(matches?.length).toBe(2);
  });

  it("skips files matching the skip patterns", async () => {
    const agent = makeMockAgent({});
    const annotator = new Annotator(agent);
    const src = "export const x: number = 1;";
    const out = await annotator.annotateFile("src/types.d.ts", src);
    expect(out).toBe(src);
  });

  it("re-annotating an already-annotated file keeps contentHash stable", async () => {
    const agent = makeMockAgent({});
    const annotator = new Annotator(agent);
    const original = "export function foo() {}";
    const once = await annotator.annotateFile("src/foo.ts", original);
    const twice = await annotator.annotateFile("src/foo.ts", once);

    // Extract contentHash from both runs
    const hashOnce = once.match(/@contentHash (\S+)/)?.[1];
    const hashTwice = twice.match(/@contentHash (\S+)/)?.[1];
    expect(hashOnce).toBeDefined();
    expect(hashTwice).toBe(hashOnce);
  });
});
