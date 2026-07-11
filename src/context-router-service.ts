import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import type { ReceiveResult } from "./types";
import {
  ContextRouter,
  type ContextEnvelope,
  type ContextField,
  type Visibility,
} from "./context-router";

const ROUTER_META_KEY = "_contextRouter";
const DEFAULT_PROFILES_PATH = ".agentmailbox/context-router-profiles.json";

interface PersistedProfile {
  agentId: string;
  accessedFields: Record<string, number>;
  requestedFields: string[];
  tokenBudget: number;
  updatedAt: number;
}

let _router: ContextRouter | null = null;
let _profilesLoaded = false;
let _profilesPath = resolve(
  process.env.AGENTSMCP_CONTEXT_ROUTER_PATH ?? DEFAULT_PROFILES_PATH,
);

export function getContextRouterProfilesPath(): string {
  return _profilesPath;
}

export function getContextRouter(): ContextRouter {
  if (!_router) {
    _router = new ContextRouter();
    if (!_profilesLoaded) {
      void loadContextRouterProfiles();
    }
  }
  return _router;
}

export function resetContextRouter(): void {
  _router = null;
  _profilesLoaded = false;
  _profilesPath = resolve(
    process.env.AGENTSMCP_CONTEXT_ROUTER_PATH ?? DEFAULT_PROFILES_PATH,
  );
}

export async function loadContextRouterProfiles(
  filePath?: string,
): Promise<void> {
  if (filePath) _profilesPath = resolve(filePath);
  const router = getContextRouter();
  try {
    const raw = await readFile(_profilesPath, "utf-8");
    const profiles = JSON.parse(raw) as PersistedProfile[];
    for (const profile of profiles) {
      router.declareInterest(
        profile.agentId,
        profile.requestedFields,
        profile.tokenBudget,
      );
      for (const [field, count] of Object.entries(profile.accessedFields)) {
        for (let i = 0; i < count; i++) {
          router.trackAccess(profile.agentId, [field]);
        }
      }
    }
  } catch {
    // No profiles file yet
  }
  _profilesLoaded = true;
}

export async function saveContextRouterProfiles(
  filePath?: string,
): Promise<void> {
  const path = resolve(filePath ?? _profilesPath);
  await mkdir(resolve(path, ".."), { recursive: true });

  const router = getContextRouter();
  const profiles: PersistedProfile[] = [];

  for (const agentId of router.listAgentIds()) {
    const profile = router.getInterestProfile(agentId);
    if (!profile) continue;
    profiles.push({
      agentId: profile.agentId,
      accessedFields: Object.fromEntries(profile.accessedFields.entries()),
      requestedFields: [...profile.requestedFields],
      tokenBudget: profile.tokenBudget,
      updatedAt: profile.updatedAt,
    });
  }

  await writeFile(path, JSON.stringify(profiles, null, 2), "utf-8");
}

export function wrapContextForSend(
  senderId: string,
  snapshot: Record<string, unknown>,
  overrides?: Partial<Record<string, Visibility>>,
): Record<string, unknown> {
  const envelope = getContextRouter().wrap(senderId, snapshot, overrides);
  return {
    ...envelope.full,
    [ROUTER_META_KEY]: {
      fields: envelope.fields,
      provenance: envelope.provenance,
    },
  };
}

function envelopeFromSnapshot(snapshot: Record<string, unknown>): ContextEnvelope | null {
  const meta = snapshot[ROUTER_META_KEY];
  if (!meta || typeof meta !== "object") return null;

  const full = { ...snapshot };
  delete full[ROUTER_META_KEY];

  return {
    full,
    fields: (meta as { fields?: ContextField[] }).fields ?? [],
    provenance: (meta as { provenance?: ContextEnvelope["provenance"] }).provenance ?? [],
  };
}

export function scopeSnapshotForReceiver(
  receiverId: string,
  snapshot: Record<string, unknown>,
  opts?: { tokenBudget?: number },
): Record<string, unknown> {
  const envelope = envelopeFromSnapshot(snapshot);
  if (!envelope) return snapshot;

  const scoped = getContextRouter().scope(envelope, receiverId, opts);
  const included = (scoped._includedFields as string[] | undefined) ?? [];
  if (included.length > 0) {
    getContextRouter().trackAccess(receiverId, included);
    void persistProfilesDebounced();
  }
  return scoped;
}

export function scopeReceiveResult(
  receiverId: string,
  result: ReceiveResult,
): ReceiveResult {
  const scopeSnap = (snap: Record<string, unknown>) =>
    scopeSnapshotForReceiver(receiverId, snap ?? {});

  const scopeMessages = (messages: ReceiveResult["context"]["recentMessages"]) =>
    messages.map((m) => ({
      ...m,
      contextSnapshot: scopeSnap(m.contextSnapshot ?? {}),
    }));

  return {
    messages: result.messages.map((frame) => ({
      ...frame,
      context: {
        ...frame.context,
        snapshot: scopeSnap(frame.context.snapshot ?? {}),
        recentMessages: scopeMessages(frame.context.recentMessages),
      },
    })),
    context: {
      ...result.context,
      snapshot: scopeSnap(result.context.snapshot ?? {}),
      recentMessages: scopeMessages(result.context.recentMessages),
    },
  };
}

let persistTimer: NodeJS.Timeout | null = null;

function persistProfilesDebounced(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void saveContextRouterProfiles().catch(() => undefined);
  }, 500);
}

export async function declareInterestAndPersist(
  agentId: string,
  fields: string[],
  tokenBudget?: number,
): Promise<void> {
  getContextRouter().declareInterest(agentId, fields, tokenBudget);
  await saveContextRouterProfiles();
}
