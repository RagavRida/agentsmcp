import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentMailbox } from "../agentmailbox";
import {
  launchBackgroundTask,
  listBackgroundTasks,
  scheduleSessionDistillation,
} from "../memory/service";
import { loadContextRouterProfiles } from "../context-router-service";
import { logToolUsage, getMcpUsageStats } from "./usage";

import { listToolDefs, runTool } from "./tools";
import {
  listResources,
  listResourceTemplates,
  readResource,
} from "./resources";

// ---------- Context Cache ----------

class ContextCache {
  private cache = new Map<string, { data: unknown; expiry: number }>();
  private ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  get(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: unknown): void {
    this.cache.set(key, { data, expiry: Date.now() + this.ttlMs });
  }

  invalidate(): void {
    this.cache.clear();
  }
}

// Tools whose results should be cached (read-only graph/index operations)
const CACHEABLE_TOOLS = new Set([
  "agentsmcp_query_graph",
  "agentsmcp_get_index",
  "agentsmcp_search_index",
  "agentsmcp_context_briefing",
  "agentsmcp_recall",
  "agentsmcp_list_data",
  "agentsmcp_health",
  "agentsmcp_get_chunk_neighbors",
]);

// Tools that mutate the graph/index and should invalidate the cache
const WRITE_TOOLS = new Set([
  "agentsmcp_upsert_node",
  "agentsmcp_add_edge",
  "agentsmcp_upsert_index",
  "agentsmcp_remember",
  "agentsmcp_forget",
  "agentsmcp_learn_rules",
  "agentsmcp_prune",
]);

// ── Background Task Registry (Cognee-inspired) ──────────────
// Returns task IDs for polling via agentsmcp_task_status.

// Tools that are long-running and should return immediately
const BACKGROUND_TOOLS = new Set([
  "agentsmcp_remember",
  "agentsmcp_improve",
  "agentsmcp_analyze_legacy_impact",
]);

// ── Usage Logging (Cognee-inspired) ──────────────────────────

/** Get recent usage stats (includes failed background tasks). */
export function getUsageStats() {
  return getMcpUsageStats();
}

export function buildMcpServer(agent: AgentMailbox): Server {
  void loadContextRouterProfiles();
  scheduleSessionDistillation();

  const server = new Server(
    { name: "agentsmcp", version: "0.5.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  const cache = new ContextCache();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefs(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const startTime = Date.now();

    try {
      // Check cache for read operations
      if (CACHEABLE_TOOLS.has(name)) {
        const cacheKey = `${name}:${JSON.stringify(args)}`;
        const cached = cache.get(cacheKey);
        if (cached !== null) {
          logToolUsage(name, Date.now() - startTime, true);
          return {
            content: [
              { type: "text", text: JSON.stringify(cached, null, 2) },
            ],
          };
        }

        const result = await runTool(agent, name, args);
        cache.set(cacheKey, result);
        logToolUsage(name, Date.now() - startTime, true);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      // Invalidate cache on write operations
      if (WRITE_TOOLS.has(name)) {
        cache.invalidate();
      }

      // Background task pattern for long-running operations
      if (BACKGROUND_TOOLS.has(name)) {
        const taskId = launchBackgroundTask(name, () => runTool(agent, name, args));
        logToolUsage(name, Date.now() - startTime, true);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "background",
                taskId,
                tool: name,
                message: `Background task launched for ${name}. ` +
                  `Poll status with agentsmcp_task_status(taskId: "${taskId}").`,
              }, null, 2),
            },
          ],
        };
      }

      const result = await runTool(agent, name, args);
      logToolUsage(name, Date.now() - startTime, true);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      logToolUsage(name, Date.now() - startTime, false);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: true,
              tool: name,
              message: String(err),
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResources(),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: listResourceTemplates(),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const content = await readResource(agent, req.params.uri);
    return { contents: [content] };
  });

  return server;
}
