package store

import (
	"context"
	"crypto/sha256"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

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
		if err := s.Pool.QueryRow(context.Background(), `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM `+table+` t`).Scan(&value); err != nil {
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
			if err := migrate(ctx, s.Pool, schemaMigrations); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before, ownershipMigrationFacts(t, s, "project_grants")) {
				t.Fatal("migration changed grants, invitations, identity or project content")
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
	for _, phase := range []string{"no-admin", "bad-grant-user", "bad-invite-user", "bad-invite-project", "sql", "transform", "ledger"} {
		t.Run(phase, func(t *testing.T) {
			s := ownershipMigrationSource(t)
			ctx := context.Background()
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
			assertMigrationPoolReusable(t, s.Pool)
		})
	}
}
