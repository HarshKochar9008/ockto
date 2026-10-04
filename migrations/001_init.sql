-- PaperTrail schema. Runs on Tiger Data (Tiger Cloud) or any PostgreSQL 16+ with pgvector.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,                -- stored lowercased
    name          text NOT NULL,
    password_hash text NOT NULL,                       -- scrypt$N$r$p$salt$hash
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,                       -- sha256 of the cookie value; the token itself is never stored
    user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE workspaces (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
    name                      text NOT NULL,
    process_type              text NOT NULL DEFAULT 'university_application',
    institution               text,
    deadline                  date,
    notes                     text,
    status                    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    requirements_confirmed_at timestamptz,
    assessment_version        int  NOT NULL DEFAULT 0,  -- last analysis version handed out
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workspaces (user_id, updated_at DESC);

-- File bytes and extracted text live in object storage; this row holds references and state.
CREATE TABLE documents (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id             uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    role                     text NOT NULL CHECK (role IN ('requirements', 'evidence')),
    filename                 text NOT NULL,
    storage_key              text NOT NULL,
    mime_type                text NOT NULL,
    size_bytes               int  NOT NULL,
    checksum                 text NOT NULL,             -- sha256: duplicate uploads return the existing row
    classification           text,
    summary                  text,
    document_date            date,
    expiry_date              date,
    page_count               int,
    processing_status        text NOT NULL DEFAULT 'queued'
                             CHECK (processing_status IN ('queued', 'processing', 'ready', 'failed')),
    processing_error         text,
    extracted_text_reference text,                      -- storage key of {pages: string[]}
    indexed_at               timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, checksum)
);
CREATE INDEX ON documents (workspace_id, created_at DESC);

CREATE TABLE requirements (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    title              text NOT NULL,
    description        text NOT NULL DEFAULT '',
    required           boolean NOT NULL DEFAULT true,
    due_date           date,
    source_document_id uuid REFERENCES documents ON DELETE SET NULL,
    source_page        int,
    source_excerpt     text,
    ambiguity          text,                            -- why a human should double-check this one
    origin             text NOT NULL CHECK (origin IN ('ai', 'user')),
    confirmed          boolean NOT NULL DEFAULT false,  -- only confirmed requirements are analysed
    version            int NOT NULL DEFAULT 1,          -- bumped on every edit
    position           int NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON requirements (workspace_id, position);
CREATE INDEX ON requirements (source_document_id);

-- Current state per requirement. `status` is what the user sees: the AI status,
-- unless the user verified/overrode it. Past evidence stays in evidence_matches by version.
CREATE TABLE checklist_items (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requirement_id      uuid NOT NULL UNIQUE REFERENCES requirements ON DELETE CASCADE,
    status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'satisfied', 'needs_review', 'missing', 'expired', 'not_applicable')),
    ai_status           text
                        CHECK (ai_status IN ('satisfied', 'needs_review', 'missing', 'expired', 'not_applicable')),
    explanation         text,
    review_reason       text,
    user_verified       boolean NOT NULL DEFAULT false,
    user_note           text,
    assessment_version  int NOT NULL DEFAULT 0,
    requirement_version int,
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_chunks (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    chunk_index  int  NOT NULL,
    page_number  int,
    content      text NOT NULL,
    tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
    embedding    vector(768) NOT NULL,                  -- embeddinggemma / nomic-embed-text size
    metadata     jsonb NOT NULL DEFAULT '{}',
    UNIQUE (document_id, chunk_index)
);
CREATE INDEX ON document_chunks (workspace_id);
CREATE INDEX ON document_chunks USING gin (tsv);
CREATE INDEX ON document_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE evidence_matches (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checklist_item_id  uuid NOT NULL REFERENCES checklist_items ON DELETE CASCADE,
    document_id        uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
    chunk_id           uuid REFERENCES document_chunks ON DELETE SET NULL,
    page_number        int,
    excerpt            text NOT NULL,                   -- verified to occur in the cited passage
    match_explanation  text,
    confidence         real,
    assessment_version int  NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON evidence_matches (checklist_item_id, assessment_version);
CREATE INDEX ON evidence_matches (document_id);

CREATE TABLE tasks (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    checklist_item_id uuid REFERENCES checklist_items ON DELETE SET NULL,
    title             text NOT NULL,
    notes             text,
    due_at            timestamptz,
    status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
    origin            text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'analysis')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tasks (workspace_id, status, due_at);
CREATE UNIQUE INDEX ON tasks (checklist_item_id) WHERE origin = 'analysis';

CREATE TABLE reminders (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id              uuid NOT NULL REFERENCES tasks ON DELETE CASCADE,
    scheduled_at         timestamptz NOT NULL,
    channel              text,                          -- set on delivery: in_app | webhook
    delivery_status      text NOT NULL DEFAULT 'scheduled'
                         CHECK (delivery_status IN ('scheduled', 'sent', 'suppressed', 'cancelled', 'failed')),
    detail               text,
    idempotency_key      text NOT NULL UNIQUE,
    temporal_workflow_id text NOT NULL,
    sent_at              timestamptz
);
CREATE INDEX ON reminders (task_id, scheduled_at);

CREATE TABLE workflow_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    workflow_id        text NOT NULL UNIQUE,
    workflow_type      text NOT NULL,
    subject_id         uuid,                            -- document / task the run is about
    status             text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
    started_at         timestamptz NOT NULL DEFAULT now(),
    completed_at       timestamptz,
    last_error_summary text
);
CREATE INDEX ON workflow_runs (workspace_id, started_at DESC);
CREATE INDEX ON workflow_runs (subject_id);

-- One row per activity attempt, written by the worker's activity interceptor.
CREATE TABLE workflow_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id     text NOT NULL REFERENCES workflow_runs (workflow_id) ON DELETE CASCADE,
    activity        text NOT NULL,
    attempt         int  NOT NULL,
    outcome         text NOT NULL CHECK (outcome IN ('completed', 'failed')),
    duration_ms     int  NOT NULL,
    error_summary   text,
    will_retry      boolean,
    sentry_event_id text,
    trace_id        text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON workflow_events (workflow_id, id);

-- Who changed what. Metadata holds ids and statuses, never document text or secrets.
CREATE TABLE audit_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
    actor_type   text NOT NULL CHECK (actor_type IN ('user', 'system', 'ai')),
    actor_id     uuid,
    event_type   text NOT NULL,
    entity_type  text NOT NULL,
    entity_id    uuid,
    metadata     jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (workspace_id, created_at DESC);
