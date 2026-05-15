import type { AgentMailbox } from "agentsmcp";

export const MAILBOX_URI = "agentsmcp://mailbox";
export const THREAD_URI_PREFIX = "agentsmcp://thread/";

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceTemplateListing {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
}

export function listResources(): ResourceListing[] {
  return [
    {
      uri: MAILBOX_URI,
      name: "Mailbox",
      description: "All threads this agent is part of",
      mimeType: "application/json",
    },
  ];
}

export function listResourceTemplates(): ResourceTemplateListing[] {
  return [
    {
      uriTemplate: `${THREAD_URI_PREFIX}{threadId}`,
      name: "Thread",
      description: "Full thread including messages and context",
      mimeType: "application/json",
    },
  ];
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

export async function readResource(
  agent: AgentMailbox,
  uri: string
): Promise<ResourceContent> {
  if (uri === MAILBOX_URI) {
    const threads = await agent.threads();
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ threads }, null, 2),
    };
  }

  if (uri.startsWith(THREAD_URI_PREFIX)) {
    const threadId = decodeURIComponent(uri.slice(THREAD_URI_PREFIX.length));
    if (!threadId) {
      throw new Error(`invalid thread resource uri: ${uri}`);
    }
    const [{ context }, participants] = await Promise.all([
      agent.sync(threadId),
      agent.participants(threadId),
    ]);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ threadId, context, participants }, null, 2),
    };
  }

  throw new Error(`unknown resource uri: ${uri}`);
}
