#!/usr/bin/env node
import { timingSafeEqual } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { createStorage, Storage } from "./storage";
import { Compressor, NoopCompressor } from "./compression";
import { assembleContext } from "./context";
import { readEnv } from "./env";
import {
  AgentAddress,
  ContextFrame,
  Message,
  ParticipantRole,
  Thread,
} from "./types";

const RegisterSchema = z.object({
  agentId: z.string().min(1),
});

const SendSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
  threadId: z.string().optional(),
  cc: z.array(z.string().min(1)).optional(),
  bcc: z.array(z.string().min(1)).optional(),
  replyTo: z.string().min(1).optional(),
});

const ReplyAllSchema = z.object({
  from: z.string().min(1),
  threadId: z.string().min(1),
  payload: z.unknown(),
  contextSnapshot: z.record(z.unknown()).optional(),
});

const MarkReadSchema = z.object({
  threadId: z.string().min(1),
});

function stripBccFromMessage(m: Message, requester: AgentAddress): Message {
  if (m.from === requester) return m;
  if (!m.bcc || m.bcc.length === 0) return m;
  const { bcc: _bcc, ...rest } = m;
  return rest;
}

function stripBccFromMessages(
  messages: Message[],
  requester: AgentAddress
): Message[] {
  return messages.map((m) => stripBccFromMessage(m, requester));
}

function stripBccFromFrame(
  frame: ContextFrame,
  requester: AgentAddress
): ContextFrame {
  const stripped: ContextFrame = { ...frame };
  if (frame.from !== requester && frame.bcc) delete stripped.bcc;
  stripped.context = {
    ...frame.context,
    recentMessages: stripBccFromMessages(frame.context.recentMessages, requester),
  };
  return stripped;
}

function stripBccFromThread(t: Thread, requester: AgentAddress): Thread {
  return {
    ...t,
    silentParticipants: requester && t.silentParticipants.includes(requester)
      ? t.silentParticipants
      : [],
    messages: stripBccFromMessages(t.messages, requester),
  };
}

function bearerMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface CreateServerOptions {
  apiKey?: string;
  /**
   * Compressor used to fold older messages into a structured summary.
   * Defaults to {@link NoopCompressor} — keeps zero-config installs
   * working without any LLM dependency.
   */
  compressor?: Compressor;
  /**
   * Compress only once this many older (beyond the verbatim window)
   * messages have accumulated since the last summary. Defaults to 20.
   */
  compressionThreshold?: number;
}

export interface CreateServerResult {
  app: express.Express;
  storage: Storage;
  ready: Promise<void>;
}

export function createServer(
  dbPath = "agentmailbox.db",
  opts: CreateServerOptions = {}
): CreateServerResult {
  const storage = createStorage(dbPath);
  const ready = storage.init();

  const apiKey =
    opts.apiKey ?? readEnv("AGENTSMCP_API_KEY", "AGENTMAILBOX_API_KEY") ?? "";
  const compressor = opts.compressor ?? new NoopCompressor();
  const compressionThreshold = opts.compressionThreshold;

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const requireApiKey = (req: Request, res: Response, next: NextFunction) => {
    if (!apiKey) return next();
    if (req.path === "/health") return next();
    const header = req.header("authorization") ?? "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const token = header.slice(prefix.length);
    if (!bearerMatches(token, apiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  };
  app.use(requireApiKey);

  // POST /agents/register
  app.post("/agents/register", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const existing = await storage.getAgent(parsed.data.agentId);
      const agent = await storage.registerAgent(parsed.data.agentId);
      return res.status(201).json({
        agentId: agent.id,
        created: !existing,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/send
  app.post("/messages/send", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, to, payload, contextSnapshot, threadId, cc, bcc, replyTo } =
        parsed.data;

      await storage.registerAgent(from);
      await storage.registerAgent(to);
      for (const a of cc ?? []) await storage.registerAgent(a);
      for (const a of bcc ?? []) await storage.registerAgent(a);

      let thread: Thread | null = null;
      if (threadId) {
        thread = await storage.getThread(threadId);
        if (!thread) {
          return res.status(404).json({ error: `thread ${threadId} not found` });
        }
      } else {
        const visibleSet = [from, to, ...(cc ?? [])];
        thread = await storage.getThreadByParticipantSet(visibleSet);
        if (!thread) thread = await storage.createThread(visibleSet, bcc ?? []);
      }

      const message: Message = {
        id: uuidv4(),
        threadId: thread.id,
        from,
        to,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (cc && cc.length > 0) message.cc = cc;
      if (bcc && bcc.length > 0) message.bcc = bcc;
      if (replyTo) message.replyTo = replyTo;

      await storage.appendMessage(thread.id, message);

      const deliveredTo = Array.from(
        new Set<AgentAddress>([to, ...(cc ?? []), ...(bcc ?? [])])
      ).filter((a) => a !== from);

      return res.status(200).json({
        messageId: message.id,
        threadId: thread.id,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // POST /messages/reply-all
  app.post("/messages/reply-all", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = ReplyAllSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      const { from, threadId, payload, contextSnapshot } = parsed.data;

      const thread = await storage.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      await storage.registerAgent(from);

      const visible = thread.participants.filter((p) => p !== from);
      if (visible.length === 0) {
        return res
          .status(400)
          .json({ error: "no other visible participants to reply to" });
      }

      const [primary, ...rest] = visible;
      const message: Message = {
        id: uuidv4(),
        threadId,
        from,
        to: primary,
        payload,
        contextSnapshot: contextSnapshot ?? {},
        timestamp: Date.now(),
      };
      if (rest.length > 0) message.cc = rest;

      await storage.appendMessage(threadId, message);

      const deliveredTo = visible;
      return res.status(200).json({
        messageId: message.id,
        threadId,
        deliveredTo,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId
  app.get("/mailbox/:agentId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const mailbox = await storage.getMailbox(agentId);
      const threadsRaw = await Promise.all(
        mailbox.threads.map((tid) => storage.getThread(tid))
      );
      const threads: Thread[] = threadsRaw
        .filter((t): t is Thread => t !== null)
        .map((t) => stripBccFromThread(t, agentId));
      return res.status(200).json({
        threads,
        unreadCount: mailbox.unreadCount,
      });
    } catch (e) {
      next(e);
    }
  });

  // GET /mailbox/:agentId/unread
  app.get("/mailbox/:agentId/unread", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const unread = await storage.getUnread(agentId);
      const frames: ContextFrame[] = await Promise.all(
        unread.map(async (m) => {
          const allMessages = await storage.getMessages(m.threadId);
          const context = await assembleContext(allMessages, {
            threadId: m.threadId,
            storage,
            compressor,
            compressionThreshold,
          });
          const frame: ContextFrame = {
            id: m.id,
            threadId: m.threadId,
            from: m.from,
            to: m.to,
            timestamp: m.timestamp,
            payload: m.payload,
            context,
          };
          if (m.cc) frame.cc = m.cc;
          if (m.bcc) frame.bcc = m.bcc;
          if (m.replyTo) frame.replyTo = m.replyTo;
          return stripBccFromFrame(frame, agentId);
        })
      );
      return res.status(200).json({ messages: frames });
    } catch (e) {
      next(e);
    }
  });

  // POST /mailbox/:agentId/read
  app.post("/mailbox/:agentId/read", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = req.params.agentId;
      const parsed = MarkReadSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
      }
      await storage.markRead(agentId, parsed.data.threadId);
      return res.status(200).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId
  app.get("/threads/:threadId", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const thread = await storage.getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      return res.status(200).json({ thread: stripBccFromThread(thread, requester) });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/sync
  app.get("/threads/:threadId/sync", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const thread = await storage.getThread(req.params.threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });
      const requester = (req.query.as as string | undefined) ?? "";
      const ctx = await assembleContext(thread.messages, {
        threadId: thread.id,
        storage,
        compressor,
        compressionThreshold,
      });
      const responseContext: Record<string, unknown> = {
        snapshot: ctx.snapshot,
        threadSummary: ctx.threadSummary,
        recentMessages: stripBccFromMessages(ctx.recentMessages, requester),
        tokenCount: ctx.tokenCount,
      };
      if (ctx.threadSummaryStructured) {
        responseContext.threadSummaryStructured = ctx.threadSummaryStructured;
      }
      return res.status(200).json({ context: responseContext });
    } catch (e) {
      next(e);
    }
  });

  // GET /threads/:threadId/participants
  app.get("/threads/:threadId/participants", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const threadId = req.params.threadId;
      const thread = await storage.getThread(threadId);
      if (!thread) return res.status(404).json({ error: "thread not found" });

      const requester = (req.query.as as string | undefined) ?? "";
      const roles = await storage.getThreadParticipants(threadId);

      // Determine which BCC agents the requester can see.
      // Rule: requester sees a BCC participant iff requester is the sender of
      // any message that included that agent in BCC, OR requester IS that BCC agent.
      const messages = thread.messages;
      const bccVisibleToRequester = new Set<string>();
      for (const m of messages) {
        if (!m.bcc) continue;
        if (m.from === requester) {
          for (const a of m.bcc) bccVisibleToRequester.add(a);
        }
      }
      if (requester) bccVisibleToRequester.add(requester);

      const filtered: ParticipantRole[] = roles.filter((p) => {
        if (p.role !== "bcc") return true;
        return bccVisibleToRequester.has(p.agentId);
      });

      return res.status(200).json({ participants: filtered });
    } catch (e) {
      next(e);
    }
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[agentsmcp] error:", err);
    res.status(500).json({ error: err.message ?? "internal error" });
  });

  return { app, storage, ready };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000);
  const dbPath =
    readEnv("AGENTSMCP_DB", "AGENTMAILBOX_DB") ?? "agentmailbox.db";
  const { app, ready } = createServer(dbPath);
  ready
    .then(() => {
      app.listen(port, () => {
        console.log(`[agentsmcp] server listening on http://localhost:${port}`);
        console.log(`[agentsmcp] db: ${dbPath}`);
      });
    })
    .catch((e) => {
      console.error("[agentsmcp] failed to initialize storage:", e);
      process.exit(1);
    });
}
