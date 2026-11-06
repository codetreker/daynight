-- Each field has its own row to avoid combining large source and derived values
-- in a single tuple before TOAST storage is applied.
CREATE TABLE team_item_fields (
    kind text NOT NULL,
    object_id uuid NOT NULL,
    field text NOT NULL,
    content bytea,
    PRIMARY KEY (kind,object_id,field),
    CHECK ((kind='member' AND field IN ('profile.name','profile.email','profile.avatarUrl'))
        OR (kind='team' AND field='name')
        OR (kind='project' AND field IN ('name','repoUrl')))
);
ALTER TABLE team_item_fields ALTER COLUMN content SET STORAGE EXTERNAL;

LOCK TABLE users,teams,projects IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE after_id uuid; batch_ids uuid[];
BEGIN
    LOOP
        SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
            SELECT id FROM users WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ) batch;
        EXIT WHEN batch_ids IS NULL;
        INSERT INTO team_item_fields SELECT 'member',id,'profile.name',convert_to(name,'UTF8') FROM users WHERE id=ANY(batch_ids);
        INSERT INTO team_item_fields SELECT 'member',id,'profile.email',convert_to(email,'UTF8') FROM users WHERE id=ANY(batch_ids);
        INSERT INTO team_item_fields SELECT 'member',id,'profile.avatarUrl',convert_to(avatar_url,'UTF8') FROM users WHERE id=ANY(batch_ids);
        after_id=batch_ids[array_length(batch_ids,1)];
    END LOOP;
    after_id=NULL;
    LOOP
        SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
            SELECT id FROM teams WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ) batch;
        EXIT WHEN batch_ids IS NULL;
        INSERT INTO team_item_fields SELECT 'team',id,'name',convert_to(name,'UTF8') FROM teams WHERE id=ANY(batch_ids);
        after_id=batch_ids[array_length(batch_ids,1)];
    END LOOP;
    after_id=NULL;
    LOOP
        SELECT array_agg(id ORDER BY id) INTO batch_ids FROM (
            SELECT id FROM projects WHERE after_id IS NULL OR id>after_id ORDER BY id LIMIT 256
        ) batch;
        EXIT WHEN batch_ids IS NULL;
        INSERT INTO team_item_fields SELECT 'project',id,'name',convert_to(name,'UTF8') FROM projects WHERE id=ANY(batch_ids);
        INSERT INTO team_item_fields SELECT 'project',id,'repoUrl',convert_to(repo_url,'UTF8') FROM projects WHERE id=ANY(batch_ids);
        after_id=batch_ids[array_length(batch_ids,1)];
    END LOOP;
END $$;

CREATE FUNCTION advance_user_item_modified_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.name,NEW.email,NEW.avatar_url) IS DISTINCT FROM ROW(OLD.name,OLD.email,OLD.avatar_url) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER users_item_time BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION advance_user_item_modified_time();

CREATE FUNCTION advance_team_item_modified_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.personal_user_id,NEW.name,NEW.version,NEW.created_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.personal_user_id,OLD.name,OLD.version,OLD.created_at) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER teams_item_time BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION advance_team_item_modified_time();

CREATE FUNCTION advance_project_item_modified_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.name,NEW.repo_url,NEW.created_at,NEW.settings_version,NEW.execution_warning_minutes,NEW.deleted_at)
        IS DISTINCT FROM ROW(OLD.id,OLD.name,OLD.repo_url,OLD.created_at,OLD.settings_version,OLD.execution_warning_minutes,OLD.deleted_at) THEN
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at+interval '1 microsecond');
    ELSE
        NEW.updated_at=GREATEST(NEW.updated_at,OLD.updated_at);
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER projects_item_time BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION advance_project_item_modified_time();

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

CREATE FUNCTION maintain_user_item_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        DELETE FROM team_item_fields WHERE kind='member' AND object_id=OLD.id;
        RETURN NULL;
    END IF;
    IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
        DELETE FROM team_item_fields WHERE kind='member' AND object_id=OLD.id;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name THEN
        INSERT INTO team_item_fields VALUES('member',NEW.id,'profile.name',convert_to(NEW.name,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.email IS DISTINCT FROM OLD.email THEN
        INSERT INTO team_item_fields VALUES('member',NEW.id,'profile.email',convert_to(NEW.email,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.avatar_url IS DISTINCT FROM OLD.avatar_url THEN
        INSERT INTO team_item_fields VALUES('member',NEW.id,'profile.avatarUrl',convert_to(NEW.avatar_url,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER users_item_fields AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION maintain_user_item_fields();

CREATE FUNCTION maintain_team_item_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        DELETE FROM team_item_fields WHERE kind='team' AND object_id=OLD.id;
        RETURN NULL;
    END IF;
    IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
        DELETE FROM team_item_fields WHERE kind='team' AND object_id=OLD.id;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name THEN
        INSERT INTO team_item_fields VALUES('team',NEW.id,'name',convert_to(NEW.name,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER teams_item_fields AFTER INSERT OR UPDATE OR DELETE ON teams
    FOR EACH ROW EXECUTE FUNCTION maintain_team_item_fields();

CREATE FUNCTION maintain_project_item_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        DELETE FROM team_item_fields WHERE kind='project' AND object_id=OLD.id;
        RETURN NULL;
    END IF;
    IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
        DELETE FROM team_item_fields WHERE kind='project' AND object_id=OLD.id;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.name IS DISTINCT FROM OLD.name THEN
        INSERT INTO team_item_fields VALUES('project',NEW.id,'name',convert_to(NEW.name,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    IF TG_OP='INSERT' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.repo_url IS DISTINCT FROM OLD.repo_url THEN
        INSERT INTO team_item_fields VALUES('project',NEW.id,'repoUrl',convert_to(NEW.repo_url,'UTF8'))
            ON CONFLICT(kind,object_id,field) DO UPDATE SET content=EXCLUDED.content;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER projects_item_fields AFTER INSERT OR UPDATE OR DELETE ON projects
    FOR EACH ROW EXECUTE FUNCTION maintain_project_item_fields();

CREATE FUNCTION truncate_team_item_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM team_item_fields WHERE kind=TG_ARGV[0];
    RETURN NULL;
END $$;
CREATE TRIGGER users_item_fields_truncate AFTER TRUNCATE ON users
    FOR EACH STATEMENT EXECUTE FUNCTION truncate_team_item_fields('member');
CREATE TRIGGER teams_item_fields_truncate AFTER TRUNCATE ON teams
    FOR EACH STATEMENT EXECUTE FUNCTION truncate_team_item_fields('team');
CREATE TRIGGER projects_item_fields_truncate AFTER TRUNCATE ON projects
    FOR EACH STATEMENT EXECUTE FUNCTION truncate_team_item_fields('project');

-- Source maintenance enters at depth one; projection writes are nested. This
-- rejects independent DML without rereading an arbitrarily large source value.
CREATE FUNCTION guard_team_item_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth()<2 THEN
        RAISE EXCEPTION 'Team item byte projections are source-owned' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN
        RETURN OLD;
    END IF;
    IF TG_OP='TRUNCATE' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER team_item_fields_source_owned BEFORE INSERT OR UPDATE OR DELETE ON team_item_fields
    FOR EACH ROW EXECUTE FUNCTION guard_team_item_fields();

CREATE TRIGGER team_item_fields_source_owned_truncate BEFORE TRUNCATE ON team_item_fields
    FOR EACH STATEMENT EXECUTE FUNCTION guard_team_item_fields();
