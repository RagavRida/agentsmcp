import { describe, expect, it } from "vitest";
import {
  applyAnnotations,
  formatAnnotation,
  parseAnnotations,
  shouldSkipFile,
} from "../src/annotations";

describe("annotations — parseAnnotations", () => {
  it("extracts @context, @why, @depends from a JSDoc block above an export", () => {
    const src = [
      "/**",
      " * @context handles user login",
      " * @why JWT chosen for stateless auth",
      " * @depends file:auth/keys.ts, sym:getPublicKey",
      " */",
      "export function loginHandler() {}",
      "",
    ].join("\n");

    const { blockAnnotations } = parseAnnotations(src);
    expect(blockAnnotations).toHaveLength(1);
    expect(blockAnnotations[0].symbolName).toBe("loginHandler");
    expect(blockAnnotations[0].annotation.context).toBe("handles user login");
    expect(blockAnnotations[0].annotation.why).toBe("JWT chosen for stateless auth");
    expect(blockAnnotations[0].annotation.depends).toEqual([
      "file:auth/keys.ts",
      "sym:getPublicKey",
    ]);
  });

  it("skips JSDoc blocks that have no @context tag", () => {
    const src = [
      "/**",
      " * Just a regular comment.",
      " * @param x the input",
      " */",
      "export function foo(x: number) { return x; }",
    ].join("\n");
    const { blockAnnotations } = parseAnnotations(src);
    expect(blockAnnotations).toHaveLength(0);
  });

  it("extracts a file-level annotation when @file marker is present", () => {
    const src = [
      "/**",
      " * @file",
      " * @module auth",
      " * @context handles authentication",
      " */",
      "export const x = 1;",
    ].join("\n");
    const { fileAnnotation } = parseAnnotations(src);
    expect(fileAnnotation).toBeDefined();
    expect(fileAnnotation?.module).toBe("auth");
    expect(fileAnnotation?.context).toBe("handles authentication");
  });

  it("does not treat the file annotation as a block annotation", () => {
    const src = [
      "/**",
      " * @file",
      " * @context module-level",
      " */",
      "export const x = 1;",
    ].join("\n");
    const { blockAnnotations } = parseAnnotations(src);
    // x has no preceding non-file JSDoc, so no block annotation
    expect(blockAnnotations).toHaveLength(0);
  });
});

describe("annotations — formatAnnotation", () => {
  it("produces valid JSDoc with all tags", () => {
    const out = formatAnnotation({
      context: "test",
      why: "because",
      depends: ["a", "b"],
      gotcha: "watch out",
    });
    expect(out.startsWith("/**")).toBe(true);
    expect(out.endsWith("*/")).toBe(true);
    expect(out).toContain("@context test");
    expect(out).toContain("@why because");
    expect(out).toContain("@depends a, b");
    expect(out).toContain("@gotcha watch out");
  });

  it("skips empty/undefined tags", () => {
    const out = formatAnnotation({ context: "test" });
    expect(out).not.toContain("@why");
    expect(out).not.toContain("@depends");
    expect(out).not.toContain("@gotcha");
  });

  it("skips empty arrays", () => {
    const out = formatAnnotation({
      context: "test",
      depends: [],
      usedBy: [],
    });
    expect(out).not.toContain("@depends");
    expect(out).not.toContain("@usedBy");
  });

  it("emits @file marker for file annotations", () => {
    const out = formatAnnotation(
      { module: "auth", context: "test" },
      { isFile: true }
    );
    expect(out).toContain("@file");
    expect(out).toContain("@module auth");
  });
});

describe("annotations — applyAnnotations", () => {
  it("inserts a JSDoc above a function that has none", () => {
    const src = "export function foo() { return 1; }";
    const out = applyAnnotations(src, [
      { symbolName: "foo", annotation: { context: "returns one" } },
    ]);
    expect(out).toContain("@context returns one");
    expect(out.indexOf("@context")).toBeLessThan(out.indexOf("export function foo"));
  });

  it("updates an existing JSDoc without duplicating", () => {
    const src = [
      "/**",
      " * @context old description",
      " */",
      "export function foo() {}",
    ].join("\n");
    const out = applyAnnotations(src, [
      { symbolName: "foo", annotation: { context: "new description" } },
    ]);
    expect(out).toContain("@context new description");
    expect(out).not.toContain("@context old description");
    // exactly one JSDoc block
    const matches = out.match(/\/\*\*/g);
    expect(matches?.length).toBe(1);
  });

  it("preserves indentation on inserted JSDoc", () => {
    const src = "  export function foo() {}";
    const out = applyAnnotations(src, [
      { symbolName: "foo", annotation: { context: "indented" } },
    ]);
    const lines = out.split("\n");
    const jsdocLine = lines.find((l) => l.includes("@context"));
    expect(jsdocLine).toBeDefined();
    expect(jsdocLine!.startsWith("  ")).toBe(true);
  });

  it("leaves unrelated exports alone", () => {
    const src = [
      "export function foo() {}",
      "export function bar() {}",
    ].join("\n");
    const out = applyAnnotations(src, [
      { symbolName: "foo", annotation: { context: "foo only" } },
    ]);
    expect(out).toContain("@context foo only");
    // bar should not get a JSDoc
    const beforeBar = out.substring(0, out.indexOf("export function bar"));
    expect(beforeBar.match(/@context/g)?.length ?? 0).toBe(1);
  });

  it("inserts a file annotation at top of file", () => {
    const src = "export function foo() {}";
    const out = applyAnnotations(src, [], {
      module: "auth",
      context: "authentication module",
    });
    expect(out.indexOf("@file")).toBeLessThan(out.indexOf("export"));
    expect(out).toContain("@module auth");
    expect(out).toContain("@context authentication module");
  });

  it("replaces an existing file annotation", () => {
    const src = [
      "/**",
      " * @file",
      " * @module old",
      " * @context old description",
      " */",
      "",
      "export function foo() {}",
    ].join("\n");
    const out = applyAnnotations(src, [], {
      module: "new",
      context: "new description",
    });
    expect(out).toContain("@module new");
    expect(out).not.toContain("@module old");
    expect(out).toContain("@context new description");
    expect(out).not.toContain("@context old description");
  });
});

describe("annotations — round-trip stability", () => {
  it("format → parse → format produces identical output for code annotations", () => {
    const original = {
      context: "test the round trip",
      why: "ensures contentHash stability",
      depends: ["file:a.ts", "sym:b"],
      gotcha: "edge case here",
    };
    const firstFormat = formatAnnotation(original);
    const src = firstFormat + "\nexport function foo() {}";
    const { blockAnnotations } = parseAnnotations(src);
    expect(blockAnnotations).toHaveLength(1);
    const secondFormat = formatAnnotation(blockAnnotations[0].annotation);
    expect(secondFormat).toBe(firstFormat);
  });

  it("applyAnnotations is idempotent — second apply changes nothing", () => {
    const src = "export function foo() {}";
    const ann = { symbolName: "foo", annotation: { context: "stable" } };
    const once = applyAnnotations(src, [ann]);
    const twice = applyAnnotations(once, [ann]);
    expect(twice).toBe(once);
  });
});

describe("annotations — shouldSkipFile", () => {
  it("skips .d.ts files by default", () => {
    expect(shouldSkipFile("src/types.d.ts")).toBe(true);
  });

  it("skips node_modules", () => {
    expect(shouldSkipFile("node_modules/foo/index.ts")).toBe(true);
  });

  it("skips dist", () => {
    expect(shouldSkipFile("dist/server.js")).toBe(true);
  });

  it("allows regular source files", () => {
    expect(shouldSkipFile("src/server.ts")).toBe(false);
  });

  it("respects custom skipPatterns", () => {
    expect(
      shouldSkipFile("custom/file.ts", { skipPatterns: [/^custom\//] })
    ).toBe(true);
    expect(shouldSkipFile("src/file.ts", { skipPatterns: [/^custom\//] })).toBe(
      false
    );
  });
});
