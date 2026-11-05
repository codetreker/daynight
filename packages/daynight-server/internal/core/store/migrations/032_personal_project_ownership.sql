DO $$
DECLARE invalid_ids text;
BEGIN
    SELECT string_agg(project_id::text, ', ' ORDER BY project_id) INTO invalid_ids FROM (
        SELECT DISTINCT m.project_id FROM project_members m
        LEFT JOIN projects p ON p.id=m.project_id LEFT JOIN users u ON u.id=m.user_id
        WHERE p.id IS NULL OR u.id IS NULL
        UNION
        SELECT i.project_id FROM project_invitations i
        LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN users creator ON creator.id=i.created_by
        LEFT JOIN users consumer ON consumer.id=i.consumed_by
        WHERE p.id IS NULL OR creator.id IS NULL OR (i.consumed_by IS NOT NULL AND consumer.id IS NULL)
    ) invalid;
    IF invalid_ids IS NOT NULL THEN
        RAISE EXCEPTION 'Project references are invalid: %', invalid_ids;
    END IF;
    SELECT string_agg(p.id::text, ', ' ORDER BY p.id) INTO invalid_ids FROM projects p
    WHERE NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=p.id AND m.role='admin');
    IF invalid_ids IS NOT NULL THEN
        RAISE EXCEPTION 'Projects have no current admin: %', invalid_ids;
    END IF;
END $$;

CREATE TABLE teams (
    id uuid PRIMARY KEY,
    personal_user_id uuid UNIQUE,
    name text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK ((personal_user_id IS NOT NULL AND name IS NULL) OR (personal_user_id IS NULL AND name IS NOT NULL))
);
CREATE SEQUENCE team_member_versions AS bigint;
CREATE TABLE team_members (
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'member')),
    version bigint NOT NULL DEFAULT nextval('team_member_versions') CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id, team_id);
CREATE TABLE project_ownership (
    project_id uuid PRIMARY KEY,
    team_id uuid NOT NULL,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX project_ownership_team ON project_ownership (team_id, project_id);

INSERT INTO teams (id,personal_user_id) SELECT gen_random_uuid(),id FROM users ORDER BY id;
INSERT INTO team_members (team_id,user_id,role)
SELECT id,personal_user_id,'admin' FROM teams ORDER BY personal_user_id;

ALTER TABLE project_members RENAME TO project_grants;
ALTER SEQUENCE project_member_versions RENAME TO project_grant_versions;
ALTER TABLE project_grants RENAME CONSTRAINT project_members_pkey TO project_grants_pkey;
ALTER TABLE project_grants RENAME CONSTRAINT project_members_role_check TO project_grants_role_check;
ALTER TABLE project_grants RENAME CONSTRAINT project_members_version_check TO project_grants_version_check;
ALTER INDEX project_members_user RENAME TO project_grants_user;

INSERT INTO project_ownership (project_id,team_id)
SELECT earliest.project_id,t.id FROM (
    SELECT DISTINCT ON (project_id) project_id,user_id FROM project_grants
    WHERE role='admin' ORDER BY project_id,created_at,user_id
) earliest JOIN teams t ON t.personal_user_id=earliest.user_id;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM projects p LEFT JOIN project_ownership o ON o.project_id=p.id
        LEFT JOIN teams t ON t.id=o.team_id LEFT JOIN users u ON u.id=t.personal_user_id
        WHERE o.project_id IS NULL OR t.id IS NULL OR u.id IS NULL)
        OR EXISTS (SELECT 1 FROM users u LEFT JOIN teams t ON t.personal_user_id=u.id
            WHERE t.id IS NULL)
        OR EXISTS (SELECT 1 FROM teams t LEFT JOIN team_members m ON m.team_id=t.id
            GROUP BY t.id,t.personal_user_id HAVING count(m.user_id)<>1
                OR bool_and(m.user_id=t.personal_user_id AND m.role='admin') IS NOT TRUE) THEN
        RAISE EXCEPTION 'Personal ownership backfill is incomplete';
    END IF;
END $$;
