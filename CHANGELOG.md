# Changelog

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
