-- ============================================================================
-- AgentMailbox — Production-Ready PostgreSQL Schema
-- ============================================================================
-- Version: 1.0.0
-- Compatibility: PostgreSQL 14+
-- 
-- Sections:
--   1. Extensions
--   2. Schema migrations tracker
--   3. Core tables (agents, threads, messages, mailbox)
--   4. Context compression
--   5. Multi-tenant cloud (users, API keys, organizations)
--   6. Rate limiting & usage metering
--   7. Audit log
--   8. Webhooks
--   9. Indexes (beyond PKs)
--  10. Row-Level Security (RLS)
--  11. Retention policy helper
--  12. Useful views
-- ============================================================================


-- ============================================================================
-- 1. EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";      -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";       -- gen_random_bytes() for API keys


-- ============================================================================
-- 2. SCHEMA MIGRATIONS TRACKER
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT        PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    description TEXT
);

INSERT INTO schema_migrations (version, description)
VALUES ('1.0.0', 'Initial production schema')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- 3. CORE TABLES
-- ============================================================================

-- 3a. Users (cloud tier — omitted in self-hosted mode)
-- Every row in this table is a paying/free-tier customer.

CREATE TABLE IF NOT EXISTS users (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT        UNIQUE NOT NULL,
    name            TEXT,
    plan            TEXT        NOT NULL DEFAULT 'free'
                                CHECK (plan IN ('free','pro','team','enterprise')),
    org_id          UUID,       -- NULL = personal account
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3b. Organizations (optional — for team/enterprise tier)

CREATE TABLE IF NOT EXISTS organizations (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT        NOT NULL,
    plan            TEXT        NOT NULL DEFAULT 'team'
                                CHECK (plan IN ('team','enterprise')),
    owner_user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add FK from users.org_id → organizations.id after both tables exist
ALTER TABLE users
    ADD CONSTRAINT fk_users_org
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE SET NULL;

-- 3c. API Keys — per-user, hashed, rotatable

CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash        TEXT        NOT NULL UNIQUE,         -- SHA-256 of full key
    key_prefix      TEXT        NOT NULL,                -- first 8 chars (sk_live_xxxx) for display
    name            TEXT        NOT NULL DEFAULT 'default',
    scopes          TEXT[]      NOT NULL DEFAULT '{all}', -- future: 'read','write','admin'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,                         -- NULL = never expires
    revoked_at      TIMESTAMPTZ                          -- NULL = active
);

-- 3d. Agents

CREATE TABLE IF NOT EXISTS agents (
    id              TEXT        PRIMARY KEY,              -- e.g. "cursor@local"
    user_id         UUID        REFERENCES users(id) ON DELETE CASCADE,  -- NULL in self-hosted
    display_name    TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ                          -- updated on receive/send
);

-- 3e. Threads

CREATE TABLE IF NOT EXISTS threads (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        REFERENCES users(id) ON DELETE CASCADE,  -- NULL in self-hosted
    subject         TEXT,                                 -- optional thread subject
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_archived     BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3f. Thread Participants

CREATE TABLE IF NOT EXISTS thread_participants (
    thread_id       UUID        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    agent_id        TEXT        NOT NULL,
    role            TEXT        NOT NULL CHECK (role IN ('visible','silent')),
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (thread_id, agent_id)
);

-- 3g. Messages

CREATE TABLE IF NOT EXISTS messages (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id       UUID        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    from_agent      TEXT        NOT NULL,
    to_agent        TEXT        NOT NULL,
    cc              TEXT[]      NOT NULL DEFAULT '{}',
    bcc             TEXT[]      NOT NULL DEFAULT '{}',
    reply_to        TEXT,
    payload         JSONB       NOT NULL,
    context_snapshot JSONB      NOT NULL DEFAULT '{}'::jsonb,
    timestamp       BIGINT      NOT NULL,                -- epoch milliseconds
    payload_size_bytes INTEGER  GENERATED ALWAYS AS (octet_length(payload::text)) STORED,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3h. Mailbox State (unread tracking)

CREATE TABLE IF NOT EXISTS mailbox_state (
    agent_id        TEXT        NOT NULL,
    thread_id       UUID        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    unread_count    INTEGER     NOT NULL DEFAULT 0,
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT to_timestamp(0),
    PRIMARY KEY (agent_id, thread_id)
);


-- ============================================================================
-- 4. CONTEXT COMPRESSION
-- ============================================================================

CREATE TABLE IF NOT EXISTS thread_summaries (
    thread_id       UUID        PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    summary         JSONB       NOT NULL,
    -- Structured fields extracted from summary JSONB for fast querying
    decision_count  INTEGER     GENERATED ALWAYS AS (jsonb_array_length(
                                    COALESCE(summary->'decisions', '[]'::jsonb)
                                )) STORED,
    question_count  INTEGER     GENERATED ALWAYS AS (jsonb_array_length(
                                    COALESCE(summary->'openQuestions', '[]'::jsonb)
                                )) STORED,
    compressor_used TEXT,                                -- 'claude', 'openai', 'noop'
    token_count     INTEGER,                             -- estimated tokens of summary
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 5. BILLING (Stripe integration for cloud tier)
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_customers (
    user_id                 UUID    PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id      TEXT    UNIQUE NOT NULL,
    stripe_subscription_id  TEXT,
    subscription_status     TEXT    DEFAULT 'inactive'
                                   CHECK (subscription_status IN (
                                       'active','past_due','canceled','trialing','inactive'
                                   )),
    current_period_start    TIMESTAMPTZ,
    current_period_end      TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 6. RATE LIMITING & USAGE METERING
-- ============================================================================

-- 6a. Usage metrics — rolled up per user per day

CREATE TABLE IF NOT EXISTS usage_metrics (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    metric          TEXT        NOT NULL,
                                -- 'messages_sent', 'messages_received',
                                -- 'agents_registered', 'compression_calls',
                                -- 'api_calls', 'payload_bytes'
    count           BIGINT      NOT NULL DEFAULT 0,
    period_start    DATE        NOT NULL,                -- day granularity
    UNIQUE (user_id, metric, period_start)
);

-- 6b. Plan limits reference table

CREATE TABLE IF NOT EXISTS plan_limits (
    plan                    TEXT    PRIMARY KEY,
    max_agents              INTEGER NOT NULL,
    max_messages_per_day    INTEGER NOT NULL,
    max_threads             INTEGER NOT NULL,
    max_payload_bytes       INTEGER NOT NULL,            -- per message
    max_api_keys            INTEGER NOT NULL,
    retention_days          INTEGER NOT NULL,             -- message retention
    compression_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    webhooks_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
    priority_support        BOOLEAN NOT NULL DEFAULT FALSE
);

INSERT INTO plan_limits VALUES
    ('free',       10,    500,    100,   65536,   2,    7, FALSE, FALSE, FALSE),
    ('pro',        50,  10000,   1000,  262144,  10,   30,  TRUE,  TRUE, FALSE),
    ('team',      200, 100000,  10000, 1048576,  50,   90,  TRUE,  TRUE,  TRUE),
    ('enterprise', -1,     -1,     -1,      -1,  -1,   -1,  TRUE,  TRUE,  TRUE)
    -- -1 = unlimited
ON CONFLICT (plan) DO NOTHING;

-- 6c. Rate limit state (in-memory preferred, DB fallback for multi-instance)

CREATE TABLE IF NOT EXISTS rate_limit_state (
    key             TEXT        PRIMARY KEY,              -- e.g. "user:<uuid>:rpm"
    count           INTEGER     NOT NULL DEFAULT 0,
    window_start    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_seconds  INTEGER     NOT NULL DEFAULT 60
);


-- ============================================================================
-- 7. AUDIT LOG
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        REFERENCES users(id) ON DELETE SET NULL,
    agent_id        TEXT,
    action          TEXT        NOT NULL,
                                -- 'agent.register', 'message.send', 'message.receive',
                                -- 'thread.create', 'key.create', 'key.revoke',
                                -- 'auth.login', 'auth.fail', 'plan.upgrade'
    resource_type   TEXT,       -- 'agent', 'thread', 'message', 'api_key'
    resource_id     TEXT,       -- the id of the affected resource
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partition audit_log by month for performance (Postgres 12+)
-- In production, create child tables per month:
-- CREATE TABLE audit_log_2025_01 PARTITION OF audit_log
--     FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');


-- ============================================================================
-- 8. WEBHOOKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS webhooks (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url             TEXT        NOT NULL,
    events          TEXT[]      NOT NULL DEFAULT '{message.sent,message.received}',
                                -- 'message.sent', 'message.received', 'thread.created',
                                -- 'agent.registered', 'compression.completed'
    secret          TEXT        NOT NULL,                 -- HMAC signing secret
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    failure_count   INTEGER     NOT NULL DEFAULT 0,       -- consecutive failures
    max_failures    INTEGER     NOT NULL DEFAULT 10,      -- disable after N failures
    last_triggered  TIMESTAMPTZ,
    last_status     INTEGER,                              -- HTTP status code
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    webhook_id      UUID        NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event           TEXT        NOT NULL,
    payload         JSONB       NOT NULL,
    response_status INTEGER,
    response_body   TEXT,
    duration_ms     INTEGER,
    attempt         INTEGER     NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 9. INDEXES
-- ============================================================================

-- Core lookups
CREATE INDEX IF NOT EXISTS idx_agents_user
    ON agents(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_last_seen
    ON agents(last_seen_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_threads_user
    ON threads(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_threads_updated
    ON threads(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_not_archived
    ON threads(user_id, updated_at DESC) WHERE NOT is_archived;

CREATE INDEX IF NOT EXISTS idx_thread_participants_agent
    ON thread_participants(agent_id);

CREATE INDEX IF NOT EXISTS idx_messages_thread_ts
    ON messages(thread_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_from
    ON messages(from_agent, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_to
    ON messages(to_agent, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created
    ON messages(created_at);

CREATE INDEX IF NOT EXISTS idx_mailbox_state_agent_unread
    ON mailbox_state(agent_id, unread_count)
    WHERE unread_count > 0;

-- Auth
CREATE INDEX IF NOT EXISTS idx_api_keys_user
    ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash
    ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
    ON api_keys(key_prefix);

-- Usage
CREATE INDEX IF NOT EXISTS idx_usage_metrics_user_period
    ON usage_metrics(user_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_usage_metrics_lookup
    ON usage_metrics(user_id, metric, period_start);

-- Audit
CREATE INDEX IF NOT EXISTS idx_audit_log_user
    ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource
    ON audit_log(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created
    ON audit_log(created_at);

-- Webhooks
CREATE INDEX IF NOT EXISTS idx_webhooks_user
    ON webhooks(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook
    ON webhook_deliveries(webhook_id, created_at DESC);


-- ============================================================================
-- 10. ROW-LEVEL SECURITY (RLS)
-- ============================================================================
-- Enable when running in cloud multi-tenant mode.
-- The application sets: SET app.current_user_id = '<uuid>';
-- before each request (in the middleware).

ALTER TABLE agents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE thread_summaries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys          ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metrics     ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhooks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log         ENABLE ROW LEVEL SECURITY;

-- Agents: users see only their own agents
CREATE POLICY agents_isolation ON agents
    USING (user_id IS NULL OR user_id = current_setting('app.current_user_id')::uuid);

-- Threads: users see only their own threads
CREATE POLICY threads_isolation ON threads
    USING (user_id IS NULL OR user_id = current_setting('app.current_user_id')::uuid);

-- Messages: users see messages in their threads
CREATE POLICY messages_isolation ON messages
    USING (thread_id IN (
        SELECT id FROM threads
        WHERE user_id IS NULL
           OR user_id = current_setting('app.current_user_id')::uuid
    ));

-- Mailbox: users see only their agents' mailbox state
CREATE POLICY mailbox_isolation ON mailbox_state
    USING (agent_id IN (
        SELECT id FROM agents
        WHERE user_id IS NULL
           OR user_id = current_setting('app.current_user_id')::uuid
    ));

-- Summaries: users see summaries for their threads
CREATE POLICY summaries_isolation ON thread_summaries
    USING (thread_id IN (
        SELECT id FROM threads
        WHERE user_id IS NULL
           OR user_id = current_setting('app.current_user_id')::uuid
    ));

-- API keys: users see only their own keys
CREATE POLICY keys_isolation ON api_keys
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Usage: users see only their own metrics
CREATE POLICY usage_isolation ON usage_metrics
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Webhooks: users see only their own webhooks
CREATE POLICY webhooks_isolation ON webhooks
    USING (user_id = current_setting('app.current_user_id')::uuid);

-- Audit: users see only their own audit entries
CREATE POLICY audit_isolation ON audit_log
    USING (user_id IS NULL OR user_id = current_setting('app.current_user_id')::uuid);

-- IMPORTANT: The application superuser role should BYPASS RLS.
-- In self-hosted mode, RLS is enabled but no current_user_id is set,
-- so the IS NULL clauses allow full access.


-- ============================================================================
-- 11. DATA RETENTION HELPER
-- ============================================================================
-- Run periodically via pg_cron or application-level scheduler.

-- Delete messages older than the user's plan retention period
-- Usage: SELECT cleanup_expired_messages();

CREATE OR REPLACE FUNCTION cleanup_expired_messages()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER := 0;
    affected_count INTEGER := 0;
    r RECORD;
BEGIN
    FOR r IN
        SELECT u.id AS user_id, pl.retention_days
        FROM users u
        JOIN plan_limits pl ON pl.plan = u.plan
        WHERE pl.retention_days > 0  -- -1 = unlimited
    LOOP
        DELETE FROM messages m
        USING threads t
        WHERE m.thread_id = t.id
          AND t.user_id = r.user_id
          AND m.created_at < NOW() - (r.retention_days || ' days')::interval;

        GET DIAGNOSTICS affected_count = ROW_COUNT;
        deleted_count := deleted_count + affected_count;
    END LOOP;

    -- Clean up empty threads (no messages left)
    DELETE FROM threads
    WHERE id NOT IN (SELECT DISTINCT thread_id FROM messages)
      AND created_at < NOW() - interval '1 day';

    -- Clean up old audit logs (90 days for all plans)
    DELETE FROM audit_log WHERE created_at < NOW() - interval '90 days';

    -- Clean up old webhook deliveries (30 days)
    DELETE FROM webhook_deliveries WHERE created_at < NOW() - interval '30 days';

    -- Clean up expired rate limit windows
    DELETE FROM rate_limit_state
    WHERE window_start + (window_seconds || ' seconds')::interval < NOW();

    RETURN deleted_count;
END;
$$;

-- Reset daily usage counters (run at midnight UTC)
CREATE OR REPLACE FUNCTION reset_daily_rate_limits()
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM rate_limit_state
    WHERE window_start < NOW() - interval '1 day';
END;
$$;


-- ============================================================================
-- 12. USEFUL VIEWS
-- ============================================================================

-- Active agents with their thread count and unread count
CREATE OR REPLACE VIEW agent_overview AS
SELECT
    a.id                AS agent_id,
    a.user_id,
    a.display_name,
    a.created_at,
    a.last_seen_at,
    COUNT(DISTINCT tp.thread_id) AS thread_count,
    COALESCE(SUM(ms.unread_count), 0) AS total_unread
FROM agents a
LEFT JOIN thread_participants tp ON tp.agent_id = a.id
LEFT JOIN mailbox_state ms ON ms.agent_id = a.id AND ms.unread_count > 0
GROUP BY a.id, a.user_id, a.display_name, a.created_at, a.last_seen_at;

-- Thread activity summary
CREATE OR REPLACE VIEW thread_overview AS
SELECT
    t.id                AS thread_id,
    t.user_id,
    t.subject,
    t.is_archived,
    t.created_at,
    t.updated_at,
    COUNT(m.id)         AS message_count,
    MAX(m.timestamp)    AS last_message_ts,
    (SELECT array_agg(tp2.agent_id ORDER BY tp2.agent_id)
     FROM thread_participants tp2
     WHERE tp2.thread_id = t.id AND tp2.role = 'visible'
    )                   AS participants,
    ts.decision_count,
    ts.question_count
FROM threads t
LEFT JOIN messages m ON m.thread_id = t.id
LEFT JOIN thread_summaries ts ON ts.thread_id = t.id
GROUP BY t.id, t.user_id, t.subject, t.is_archived, t.created_at,
         t.updated_at, ts.decision_count, ts.question_count;

-- User usage dashboard
CREATE OR REPLACE VIEW user_usage_dashboard AS
SELECT
    u.id                AS user_id,
    u.email,
    u.plan,
    pl.max_agents,
    pl.max_messages_per_day,
    pl.max_threads,
    pl.retention_days,
    (SELECT COUNT(*) FROM agents a WHERE a.user_id = u.id)
                        AS agents_used,
    (SELECT COUNT(*) FROM threads t WHERE t.user_id = u.id)
                        AS threads_used,
    (SELECT COALESCE(SUM(um.count), 0)
     FROM usage_metrics um
     WHERE um.user_id = u.id
       AND um.metric = 'messages_sent'
       AND um.period_start = CURRENT_DATE
    )                   AS messages_today,
    (SELECT COUNT(*) FROM api_keys ak
     WHERE ak.user_id = u.id AND ak.revoked_at IS NULL
    )                   AS active_keys
FROM users u
JOIN plan_limits pl ON pl.plan = u.plan;


-- ============================================================================
-- Migration 005: agent git / version control (shipped in v0.4.x)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_commits (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  parent_id TEXT REFERENCES agent_commits(id),
  branch TEXT NOT NULL DEFAULT 'main',
  message TEXT NOT NULL DEFAULT '',
  snapshot JSONB NOT NULL,
  snapshot_hash TEXT NOT NULL,
  node_count INTEGER NOT NULL DEFAULT 0,
  index_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_commits_agent
  ON agent_commits(agent_id, created_at DESC);

-- ============================================================================
-- Migration 006: thread participants_hash for TOCTOU prevention
-- ============================================================================

ALTER TABLE threads ADD COLUMN IF NOT EXISTS participants_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_participants_hash
  ON threads(participants_hash, user_id) NULLS NOT DISTINCT
  WHERE participants_hash IS NOT NULL;

-- ============================================================================
-- DONE
-- ============================================================================
-- 
-- Self-hosted mode:
--   - user_id columns are NULL throughout
--   - RLS policies pass (IS NULL clauses)
--   - No billing, no usage metering, no API key table used
--   - Only tables used: agents, threads, thread_participants,
--     messages, mailbox_state, thread_summaries
--
-- Cloud mode (CLOUD_MODE=true):
--   - user_id set on agents + threads at creation time
--   - RLS enforces tenant isolation
--   - API key auth via api_keys table
--   - Usage tracked in usage_metrics
--   - Plan limits enforced via plan_limits reference table
--   - Billing via billing_customers (Stripe)
--   - Webhooks, audit log active
--   - Retention cleanup via cleanup_expired_messages()
--
-- Migration strategy:
--   - Add new migrations to schema_migrations table
--   - Each migration is idempotent (IF NOT EXISTS everywhere)
--   - Use ALTER TABLE ADD COLUMN IF NOT EXISTS for schema evolution
--   - Never DROP columns in production — deprecate with comments
-- ============================================================================
