import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentMailbox } from "agentsmcp";

import { listToolDefs, runTool } from "./tools";
import {
  listResources,
  listResourceTemplates,
  readResource,
} from "./resources";

export function buildServer(agent: AgentMailbox): Server {
  const server = new Server(
    { name: "agentsmcp", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listToolDefs(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    const result = await runTool(agent, name, args);
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
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
