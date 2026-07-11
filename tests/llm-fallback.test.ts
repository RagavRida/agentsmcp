import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anonymizeFragment,
  LLMFallbackExtractor,
  type UnrecognizedFragment,
} from "../src/parser/llm-fallback";
import { CacheManager } from "../src/cache/manager";
import { LocalStorageAdapter } from "../src/storage/interfaces";
import {
  ATTR,
  clearTraces,
  disableTracing,
  enableTracing,
  getLastTrace,
} from "../src/observability";

const FRAGMENT: UnrecognizedFragment = {
  source: "IF WS-AMOUNT GREATER THAN WS-LIMIT MOVE 'Y' TO WS-REVIEW-FLAG.",
  startLine: 10,
  endLine: 12,
  context: {
    programId: "FRAUD-DETECT",
    paragraphName: "1000-CHECK-AMOUNT",
    nearbyVariables: ["WS-AMOUNT", "WS-LIMIT", "WS-REVIEW-FLAG"],
  },
};

function mockFetchRule(confidence = 0.92) {
  return vi.fn(async () => new Response(JSON.stringify({
    text: JSON.stringify({
      rules: [
        {
          description: "Flag accounts where VAR-002 exceeds VAR-003.",
          type: "IF",
          inputs: ["VAR-002", "VAR-003"],
          outputs: ["VAR-001"],
          confidence,
        },
      ],
    }),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("LLMFallbackExtractor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmailbox-llm-cache-"));
    clearTraces();
    disableTracing();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearTraces();
    disableTracing();
    rmSync(dir, { recursive: true, force: true });
  });

  it("anonymizes variables deterministically", () => {
    const { anonymized, mapping } = anonymizeFragment(
      "ADD WS-BALANCE TO WS-TOTAL. DISPLAY WS-BALANCE.",
      ["WS-BALANCE", "WS-TOTAL"],
    );

    expect(anonymized).toBe("ADD VAR-001 TO VAR-002. DISPLAY VAR-001.");
    expect(mapping.get("VAR-001")).toBe("WS-BALANCE");
    expect(mapping.get("VAR-002")).toBe("WS-TOTAL");
  });

  it("persists accepted fallback results and reuses them across extractor instances", async () => {
    const fetchMock = mockFetchRule();
    vi.stubGlobal("fetch", fetchMock);

    const first = new LLMFallbackExtractor({
      vllmUrl: "http://localhost:8000",
      cacheDir: dir,
    });
    const firstRules = await first.extractFromFragments([FRAGMENT]);

    const second = new LLMFallbackExtractor({
      vllmUrl: "http://localhost:8000",
      cacheDir: dir,
    });
    const secondRules = await second.extractFromFragments([FRAGMENT]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstRules).toEqual(secondRules);
    expect(firstRules[0]).toMatchObject({
      description: "Flag accounts where WS-AMOUNT exceeds WS-LIMIT.",
      inputs: ["WS-AMOUNT", "WS-LIMIT"],
      outputs: ["WS-REVIEW-FLAG"],
      grounded: true,
    });
    expect(second.getStats()).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
    expect(readdirSync(join(dir, "llm-fallback")).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  });

  it("caches empty accepted results so low-confidence fragments are not resent", async () => {
    const fetchMock = mockFetchRule(0.2);
    vi.stubGlobal("fetch", fetchMock);

    const first = new LLMFallbackExtractor({
      vllmUrl: "http://localhost:8000",
      cacheDir: dir,
    });
    expect(await first.extractFromFragments([FRAGMENT])).toEqual([]);

    const second = new LLMFallbackExtractor({
      vllmUrl: "http://localhost:8000",
      cacheDir: dir,
    });
    expect(await second.extractFromFragments([FRAGMENT])).toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.getStats()).toMatchObject({ cacheHits: 1, cacheMisses: 0 });
  });

  it("records cache status in tracing spans", async () => {
    const fetchMock = mockFetchRule();
    vi.stubGlobal("fetch", fetchMock);
    enableTracing();

    const extractor = new LLMFallbackExtractor({
      vllmUrl: "http://localhost:8000",
      cacheManager: new CacheManager(new LocalStorageAdapter(dir), {
        namespace: "llm-fallback-test",
      }),
    });
    await extractor.extractFromFragments([FRAGMENT]);

    const trace = getLastTrace();
    expect(trace?.name).toBe("agentsmcp.llm_fallback.extract");
    expect(trace?.attributes[ATTR.PARSE_PROGRAM]).toBe("FRAUD-DETECT");
    expect(trace?.attributes[ATTR.LLM_CACHE_HIT]).toBe(false);
    expect(trace?.attributes[ATTR.LLM_CACHE_KEY]).toMatch(/^[a-f0-9]{64}$/);
  });
});
