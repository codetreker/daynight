CREATE TABLE github_apps (
    id uuid PRIMARY KEY,
    github_app_id bigint NOT NULL,
    name text NOT NULL,
    github_name text NOT NULL,
    github_slug text NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    credential_version bigint NOT NULL DEFAULT 1,
    impact_version bigint NOT NULL DEFAULT 1,
    private_key_pem bytea,
    webhook_secret bytea,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    deleted_at timestamptz
);
CREATE UNIQUE INDEX github_apps_live_github_app_id ON github_apps (github_app_id) WHERE deleted_at IS NULL;

CREATE SEQUENCE github_app_admin_versions AS bigint;
CREATE TABLE github_app_admins (
    app_resource_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version bigint NOT NULL DEFAULT nextval('github_app_admin_versions'),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (app_resource_id, user_id)
);
CREATE INDEX github_app_admins_user ON github_app_admins (user_id, app_resource_id);

CREATE TABLE github_app_admin_invitations (
    id uuid PRIMARY KEY,
    app_resource_id uuid NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    created_by uuid NOT NULL,
    issuer_membership_version bigint NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    consumed_at timestamptz,
    consumed_by uuid
);
CREATE INDEX github_app_admin_invitations_app ON github_app_admin_invitations (app_resource_id, created_at, id);

CREATE TABLE github_app_team_grants (
    id uuid PRIMARY KEY,
    app_resource_id uuid NOT NULL,
    team_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    revoked_at timestamptz
);
CREATE UNIQUE INDEX github_app_team_grants_live ON github_app_team_grants (app_resource_id, team_id) WHERE revoked_at IS NULL;
CREATE INDEX github_app_team_grants_team ON github_app_team_grants (team_id, app_resource_id) WHERE revoked_at IS NULL;

ALTER TABLE project_github ADD COLUMN app_resource_id uuid;
ALTER TABLE project_github ADD COLUMN team_grant_id uuid;
ALTER TABLE project_github ADD COLUMN credential_version bigint;
ALTER TABLE project_github DROP CONSTRAINT project_github_sync_requires_connection;
CREATE INDEX project_github_app_resource ON project_github (app_resource_id, project_id);
CREATE INDEX project_github_team_grant ON project_github (team_grant_id, project_id);
