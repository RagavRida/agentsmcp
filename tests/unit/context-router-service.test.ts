import { afterEach, describe, expect, it } from "vitest";
import {
  declareInterestAndPersist,
  getContextRouter,
  loadContextRouterProfiles,
  resetContextRouter,
  saveContextRouterProfiles,
  scopeSnapshotForReceiver,
  wrapContextForSend,
} from "../../src/context-router-service";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("ContextRouter service", () => {
  let profilesPath = "";

  afterEach(async () => {
    resetContextRouter();
    delete process.env.AGENTSMCP_CONTEXT_ROUTER_PATH;
    if (profilesPath) await rm(profilesPath, { force: true }).catch(() => undefined);
  });

  it("wraps on send and scopes on receive per agent interest", () => {
    const router = getContextRouter();
    router.declareInterest("audit-agent", ["stats", "programName"], 500);

    const full = {
      programName: "LOAN-PROC",
      businessRules: [{ id: "r1", description: "Check limit" }],
      stats: { paragraphs: 4, parseTimeMs: 120 },
      _internalParserState: { cache: "secret" },
    };

    const stored = wrapContextForSend("parser-agent", full);
    expect(stored._contextRouter).toBeDefined();
    expect(stored.programName).toBe("LOAN-PROC");

    const auditView = scopeSnapshotForReceiver("audit-agent", stored);
    expect(auditView._scopedFor).toBe("audit-agent");
    expect(auditView.stats).toBeDefined();
    expect(auditView.programName).toBeDefined();
    expect(auditView._internalParserState).toBeUndefined();

    const profile = router.getInterestProfile("audit-agent");
    expect(profile?.requestedFields.has("stats")).toBe(true);
  });

  it("learns field access from repeated receives", () => {
    const stored = wrapContextForSend("parser-agent", {
      businessRules: [{ id: "r1" }],
      graph: { nodes: [] },
      programName: "PAY-BATCH",
    });

    scopeSnapshotForReceiver("migration-agent", stored);
    scopeSnapshotForReceiver("migration-agent", stored);

    const profile = getContextRouter().getInterestProfile("migration-agent");
    const accessed = profile?.accessedFields.get("programName") ?? 0;
    expect(accessed).toBeGreaterThan(0);
  });

  it("persists interest profiles to disk", async () => {
    profilesPath = join(await mkdtemp(join(tmpdir(), "router-profiles-")), "profiles.json");
    process.env.AGENTSMCP_CONTEXT_ROUTER_PATH = profilesPath;
    resetContextRouter();

    await declareInterestAndPersist("audit-agent", ["stats"], 500);

    resetContextRouter();
    await loadContextRouterProfiles();

    const profile = getContextRouter().getInterestProfile("audit-agent");
    expect(profile?.requestedFields.has("stats")).toBe(true);
    expect(profile?.tokenBudget).toBe(500);

    const raw = await readFile(profilesPath, "utf-8");
    expect(raw).toContain("audit-agent");
  });
});
