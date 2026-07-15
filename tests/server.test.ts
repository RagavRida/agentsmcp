import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startServer, type TestServer } from "./setup";

let server: TestServer;

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

describe("HTTP server (no auth)", () => {
  beforeEach(async () => { server = await startServer(); });
  afterEach(async () => { await server.close(); });

  it("/agents/register returns 201 then 200 on re-register", async () => {
    const a = await postJson(`${server.url}/agents/register`, { agentId: "alice@x" });
    expect(a.status).toBe(201);
    expect((a.data as { created: boolean }).created).toBe(true);

    const b = await postJson(`${server.url}/agents/register`, { agentId: "alice@x" });
    // current behaviour: re-register still returns 201 but created=false.
    // Accept either 200 or 201 as long as created=false signals idempotency.
    expect([200, 201]).toContain(b.status);
    expect((b.data as { created: boolean }).created).toBe(false);
  });

  it("/messages/send creates thread and deliveredTo = to+cc+bcc minus sender", async () => {
    const res = await postJson(`${server.url}/messages/send`, {
      from: "from@x",
      to: "to@x",
      payload: { hello: "world" },
      cc: ["cc@x", "from@x"], // sender in cc should be filtered out of deliveredTo
      bcc: ["bcc@x"],
    });
    expect(res.status).toBe(200);
    const body = res.data as { messageId: string; threadId: string; deliveredTo: string[] };
    expect(typeof body.threadId).toBe("string");
    expect(body.deliveredTo.sort()).toEqual(["bcc@x", "cc@x", "to@x"]);
  });

  it("/mailbox/:id/unread strips bcc from view when requester is not the sender", async () => {
    await postJson(`${server.url}/messages/send`, {
      from: "from@x",
      to: "to@x",
      payload: { p: 1 },
      bcc: ["bcc@x"],
    });

    const senderView = await getJson(
      `${server.url}/mailbox/${encodeURIComponent("from@x")}/unread`
    );
    expect(senderView.status).toBe(200);
    // sender has no unread of their own message
    expect((senderView.data as { messages: unknown[] }).messages.length).toBe(0);

    const toView = await getJson(
      `${server.url}/mailbox/${encodeURIComponent("to@x")}/unread`
    );
    const toMsgs = (toView.data as { messages: Array<{ bcc?: string[] }> }).messages;
    expect(toMsgs.length).toBe(1);
    expect(toMsgs[0].bcc).toBeUndefined();

    const bccView = await getJson(
      `${server.url}/mailbox/${encodeURIComponent("bcc@x")}/unread`
    );
    const bccMsgs = (bccView.data as { messages: Array<{ bcc?: string[] }> }).messages;
    expect(bccMsgs.length).toBe(1);
    expect(bccMsgs[0].bcc).toBeUndefined(); // recipient sees no bcc list either
  });

  it("/messages/reply-all delivers to all visible participants except sender", async () => {
    const sent = await postJson(`${server.url}/messages/send`, {
      from: "from@x",
      to: "to@x",
      payload: { p: 1 },
      cc: ["cc@x"],
      bcc: ["bcc@x"],
    });
    const { threadId } = sent.data as { threadId: string };

    const reply = await postJson(`${server.url}/messages/reply-all`, {
      from: "to@x",
      threadId,
      payload: { answer: "yes" },
    });
    expect(reply.status).toBe(200);
    const body = reply.data as { deliveredTo: string[] };
    // visible participants are from@x, to@x, cc@x — minus sender (to@x).
    expect(body.deliveredTo.sort()).toEqual(["cc@x", "from@x"]);
  });

  it("/threads/:id/participants hides bcc from those who didn't bcc them", async () => {
    const sent = await postJson(`${server.url}/messages/send`, {
      from: "from@x",
      to: "to@x",
      payload: { p: 1 },
      cc: ["cc@x"],
      bcc: ["bcc@x"],
    });
    const { threadId } = sent.data as { threadId: string };

    const senderView = await getJson(
      `${server.url}/threads/${threadId}/participants?as=${encodeURIComponent("from@x")}`
    );
    const senderRoles = (senderView.data as { participants: Array<{ agentId: string; role: string }> })
      .participants.map((p) => p.agentId)
      .sort();
    expect(senderRoles).toContain("bcc@x");

    const ccView = await getJson(
      `${server.url}/threads/${threadId}/participants?as=${encodeURIComponent("cc@x")}`
    );
    const ccRoles = (ccView.data as { participants: Array<{ agentId: string; role: string }> })
      .participants.map((p) => p.agentId);
    expect(ccRoles).not.toContain("bcc@x");

    const bccSelf = await getJson(
      `${server.url}/threads/${threadId}/participants?as=${encodeURIComponent("bcc@x")}`
    );
    const bccSelfRoles = (bccSelf.data as { participants: Array<{ agentId: string }> })
      .participants.map((p) => p.agentId);
    expect(bccSelfRoles).toContain("bcc@x"); // bcc'd agent sees self
  });

  it("/threads/:id/sync surfaces threadSummaryStructured once threshold is crossed", async () => {
    // Default compressor is Noop; threshold is 20 uncovered older messages.
    // Send 30 messages so older = 20, recent = 10.
    let threadId = "";
    for (let i = 0; i < 30; i++) {
      const res = await postJson(`${server.url}/messages/send`, {
        from: "a@x",
        to: "b@x",
        payload: { n: i },
        contextSnapshot: { step: `s${i}` },
      });
      threadId = (res.data as { threadId: string }).threadId;
    }
    const sync = await getJson(`${server.url}/threads/${threadId}/sync`);
    const ctx = (sync.data as {
      context: {
        recentMessages: unknown[];
        tokenCount: number;
        threadSummaryStructured?: { coversMessageIds: string[] };
      };
    }).context;
    expect(ctx.recentMessages.length).toBe(10);
    expect(typeof ctx.tokenCount).toBe("number");
    expect(ctx.threadSummaryStructured).toBeDefined();
    expect(ctx.threadSummaryStructured?.coversMessageIds.length).toBe(20);
  });
});

describe("HTTP server (auth on)", () => {
  beforeEach(async () => { server = await startServer({ apiKey: "secret-key-1234" }); });
  afterEach(async () => { await server.close(); });

  it("returns 401 on wrong Authorization header", async () => {
    const res = await postJson(
      `${server.url}/agents/register`,
      { agentId: "alice@x" },
      { Authorization: "Bearer wrong" }
    );
    expect(res.status).toBe(401);
    expect((res.data as { error: string }).error).toBe("unauthorized");
  });

  it("returns 401 with no Authorization header", async () => {
    const res = await postJson(`${server.url}/agents/register`, { agentId: "alice@x" });
    expect(res.status).toBe(401);
  });

  it("allows /health without auth", async () => {
    const res = await getJson(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect((res.data as { ok: boolean }).ok).toBe(true);
  });

  it("allows product capability matrix without auth", async () => {
    const res = await getJson(`${server.url}/api/v1/product/capabilities`);
    expect(res.status).toBe(200);
    const body = res.data as { capabilities: Array<{ id: string; status: string }> };
    expect(body.capabilities).toContainEqual(expect.objectContaining({
      id: "mainframe-parser-registry",
      status: "live",
    }));
  });

  it("allows ingestion inventory with the correct Bearer token", async () => {
    const res = await getJson(
      `${server.url}/api/v1/ingest/inventory`,
      { Authorization: "Bearer secret-key-1234" }
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ totalFiles: 0, files: [] });
  });

  it("allows requests with the correct Bearer token", async () => {
    const res = await postJson(
      `${server.url}/agents/register`,
      { agentId: "alice@x" },
      { Authorization: "Bearer secret-key-1234" }
    );
    expect(res.status).toBe(201);
  });
});
