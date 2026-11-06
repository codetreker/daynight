ALTER TABLE users
    ADD COLUMN name_bytes bytea,
    ADD COLUMN email_bytes bytea,
    ADD COLUMN avatar_url_bytes bytea;
ALTER TABLE teams ADD COLUMN name_bytes bytea;
ALTER TABLE projects ADD COLUMN name_bytes bytea, ADD COLUMN repo_url_bytes bytea;

ALTER TABLE users
    ALTER COLUMN name_bytes SET STORAGE EXTERNAL,
    ALTER COLUMN email_bytes SET STORAGE EXTERNAL,
    ALTER COLUMN avatar_url_bytes SET STORAGE EXTERNAL;
ALTER TABLE teams ALTER COLUMN name_bytes SET STORAGE EXTERNAL;
ALTER TABLE projects
    ALTER COLUMN name_bytes SET STORAGE EXTERNAL,
    ALTER COLUMN repo_url_bytes SET STORAGE EXTERNAL;

DO $$
DECLARE after_id uuid;
BEGIN
    LOOP
        WITH batch AS (
            SELECT id FROM users WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ), changed AS (
            UPDATE users u SET name_bytes=convert_to(u.name,'UTF8'),
                email_bytes=convert_to(u.email,'UTF8'),avatar_url_bytes=convert_to(u.avatar_url,'UTF8')
                FROM batch b WHERE u.id=b.id RETURNING u.id
        )
        SELECT id INTO after_id FROM changed ORDER BY id DESC LIMIT 1;
        EXIT WHEN after_id IS NULL;
    END LOOP;
    after_id=NULL;
    LOOP
        WITH batch AS (
            SELECT id FROM teams WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ), changed AS (
            UPDATE teams t SET name_bytes=convert_to(t.name,'UTF8') FROM batch b WHERE t.id=b.id RETURNING t.id
        )
        SELECT id INTO after_id FROM changed ORDER BY id DESC LIMIT 1;
        EXIT WHEN after_id IS NULL;
    END LOOP;
    after_id=NULL;
    LOOP
        WITH batch AS (
            SELECT id FROM projects WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ), changed AS (
            UPDATE projects p SET name_bytes=convert_to(p.name,'UTF8'),repo_url_bytes=convert_to(p.repo_url,'UTF8')
                FROM batch b WHERE p.id=b.id RETURNING p.id
        )
        SELECT id INTO after_id FROM changed ORDER BY id DESC LIMIT 1;
        EXIT WHEN after_id IS NULL;
    END LOOP;
END $$;

CREATE FUNCTION maintain_user_item_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
        NEW.email_bytes=convert_to(NEW.email,'UTF8');
        NEW.avatar_url_bytes=convert_to(NEW.avatar_url,'UTF8');
        RETURN NEW;
    END IF;
    IF ROW(NEW.name,NEW.email,NEW.avatar_url) IS DISTINCT FROM ROW(OLD.name,OLD.email,OLD.avatar_url) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
    ELSIF NEW.name_bytes IS DISTINCT FROM OLD.name_bytes THEN
        RAISE EXCEPTION 'User name byte projection is derived' USING ERRCODE='23514';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email THEN
        NEW.email_bytes=convert_to(NEW.email,'UTF8');
    ELSIF NEW.email_bytes IS DISTINCT FROM OLD.email_bytes THEN
        RAISE EXCEPTION 'User email byte projection is derived' USING ERRCODE='23514';
    END IF;
    IF NEW.avatar_url IS DISTINCT FROM OLD.avatar_url THEN
        NEW.avatar_url_bytes=convert_to(NEW.avatar_url,'UTF8');
    ELSIF NEW.avatar_url_bytes IS DISTINCT FROM OLD.avatar_url_bytes THEN
        RAISE EXCEPTION 'User avatar byte projection is derived' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER users_item_bytes BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION maintain_user_item_bytes();

CREATE FUNCTION maintain_team_item_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
        RETURN NEW;
    END IF;
    IF ROW(NEW.id,NEW.personal_user_id,NEW.name,NEW.version,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.personal_user_id,OLD.name,OLD.version,OLD.created_at) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
    ELSIF NEW.name_bytes IS DISTINCT FROM OLD.name_bytes THEN
        RAISE EXCEPTION 'Team name byte projection is derived' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER teams_item_bytes BEFORE INSERT OR UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION maintain_team_item_bytes();

CREATE FUNCTION maintain_project_item_bytes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='INSERT' THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
        NEW.repo_url_bytes=convert_to(NEW.repo_url,'UTF8');
        RETURN NEW;
    END IF;
    IF ROW(NEW.id,NEW.name,NEW.repo_url,NEW.created_at,NEW.settings_version,NEW.execution_warning_minutes,NEW.deleted_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.name,OLD.repo_url,OLD.created_at,OLD.settings_version,OLD.execution_warning_minutes,OLD.deleted_at) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
        NEW.name_bytes=convert_to(NEW.name,'UTF8');
    ELSIF NEW.name_bytes IS DISTINCT FROM OLD.name_bytes THEN
        RAISE EXCEPTION 'Project name byte projection is derived' USING ERRCODE='23514';
    END IF;
    IF NEW.repo_url IS DISTINCT FROM OLD.repo_url THEN
        NEW.repo_url_bytes=convert_to(NEW.repo_url,'UTF8');
    ELSIF NEW.repo_url_bytes IS DISTINCT FROM OLD.repo_url_bytes THEN
        RAISE EXCEPTION 'Project repository byte projection is derived' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER projects_item_bytes BEFORE INSERT OR UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION maintain_project_item_bytes();

CREATE FUNCTION advance_team_member_modified_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.team_id,NEW.user_id,NEW.role,NEW.version,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.team_id,OLD.user_id,OLD.role,OLD.version,OLD.created_at) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER team_members_item_time BEFORE UPDATE ON team_members
    FOR EACH ROW EXECUTE FUNCTION advance_team_member_modified_time();

CREATE FUNCTION advance_project_ownership_modified_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.project_id,NEW.team_id,NEW.version) IS DISTINCT FROM ROW(OLD.project_id,OLD.team_id,OLD.version) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER project_ownership_item_time BEFORE UPDATE ON project_ownership
    FOR EACH ROW EXECUTE FUNCTION advance_project_ownership_modified_time();

ALTER TABLE users
    ADD CONSTRAINT users_name_bytes_presence CHECK ((name IS NULL)=(name_bytes IS NULL)),
    ADD CONSTRAINT users_email_bytes_presence CHECK ((email IS NULL)=(email_bytes IS NULL)),
    ADD CONSTRAINT users_avatar_bytes_presence CHECK ((avatar_url IS NULL)=(avatar_url_bytes IS NULL));
ALTER TABLE teams ADD CONSTRAINT teams_name_bytes_presence CHECK ((name IS NULL)=(name_bytes IS NULL));
ALTER TABLE projects ALTER COLUMN name_bytes SET NOT NULL, ALTER COLUMN repo_url_bytes SET NOT NULL;
