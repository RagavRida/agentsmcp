# Changelog

## 0.3.5 — 2026-05-16

### Fixed

- **NoopCompressor lost message coverage across successive threshold
  crossings.** The default compressor returned only the new batch in
  `coversMessageIds` instead of unioning with the prior summary's
  coverage. Effect: after the second compression on a thread, the
  cache forgot earlier messages and triggered unnecessary
  recompressions on every subsequent read. `ClaudeCompressor` was
  already doing this correctly; only the default was wrong.
- **JS SDK `receive()` was still hand-picking fields.** The 0.3.2 fix
  added `tokenCount` and a conditional for `threadSummaryStructured`
  but kept the field-list pattern, so any future optional field on
  `ThreadContext` would silently drop again. Now uses
  `{ ...last.context }` spread.

### Added

- Regression test exercising two threshold crossings with a read
  between them — the only scenario in which the NoopCompressor
  coverage bug manifests. Single-call tests can't reproduce it.

## 0.3.4 — 2026-05-16

### Changed

- Server log prefix is now `[agentsmcp]` instead of `[agentmailbox]`
  for consistency with the package name. Purely cosmetic; appears on
  every server startup and in error logs.

## 0.3.3 — 2026-05-16

### Added

- New env var names matching the package name:
  - `AGENTSMCP_API_KEY` (was `AGENTMAILBOX_API_KEY`)
  - `AGENTSMCP_DB` (was `AGENTMAILBOX_DB`)
  - `AGENTSMCP_SERVER` (used by the MCP adapter and examples; was `AGENTMAILBOX_SERVER`)
  - `AGENTSMCP_AGENT_ID` (used by the MCP adapter; was `AGENTMAILBOX_AGENT_ID`)
- New CLI bin `agentsmcp-server` pointing at the same compiled
  entrypoint as `agentmailbox-server`.

### Deprecated

- Legacy `AGENTMAILBOX_*` env vars and the `agentmailbox-server` bin
  name continue to work for one minor version. The server warns once
  on stderr when a legacy env var is read. Both will be removed in
  0.4.0.

### Migration

```diff
-AGENTMAILBOX_API_KEY=s3cret npx agentmailbox-server
+AGENTSMCP_API_KEY=s3cret npx agentsmcp-server
```

```diff
 {
   "mcpServers": {
     "agentsmcp": {
       "command": "npx",
       "args": ["-y", "agentsmcp-adapter"],
       "env": {
-        "AGENTMAILBOX_AGENT_ID": "claude@local",
-        "AGENTMAILBOX_SERVER": "http://localhost:3000"
+        "AGENTSMCP_AGENT_ID": "claude@local",
+        "AGENTSMCP_SERVER": "http://localhost:3000"
       }
     }
   }
 }
```

## 0.3.2 — 2026-05-16

### Fixed

- JS SDK was the client-side mirror of the 0.3.1 `/sync` server bug:
  `AgentMailbox.sync()` and `AgentMailbox.receive()` both stripped
  `threadSummaryStructured` and `tokenCount` from the context they
  returned, even though the server has been sending those fields since
  0.3.0. Any code calling the JS SDK was therefore blind to the
  compression feature. `ReceiveResult.context` now declares both
  fields (`tokenCount` and optional `threadSummaryStructured`), and
  both methods pass them through. Found while building the
  `examples/research-bench/` demo — the synthesizer needed structured
  summaries from `sync()` to extend rather than regenerate.

## 0.3.1 — 2026-05-16

### Fixed

- `/threads/:id/sync` was hand-picking three fields from the assembled
  context and silently dropped the new `threadSummaryStructured` and
  `tokenCount`. MCP clients calling `agentsmcp_sync` therefore never
  saw structured summaries on 0.3.0. Now passes them through. Added a
  regression test that sends 30 messages and asserts the structured
  summary lands on `/sync`.

## 0.3.0 — 2026-05-16

### Added

- **LLM-based context compression.** New `Compressor` interface plus two
  implementations:
  - `NoopCompressor` (default) — empty summary, no LLM dependency,
    keeps zero-config installs working.
  - `ClaudeCompressor` — folds older messages into a structured summary
    (`{ text, decisions, openQuestions, artifacts }`) via Claude Haiku.
    `@anthropic-ai/sdk` is an optional peer dep — install it only if
    you use this compressor.
- `Storage` interface gains `getSummary` / `saveSummary`; SQLite adds a
  `thread_summaries` table (idempotent migration on `init()`).
- `assembleContext` is now async and accepts
  `{ threadId, storage, compressor, compressionThreshold }`. Older
  messages beyond the verbatim window are folded into a cached
  `ThreadSummary`. Default trigger: ≥20 uncovered older messages.
- `createServer({ compressor, compressionThreshold })` wires the
  compressor into the unread / sync routes.
- `ThreadContext` gains an optional `threadSummaryStructured` field for
  programmatic access; existing `threadSummary` string still populated
  from the structured summary's prose `text` (non-breaking).

### Removed (breaking)

- `AgentMailboxStorage` deprecated alias (announced in 0.2.0). Use
  `SqliteStorage` or `createStorage()` instead.

### Migration

If you were still importing the alias:

```diff
-import { AgentMailboxStorage } from "agentsmcp";
+import { SqliteStorage } from "agentsmcp";
-const storage = new AgentMailboxStorage("./db.sqlite");
+const storage = new SqliteStorage("./db.sqlite");
```

To opt into Claude-backed compression:

```ts
import { createServer, ClaudeCompressor } from "agentsmcp";
const { app, ready } = createServer("./db.sqlite", {
  compressor: new ClaudeCompressor(),     // reads ANTHROPIC_API_KEY
  compressionThreshold: 20,
});
```

## 0.2.1 — 2026-05-16

### Fixed

- `main` / `types` pointed at the client SDK file, so installs from npm
  only exposed `AgentMailbox` and `assembleContext` — `createServer`,
  `createStorage`, `SqliteStorage`, and the deprecated alias were
  unreachable. Now points at `dist/index.js` / `dist/index.d.ts`, the
  full barrel.

## 0.2.0 — 2026-05-16

### Changed (breaking)

- Storage layer is now pluggable. The concrete `AgentMailboxStorage` class
  is replaced by a `Storage` interface and a `SqliteStorage` adapter, both
  exported from `agentmailbox`. Every storage method is now `async` and
  returns a `Promise`.
- `createServer()` now returns `{ app, storage, ready }`. Callers must
  `await ready` before serving traffic so schema migrations finish first.
- New `createStorage(opts)` factory accepts a file path or a
  `StorageOptions` object — preferred entry point for new code. The
  Postgres branch is reserved but not yet implemented.

### Deprecated

- `AgentMailboxStorage` is re-exported as a `@deprecated` alias for
  `SqliteStorage`. Scheduled for removal in 0.3.0.

### Migration

```diff
-import { AgentMailboxStorage } from "agentmailbox";
-const storage = new AgentMailboxStorage("./db.sqlite");
-storage.init();
-const agent = storage.registerAgent("alice@demo");
+import { createStorage } from "agentmailbox";
+const storage = createStorage("./db.sqlite");
+await storage.init();
+const agent = await storage.registerAgent("alice@demo");
```

```diff
-const { app } = createServer("./db.sqlite");
-app.listen(3000);
+const { app, ready } = createServer("./db.sqlite");
+await ready;
+app.listen(3000);
```

## 0.1.0 — unreleased

> Note: renamed from `agentmail` to `agentmailbox` before first publish
> because the original name was taken on npm and PyPI by another project.

### Added

- Core context-sync protocol (HTTP server + SQLite storage).
- JavaScript SDK (`agentmailbox`).
- Python SDK (`agentmailbox` on PyPI), async + sync wrapper.
- MCP adapter (`agentmailbox-mcp`) exposing the protocol as MCP tools.
- CC / BCC / ReplyAll multi-agent threads.
- Optional API-key auth via `AGENTMAILBOX_API_KEY`.
- Vitest test suite for JS, pytest suite for Python.
- GitHub Actions CI matrix.
- Research+Writer demo app showing cold-restart context recovery.
