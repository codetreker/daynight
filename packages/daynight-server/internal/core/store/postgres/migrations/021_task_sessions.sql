CREATE TABLE task_sessions (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES projects(id),
 task_id uuid NOT NULL,
 claim_id uuid NOT NULL,
 owner_user_id uuid NOT NULL,
 registration_id uuid NOT NULL,
 registration jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 source_epoch uuid,
 source_epochs uuid[] NOT NULL DEFAULT '{}',
 last_source_seq bigint NOT NULL DEFAULT 0,
 last_operation_seq bigint NOT NULL DEFAULT 0,
 server_instance uuid,
 connected_at timestamptz,
 last_seen timestamptz,
 grant_hash bytea,
 grant_expires_at timestamptz,
 grant_kind text,
 grant_consumed boolean NOT NULL DEFAULT false,
 parent_credential_id uuid,
 connection_expires_at timestamptz,
 stop_proof jsonb,
 draining_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 UNIQUE(project_id, task_id, claim_id),
 UNIQUE(project_id, registration_id),
 FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE session_events (
 session_id uuid NOT NULL REFERENCES task_sessions(id),
 event_seq bigint NOT NULL,
 source_epoch uuid,
 source_seq bigint,
 batch_id uuid,
 source_body jsonb,
 event jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(session_id,event_seq),
 UNIQUE(session_id,source_epoch,source_seq)
);
CREATE TABLE session_timeline (
 session_id uuid NOT NULL REFERENCES task_sessions(id),
 entry_id uuid NOT NULL,
 entry_seq bigint NOT NULL,
 revision bigint NOT NULL,
 entry jsonb NOT NULL,
 PRIMARY KEY(session_id,entry_id),
 UNIQUE(session_id,entry_seq)
);
CREATE TABLE session_operations (
 session_id uuid NOT NULL REFERENCES task_sessions(id),
 operation_id uuid NOT NULL,
 operation_seq bigint NOT NULL,
 body_hash bytea NOT NULL,
 command jsonb NOT NULL,
 actor_user_id uuid NOT NULL,
 credential_id uuid NOT NULL,
 credential_kind text NOT NULL,
 receipt jsonb NOT NULL,
 dispatch_epoch bigint,
 created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 deadline timestamptz NOT NULL DEFAULT statement_timestamp() + interval '30 seconds',
 PRIMARY KEY(session_id,operation_id),
 UNIQUE(session_id,operation_seq)
);
CREATE TABLE session_resources (
 session_id uuid NOT NULL REFERENCES task_sessions(id),
 resource_id uuid NOT NULL,
 descriptor jsonb NOT NULL,
 content bytea,
 PRIMARY KEY(session_id,resource_id),
 CHECK (content IS NULL OR octet_length(content) <= 8388608)
);
CREATE INDEX session_operations_pending ON session_operations(session_id,operation_seq) WHERE receipt->>'state'='accepted';
