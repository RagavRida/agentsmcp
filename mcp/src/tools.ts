import { z, ZodTypeAny } from "zod";
// The recursive JsonValue schema explodes zod-to-json-schema's generic
// inference (TS2589). Erase the type at the call boundary; the returned
// shape is a JSON Schema object which we expose as Record<string, unknown>.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _zodToJsonSchema = require("zod-to-json-schema").zodToJsonSchema as (
  s: unknown,
  opts?: unknown
) => unknown;

const toJsonSchema = (s: ZodTypeAny): Record<string, unknown> =>
  _zodToJsonSchema(s, { target: "openApi3" }) as Record<string, unknown>;
import type { AgentMailbox } from "agentsmcp";

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(JsonValue),
  ])
);

const SendInput = z.object({
  to: z.string().min(1).describe("Recipient agent id"),
  payload: JsonValue.describe("Arbitrary JSON payload"),
  threadId: z.string().optional(),
  contextSnapshot: z.record(JsonValue).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  replyTo: z.string().optional(),
});

const ReceiveInput = z.object({
  from: z.string().optional().describe("Filter to messages from this sender"),
});

const EmptyInput = z.object({}).strict();

const ThreadIdInput = z.object({
  threadId: z.string().min(1),
});

const ReplyAllInput = z.object({
  threadId: z.string().min(1),
  payload: JsonValue,
  contextSnapshot: z.record(JsonValue).optional(),
});

const MarkReadInput = z.object({
  threadId: z.string().min(1),
});

type ToolHandler = (agent: AgentMailbox, args: unknown) => Promise<unknown>;

interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: ToolHandler;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "agentsmcp_send",
    description:
      "Send a message to another agent. Auto-creates a thread if none exists " +
      "between sender and recipient. Use cc for active participants, bcc for " +
      "silent ones. contextSnapshot captures your current state so the " +
      "recipient can pick up cold.",
    schema: SendInput,
    handler: async (agent, raw) => {
      const args = SendInput.parse(raw);
      return agent.send(args.to, args.payload, {
        threadId: args.threadId,
        contextSnapshot: args.contextSnapshot,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
      });
    },
  },
  {
    name: "agentsmcp_receive",
    description:
      "Get unread messages addressed to this agent, with full thread context " +
      "attached to each. Use this at the start of a turn to pick up cold.",
    schema: ReceiveInput,
    handler: async (agent, raw) => {
      const args = ReceiveInput.parse(raw);
      return agent.receive(args.from);
    },
  },
  {
    name: "agentsmcp_unread",
    description: "List unread context frames without consuming them.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.unread();
    },
  },
  {
    name: "agentsmcp_sync",
    description:
      "Rejoin a thread with full assembled context (snapshot + recent 10 " +
      "messages verbatim + summary of older ones). Use after a restart or " +
      "when picking up a stale thread.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      const { context } = await agent.sync(threadId);
      return context;
    },
  },
  {
    name: "agentsmcp_threads",
    description: "List all threads this agent is part of.",
    schema: EmptyInput,
    handler: async (agent, raw) => {
      EmptyInput.parse(raw ?? {});
      return agent.threads();
    },
  },
  {
    name: "agentsmcp_mark_read",
    description: "Mark a thread as read for this agent.",
    schema: MarkReadInput,
    handler: async (agent, raw) => {
      const { threadId } = MarkReadInput.parse(raw);
      await agent.markRead(threadId);
      return { ok: true };
    },
  },
  {
    name: "agentsmcp_reply_all",
    description:
      "Reply to every visible participant on a thread (excluding the sender " +
      "and BCC'd agents).",
    schema: ReplyAllInput,
    handler: async (agent, raw) => {
      const args = ReplyAllInput.parse(raw);
      return agent.replyAll(args.threadId, args.payload, {
        contextSnapshot: args.contextSnapshot,
      });
    },
  },
  {
    name: "agentsmcp_participants",
    description:
      "List visible participants on a thread with their roles (to/cc/bcc). " +
      "BCC participants are only shown if this agent bcc'd them.",
    schema: ThreadIdInput,
    handler: async (agent, raw) => {
      const { threadId } = ThreadIdInput.parse(raw);
      return agent.participants(threadId);
    },
  },
];

export interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function listToolDefs(): ToolListing[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
  }));
}

export async function runTool(
  agent: AgentMailbox,
  name: string,
  args: unknown
): Promise<unknown> {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) {
    throw new Error(`unknown tool: ${name}`);
  }
  return def.handler(agent, args ?? {});
}
