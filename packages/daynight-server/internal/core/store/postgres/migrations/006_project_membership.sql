CREATE SEQUENCE project_member_versions AS bigint;
CREATE TABLE project_members (
    project_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    version bigint NOT NULL DEFAULT nextval('project_member_versions') CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user ON project_members (user_id, project_id);
CREATE TABLE project_invitations (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    created_by uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
    consumed_by uuid,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK ((consumed_by IS NULL) = (consumed_at IS NULL)),
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX project_invitations_project ON project_invitations (project_id, created_at, id);
CREATE INDEX project_invitations_expiry ON project_invitations (project_id, expires_at);
