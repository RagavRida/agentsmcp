# Contributing to AgentsMCP

Thank you for your interest in contributing to AgentsMCP! This document provides guidelines and information to help you get started.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/RagavRida/agentsmcp.git
cd agentsmcp

# Install dependencies
npm install

# Run tests
npm test

# Start the dev server
npx tsx src/server.ts
```

## Architecture Overview

```
agentsmcp/
├── src/
│   ├── server.ts          # Express server — all HTTP routes (monolith)
│   ├── logger.ts          # Structured logging (pino)
│   ├── config.ts          # Environment validation (zod)
│   ├── types.ts           # Shared TypeScript types
│   ├── compression.ts     # Context compression (Claude/OpenAI/Noop)
│   ├── context.ts         # Context frame assembly
│   ├── ratelimit.ts       # Per-key rate limiting
│   ├── storage/
│   │   ├── interface.ts   # Storage interface (abstract)
│   │   ├── sqlite.ts      # SQLite adapter (default, better-sqlite3)
│   │   └── postgres.ts    # PostgreSQL adapter (production)
│   ├── cloud/
│   │   ├── auth.ts        # GitHub OAuth, API keys, JWT sessions
│   │   ├── middleware.ts  # Cloud-mode middleware (auth, caps)
│   │   ├── audit.ts       # Audit trail logging
│   │   └── scoping.ts     # Multi-tenant data scoping
│   ├── mcp/
│   │   ├── index.ts       # MCP server entry (stdio transport)
│   │   └── tools.ts       # 24 MCP tool definitions
│   └── cli/
│       └── init.ts        # `npx agentsmcp init` wizard
├── scripts/
│   └── index-codebase.ts  # CI codebase indexer (zero-LLM)
├── sdk-py/                # Python SDK
├── langgraph/             # LangGraph integration
├── tests/                 # 163 tests (no mocks, real processes)
└── infra/                 # Postgres migrations, deploy scripts
```

## Testing

We follow a **strict no-mocks policy**. All tests use real child processes and real database instances:

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/server.test.ts

# Run tests in watch mode
npx vitest
```

### Test Conventions

- No `vi.mock()`, no `vi.spyOn()` — use real subprocess spawning
- Each test file creates its own isolated SQLite DB (`:memory:` or temp file)
- Cloud tests that require Postgres are skipped without `AGENTSMCP_DB`
- Integration tests boot a real server and make HTTP requests

## Code Style

- **TypeScript** for all source code
- **Zod** for runtime validation
- **Pino** for structured logging (never `console.log` in `src/`)
- Parameterized SQL queries only — no string interpolation

## Pull Request Process

1. Fork the repository and create a feature branch
2. Make your changes with descriptive commits
3. Ensure all 163 tests pass: `npm test`
4. Update documentation if applicable
5. Submit a PR against `main`

## Commit Messages

Follow conventional commits:
```
feat: add new MCP tool for graph traversal
fix: handle edge case in message routing
docs: update API documentation
test: add coverage for rate limiting
```

## Areas for Contribution

- **New MCP tools** — extend the 24-tool suite
- **Language parsers** — add new languages to the codebase indexer
- **SDK clients** — Ruby, Go, Java SDKs
- **Documentation** — API docs, tutorials, examples
- **Performance** — query optimization, caching

## Code of Conduct

Be respectful, constructive, and collaborative. We follow the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).

## License

By contributing, you agree that your contributions will be licensed under the project's MIT License.
