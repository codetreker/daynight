-- One persistent row serializes all transfer creation and capacity changes
-- across service instances. It is not a lease for filesystem operations.
CREATE TABLE private_transfer_ledger (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    outstanding_bytes bigint NOT NULL DEFAULT 0 CHECK (outstanding_bytes >= 0 AND outstanding_bytes <= reserved_bytes)
);
INSERT INTO private_transfer_ledger (singleton) VALUES (true);

-- Do not reference the authority, user or Task with cascading foreign keys:
-- deletion or revocation must not orphan private objects and their accounting.
CREATE TABLE private_transfers (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL,
    authority_kind text NOT NULL CHECK (authority_kind IN ('pat', 'oauth')),
    authority_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('upload', 'download')),
    project_id uuid NOT NULL,
    task_id uuid NOT NULL,
    path text NOT NULL,
    content_type text NOT NULL,
    binding jsonb NOT NULL,
    data jsonb NOT NULL,
    state text NOT NULL CHECK (length(state) > 0),
    cleanup_from_state text,
    reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
    outstanding_bytes bigint NOT NULL DEFAULT 0 CHECK (outstanding_bytes >= 0 AND outstanding_bytes <= reserved_bytes),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    hard_expires_at timestamptz NOT NULL,
    lease_until timestamptz,
    retain_until timestamptz,
    last_cleanup_attempt timestamptz,
    CHECK (expires_at <= hard_expires_at),
    CHECK ((state IN ('cleanup_pending', 'closed')) = (cleanup_from_state IS NOT NULL)),
    CHECK (state <> 'closed' OR (reserved_bytes = 0 AND retain_until IS NOT NULL))
);
CREATE INDEX private_transfers_owner_active ON private_transfers (user_id) WHERE state <> 'closed';
CREATE INDEX private_transfers_expiry ON private_transfers (expires_at) WHERE state <> 'closed';
CREATE INDEX private_transfers_retention ON private_transfers (retain_until) WHERE state = 'closed';
CREATE INDEX private_transfers_cleanup_pending ON private_transfers (created_at) WHERE state = 'cleanup_pending';
