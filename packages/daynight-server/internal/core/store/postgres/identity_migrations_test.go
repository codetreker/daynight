package postgres

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMicrosoftIdentityMigrationPreservesAccountAndOwnership(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:63]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	for index, identity := range []string{"microsoft:tenant:object", "msft:existing@tenant", "google:123", "github:123"} {
		mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Retained profile',now(),now())`, queryID(index+1), identity)
	}
	mustQueryExec(t, s, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, queryID(10), queryID(1))
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, queryID(10), queryID(1))
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Retained project','https://example.test/retained')`, queryID(20))
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, queryID(20), queryID(10))
	mustQueryExec(t, s, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, queryID(20), queryID(1))
	mustQueryExec(t, s, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, queryID(30), queryID(1), deviceStoreHash("retained-session"))
	mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'Retained token',now())`, queryID(31), queryID(1), deviceStoreHash("retained-pat"))
	beforeRows := microsoftIdentityRows(t, pool, true)
	beforeOwnership := microsoftIdentityOwnership(t, pool)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := microsoftIdentityRows(t, pool, true); after != beforeRows {
		t.Fatalf("migration changed user fields beyond the identity key: before=%s after=%s", beforeRows, after)
	}
	if after := microsoftIdentityOwnership(t, pool); after != beforeOwnership {
		t.Fatal("migration changed account credentials or ownership")
	}
	var tokenDescriptionNull bool
	if err := pool.QueryRow(ctx, `SELECT description IS NULL FROM personal_access_tokens WHERE id=$1`, queryID(31)).Scan(&tokenDescriptionNull); err != nil || !tokenDescriptionNull {
		t.Fatalf("historical token description is not null: %v", err)
	}
	var repositoryVersion int64
	if err := pool.QueryRow(ctx, `SELECT repository_version FROM projects WHERE id=$1`, queryID(20)).Scan(&repositoryVersion); err != nil || repositoryVersion != 1 {
		t.Fatalf("migrated repository version: %d %v", repositoryVersion, err)
	}
	assertMicrosoftSessionLegacyFieldsUnset(t, pool)
	var identities []string
	if err := pool.QueryRow(ctx, `SELECT array_agg(uniauth_id ORDER BY id) FROM users`).Scan(&identities); err != nil {
		t.Fatal(err)
	}
	want := []string{"msft:object@tenant", "msft:existing@tenant", "google:123", "github:123"}
	for index := range want {
		if identities[index] != want[index] {
			t.Fatalf("migrated identities=%v want=%v", identities, want)
		}
	}
	for _, input := range []string{"microsoft:tenant:object", "msft:object@tenant"} {
		canonical, err := core.CanonicalUniAuthID(input)
		if err != nil {
			t.Fatal(err)
		}
		err = testIdentityWrite(s, ctx, func(scope store.IdentityScope) error {
			updated, err := scope.IdentityDAO().UpsertUser(ctx, model.User{ID: queryID(50), UniAuthID: canonical}, time.Now().UTC())
			if err != nil {
				return err
			}
			if updated.ID != queryID(1) || updated.UniAuthID != want[0] {
				t.Fatalf("login created another account: %+v", updated)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if after := microsoftIdentityOwnership(t, pool); after != beforeOwnership {
		t.Fatal("subsequent login changed account credentials or ownership")
	}
	assertMicrosoftSessionLegacyFieldsUnset(t, pool)
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		token := "retained-session"
		if kind == model.PATCredential {
			token = "retained-pat"
		}
		principal, err := testAuthenticate(s, ctx, kind, deviceStoreHash(token), time.Now().UTC())
		if err != nil || principal.UserID != queryID(1) {
			t.Fatalf("retained credential no longer authenticates original user: %+v %v", principal, err)
		}
	}
	beforeRepeat := microsoftIdentityRows(t, pool, false)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := microsoftIdentityRows(t, pool, false); after != beforeRepeat {
		t.Fatal("repeated migration changed accounts")
	}
	assertMicrosoftSessionLegacyFieldsUnset(t, pool)
}

func TestMicrosoftIdentityMigrationRejectsInvalidOrCollidingKeysAtomically(t *testing.T) {
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, schemaMigrations[:63]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	for index, identity := range []string{"microsoft:tenant:object", "microsoft:tenant:another"} {
		mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, queryID(index+1), identity)
	}
	readLedger := func(t *testing.T) string {
		t.Helper()
		var result string
		if err := pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	initialAccounts, ledger := microsoftIdentityRows(t, pool, false), readLedger(t)

	for _, test := range []struct {
		name, invalid, code string
	}{
		{"missing old component", "microsoft:tenant", "P1064"},
		{"ambiguous old component", "microsoft:tenant:object@extra", "P1064"},
		{"missing standard component", "msft:@tenant", "P1064"},
		{"ambiguous standard component", "msft:object@tenant@extra", "P1064"},
		{"existing account", "msft:object@tenant", "23505"},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, queryID(3), test.invalid)
			before := microsoftIdentityRows(t, pool, false)
			err := migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != test.code {
				t.Fatalf("migration error=%v want SQLSTATE %s", err, test.code)
			}
			if after := microsoftIdentityRows(t, pool, false); after != before {
				t.Fatalf("failed migration partially changed accounts: before=%s after=%s", before, after)
			}
			if after := readLedger(t); after != ledger {
				t.Fatalf("failed migration changed the historical ledger: %s", after)
			}
			mustQueryExec(t, s, `DELETE FROM users WHERE id=$1`, queryID(3))
			if after := microsoftIdentityRows(t, pool, false); after != initialAccounts {
				t.Fatalf("account fixture was not restored: %s", after)
			}
		}) {
			return
		}
	}
}

func microsoftIdentityRows(t *testing.T, pool *pgxpool.Pool, omitKey bool) string {
	t.Helper()
	var result string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_agg(CASE WHEN $1 THEN to_jsonb(u)-'uniauth_id' ELSE to_jsonb(u) END ORDER BY id)::text FROM users u`, omitKey).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func microsoftIdentityOwnership(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var result string
	if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
 'teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),
 'members',(SELECT jsonb_agg(to_jsonb(t) ORDER BY team_id,user_id) FROM team_members t),
 'projects',(SELECT jsonb_agg(to_jsonb(t)-'tag_catalog_epoch'-'repository_identity'-'repository_version' ORDER BY id) FROM projects t),
 'ownership',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id) FROM project_ownership t),
 'grants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,user_id) FROM project_grants t),
 'sessions',(SELECT jsonb_agg(to_jsonb(t)-'preview_token_hash'-'last_used_at'-'browser'-'os' ORDER BY id) FROM sessions t),
 'tokens',(SELECT jsonb_agg(to_jsonb(t)-'last_used_at'-'description'-'business_scopes'-'scope_version' ORDER BY id) FROM personal_access_tokens t))::text`).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertMicrosoftSessionLegacyFieldsUnset(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var count int
	var previewUnset, browserUnset, osUnset bool
	if err := pool.QueryRow(t.Context(), `SELECT count(*),coalesce(bool_and(preview_token_hash IS NULL),false),coalesce(bool_and(browser IS NULL),false),coalesce(bool_and(os IS NULL),false) FROM sessions`).Scan(&count, &previewUnset, &browserUnset, &osUnset); err != nil || count != 1 || !previewUnset || !browserUnset || !osUnset {
		t.Fatalf("migrated session fields: count=%d previewUnset=%v browserUnset=%v osUnset=%v error=%v", count, previewUnset, browserUnset, osUnset, err)
	}
}

func ownershipMigrationSource(t *testing.T) *Store {
	t.Helper()
	pool := emptyPool(t)
	if err := migrate(context.Background(), pool, schemaMigrations[:31]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at)
		SELECT md5(n::text)::uuid,'migration:'||n,now(),now() FROM generate_series(1,4) n;
		INSERT INTO projects(id,name,repo_url) VALUES
		('00000000-0000-4000-8000-000000000001',' Original ','host:repo'),
		('00000000-0000-4000-8000-000000000002','Second','ssh://git@example.com/raw');
		INSERT INTO project_members(project_id,user_id,role,created_at,updated_at) VALUES
		('00000000-0000-4000-8000-000000000001',md5('1')::uuid,'member','2025-01-01Z','2025-01-01Z'),
		('00000000-0000-4000-8000-000000000001',md5('2')::uuid,'admin','2025-02-01Z','2026-03-01Z'),
		('00000000-0000-4000-8000-000000000001',md5('3')::uuid,'admin','2025-03-01Z','2025-03-01Z'),
		('00000000-0000-4000-8000-000000000002',md5('2')::uuid,'admin','2025-02-01Z','2025-02-01Z'),
		('00000000-0000-4000-8000-000000000002',md5('3')::uuid,'admin','2025-02-01Z','2025-02-01Z');
		INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at)
		VALUES(md5('pat')::uuid,md5('4')::uuid,sha256('old-pat'::bytea),'Old PAT',now());
		INSERT INTO project_invitations(id,project_id,created_by,token_hash,created_at,expires_at)
		VALUES(md5('invitation')::uuid,'00000000-0000-4000-8000-000000000001',md5('3')::uuid,
		sha256('invitation'::bytea),now(),now()+interval '7 days');
		INSERT INTO tasks(id,project_id,title,description)
		VALUES(md5('task')::uuid,'00000000-0000-4000-8000-000000000001','Unchanged','## Original Markdown');
		INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes)
		VALUES('00000000-0000-4000-8000-000000000001',md5('task')::uuid,'nested/original.md','text/markdown',123)`)
	return s
}

func ownershipMigrationFacts(t *testing.T, s *Store, grants string) map[string]string {
	t.Helper()
	result := map[string]string{}
	for _, table := range []string{"users", "projects", "tasks", "task_attachments", "project_invitations", "personal_access_tokens", grants} {
		var value string
		projection := `to_jsonb(t)`
		if table == "tasks" {
			projection = preCancellationTaskJSON
		}
		if table == "personal_access_tokens" {
			projection = `(to_jsonb(t)-'last_used_at'-'description'-'business_scopes'-'scope_version')`
		}
		if table == "projects" {
			// Later migrations add lifecycle, catalog and repository fields.
			// Compare original columns and check lifecycle after the full upgrade.
			projection = `(to_jsonb(t)-'deleted_at'-'tag_catalog_epoch'-'repository_identity'-'repository_version')`
		}
		if err := s.Pool.QueryRow(context.Background(), `SELECT coalesce(jsonb_agg(`+projection+` ORDER BY `+projection+`::text),'[]'::jsonb)::text FROM `+table+` t`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		key := table
		if table == grants {
			key = "grants"
		}
		result[key] = value
	}
	return result
}

func TestPersonalOwnershipMigrationPreservesFactsAndSequence(t *testing.T) {
	for _, called := range []bool{false, true} {
		t.Run(map[bool]string{false: "uncalled", true: "deleted-high-version"}[called], func(t *testing.T) {
			s := ownershipMigrationSource(t)
			ctx := context.Background()
			const high int64 = 9007199254740993
			mustQueryExec(t, s, `SELECT setval('project_member_versions',$1,$2)`, high, called)
			if called {
				mustQueryExec(t, s, `INSERT INTO project_members(project_id,user_id,role)
					VALUES($1,md5('4')::uuid,'member')`, queryID(1))
				mustQueryExec(t, s, `DELETE FROM project_members WHERE user_id=md5('4')::uuid`)
			}
			before := ownershipMigrationFacts(t, s, "project_members")
			var highBefore int64
			var calledBefore bool
			if err := s.Pool.QueryRow(ctx, `SELECT last_value,is_called FROM project_member_versions`).Scan(&highBefore, &calledBefore); err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, s.Pool, schemaMigrations[:32]); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, ownershipMigrationFacts(t, s, "project_grants")) {
				t.Fatal("migration changed grants, invitations, identity or project content")
			}
			if err := migrate(ctx, s.Pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, ownershipMigrationFacts(t, s, "project_grants")) {
				t.Fatal("later migrations changed retained grants, invitations, identity or project content")
			}
			var descriptionNull bool
			if err := s.Pool.QueryRow(ctx, `SELECT description IS NULL FROM personal_access_tokens WHERE id=md5('pat')::uuid`).Scan(&descriptionNull); err != nil || !descriptionNull {
				t.Fatalf("historical token description is not null: %v", err)
			}
			assertHistoricalTasksHaveNoCancellationTime(t, s)
			var allLive bool
			if err := s.Pool.QueryRow(ctx, `SELECT bool_and(deleted_at IS NULL) FROM projects`).Scan(&allLive); err != nil || !allLive {
				t.Fatalf("existing projects are not live after lifecycle migration: %v %v", allLive, err)
			}
			var projectCount int
			var versionsValid bool
			if err := s.Pool.QueryRow(ctx, `SELECT count(*),coalesce(bool_and(repository_version=1),false) FROM projects`).Scan(&projectCount, &versionsValid); err != nil || projectCount != 2 || !versionsValid {
				t.Fatalf("migrated repository versions: count=%d valid=%v error=%v", projectCount, versionsValid, err)
			}
			var catalogValid bool
			if err := s.Pool.QueryRow(ctx, `SELECT to_regclass('project_member_versions') IS NULL
				AND to_regclass('project_members_user') IS NULL AND to_regclass('project_members_pkey') IS NULL
				AND to_regclass('project_grants_user') IS NOT NULL AND to_regclass('project_grants_pkey') IS NOT NULL
				AND (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef d JOIN pg_attribute a
				ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid='project_grants'::regclass AND a.attname='version')
				= 'nextval(''project_grant_versions''::regclass)'`).Scan(&catalogValid); err != nil || !catalogValid {
				t.Fatalf("grant catalog rename incomplete: %v %v", catalogValid, err)
			}
			var highAfter int64
			var calledAfter bool
			if err := s.Pool.QueryRow(ctx, `SELECT last_value,is_called FROM project_grant_versions`).Scan(&highAfter, &calledAfter); err != nil || highAfter != highBefore || calledAfter != calledBefore {
				t.Fatalf("sequence state changed: %d %v versus %d %v: %v", highBefore, calledBefore, highAfter, calledAfter, err)
			}
			var actual, expected string
			if err := s.Pool.QueryRow(ctx, `SELECT t.personal_user_id::text,md5('2')::uuid::text
				FROM project_ownership o JOIN teams t ON t.id=o.team_id WHERE o.project_id=$1`, queryID(1)).Scan(&actual, &expected); err != nil || actual != expected {
				t.Fatalf("did not select earliest joined current admin: %s %s %v", actual, expected, err)
			}
			if err := s.Pool.QueryRow(ctx, `SELECT t.personal_user_id::text,
				(SELECT user_id::text FROM project_grants WHERE project_id=$1 ORDER BY created_at,user_id LIMIT 1)
				FROM project_ownership o JOIN teams t ON t.id=o.team_id WHERE o.project_id=$1`, queryID(2)).Scan(&actual, &expected); err != nil || actual != expected {
				t.Fatalf("equal join times are not deterministic: %s %s %v", actual, expected, err)
			}
			var users, teams, owners int
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams),
				(SELECT count(*) FROM teams t JOIN team_members m ON m.team_id=t.id AND m.user_id=t.personal_user_id AND m.role='admin')`).Scan(&users, &teams, &owners); err != nil || users != 4 || teams != users || owners != users {
				t.Fatalf("all-user Personal backfill: %d %d %d %v", users, teams, owners, err)
			}
			patHash := sha256.Sum256([]byte("old-pat"))
			if principal, err := testAuthenticate(s, ctx, model.PATCredential, patHash[:], time.Now()); err != nil || principal.UserID == "" {
				t.Fatalf("old PAT-only user's credential was not preserved: %#v %v", principal, err)
			}
			var next int64
			if err := s.Pool.QueryRow(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,md5('4')::uuid,'member') RETURNING version`, queryID(1)).Scan(&next); err != nil || (calledBefore && next <= highBefore) || (!calledBefore && next != highBefore) {
				t.Fatalf("first new version did not preserve sequence semantics: %d %d %v %v", next, highBefore, calledBefore, err)
			}
			var applied, repeated time.Time
			if err := s.Pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=32`).Scan(&applied); err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, s.Pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if err := s.Pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=32`).Scan(&repeated); err != nil || !applied.Equal(repeated) {
				t.Fatalf("repeat changed ledger: %v", err)
			}
		})
	}
}

func TestPersonalOwnershipMigrationFailuresAreAtomic(t *testing.T) {
	s := ownershipMigrationSource(t)
	ctx := context.Background()
	original := ownershipMigrationFacts(t, s, "project_members")
	var sequenceLast int64
	var sequenceCalled bool
	if err := s.Pool.QueryRow(ctx, "SELECT last_value,is_called FROM project_member_versions").Scan(&sequenceLast, &sequenceCalled); err != nil {
		t.Fatal(err)
	}
	ledger := func(t *testing.T) string {
		t.Helper()
		var value string
		if err := s.Pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m").Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	originalLedger := ledger(t)
	assertSourceCatalog := func(t *testing.T) {
		t.Helper()
		var restored bool
		if err := s.Pool.QueryRow(t.Context(), `SELECT
 to_regclass('teams') IS NULL AND to_regclass('team_members') IS NULL
 AND to_regclass('team_member_versions') IS NULL AND to_regclass('project_ownership') IS NULL
 AND to_regclass('project_grants') IS NULL AND to_regclass('project_grant_versions') IS NULL
 AND to_regclass('project_members') IS NOT NULL AND to_regclass('project_member_versions') IS NOT NULL
 AND to_regclass('project_members_user') IS NOT NULL
 AND (SELECT count(*) FROM pg_constraint WHERE conrelid='project_members'::regclass
 AND conname IN ('project_members_pkey','project_members_role_check','project_members_version_check'))=3
 AND (SELECT pg_get_expr(adbin,adrelid) FROM pg_attrdef d JOIN pg_attribute a
 ON a.attrelid=d.adrelid AND a.attnum=d.adnum
 WHERE d.adrelid='project_members'::regclass AND a.attname='version')
 = 'nextval(''project_member_versions''::regclass)'`).Scan(&restored); err != nil || !restored {
			t.Fatalf("historical ownership catalog changed: %t %v", restored, err)
		}
	}
	assertSequence := func(t *testing.T) {
		t.Helper()
		var last int64
		var called bool
		if err := s.Pool.QueryRow(t.Context(), "SELECT last_value,is_called FROM project_member_versions").Scan(&last, &called); err != nil || last != sequenceLast || called != sequenceCalled {
			t.Fatalf("historical member sequence was not restored: %d %t, want %d %t: %v", last, called, sequenceLast, sequenceCalled, err)
		}
	}
	for _, phase := range []string{"no-admin", "bad-grant-user", "bad-invite-user", "bad-invite-project", "sql", "transform", "ledger"} {
		if !t.Run(phase, func(t *testing.T) {
			if !reflect.DeepEqual(original, ownershipMigrationFacts(t, s, "project_members")) || originalLedger != ledger(t) {
				t.Fatal("previous failure changed the historical ownership fixture")
			}
			assertSourceCatalog(t)
			assertSequence(t)
			migrations := append([]migration(nil), schemaMigrations...)
			switch phase {
			case "no-admin":
				mustQueryExec(t, s, `UPDATE project_members SET role='member' WHERE project_id=$1`, queryID(1))
			case "bad-grant-user":
				mustQueryExec(t, s, `UPDATE project_members SET user_id=md5('missing')::uuid WHERE user_id=md5('1')::uuid`)
			case "bad-invite-user":
				mustQueryExec(t, s, `UPDATE project_invitations SET created_by=md5('missing')::uuid`)
			case "bad-invite-project":
				mustQueryExec(t, s, `UPDATE project_invitations SET project_id=md5('missing')::uuid`)
			case "sql":
				migrations[31].sql += ";SELECT 1/0"
			case "transform":
				migrations[31].transform = func(context.Context, pgx.Tx) error { return errors.New("test ownership transform failure") }
			case "ledger":
				mustQueryExec(t, s, `CREATE FUNCTION reject_ownership_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN IF NEW.version=32 THEN RAISE EXCEPTION 'test ownership ledger failure'; END IF; RETURN NEW; END $$;
					CREATE TRIGGER reject_ownership_ledger BEFORE INSERT ON schema_migrations
					FOR EACH ROW EXECUTE FUNCTION reject_ownership_ledger()`)
			}
			before := ownershipMigrationFacts(t, s, "project_members")
			err := migrate(ctx, s.Pool, migrations)
			if err == nil {
				t.Fatal("invalid migration succeeded")
			}
			var databaseError *pgconn.PgError
			if phase == "no-admin" && (!errors.As(err, &databaseError) || !strings.Contains(databaseError.Message, queryID(1))) {
				t.Fatalf("failure omitted affected Project ID: %v", err)
			}
			if !reflect.DeepEqual(before, ownershipMigrationFacts(t, s, "project_members")) {
				t.Fatal("failed migration changed source facts")
			}
			var fresh *string
			var count int
			if err := s.Pool.QueryRow(ctx, `SELECT to_regclass('teams')::text,(SELECT count(*) FROM schema_migrations WHERE version=32)`).Scan(&fresh, &count); err != nil || fresh != nil || count != 0 {
				t.Fatalf("failed migration kept new schema or ledger: %v %d %v", fresh, count, err)
			}
			assertSourceCatalog(t)
			if originalLedger != ledger(t) {
				t.Fatal("failed migration changed the historical ledger")
			}
			assertMigrationPoolReusable(t, s.Pool)
			switch phase {
			case "no-admin", "bad-grant-user":
				mustQueryExec(t, s, "DELETE FROM project_members")
				mustQueryExec(t, s, "INSERT INTO project_members SELECT * FROM jsonb_populate_recordset(NULL::project_members,$1::jsonb)", original["grants"])
			case "bad-invite-user", "bad-invite-project":
				mustQueryExec(t, s, "DELETE FROM project_invitations")
				mustQueryExec(t, s, "INSERT INTO project_invitations SELECT * FROM jsonb_populate_recordset(NULL::project_invitations,$1::jsonb)", original["project_invitations"])
			case "ledger":
				mustQueryExec(t, s, "DROP TRIGGER reject_ownership_ledger ON schema_migrations; DROP FUNCTION reject_ownership_ledger()")
				assertFaultTriggerRemoved(t, s, "reject_ownership_ledger", "schema_migrations")
			}
			// Existing sequence state is not restored by transaction rollback.
			mustQueryExec(t, s, "SELECT setval('project_member_versions',$1,$2)", sequenceLast, sequenceCalled)
			assertSequence(t)
			if !reflect.DeepEqual(original, ownershipMigrationFacts(t, s, "project_members")) || originalLedger != ledger(t) {
				t.Fatal("historical ownership fixture was not restored exactly")
			}
		}) {
			return
		}
	}
}
