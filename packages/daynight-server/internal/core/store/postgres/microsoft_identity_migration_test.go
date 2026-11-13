package postgres

import (
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
}

func TestMicrosoftIdentityMigrationRejectsInvalidOrCollidingKeysAtomically(t *testing.T) {
	for _, test := range []struct {
		name, invalid, code string
	}{
		{"missing old component", "microsoft:tenant", "P1064"},
		{"ambiguous old component", "microsoft:tenant:object@extra", "P1064"},
		{"missing standard component", "msft:@tenant", "P1064"},
		{"ambiguous standard component", "msft:object@tenant@extra", "P1064"},
		{"existing account", "msft:object@tenant", "23505"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:63]); err != nil {
				t.Fatal(err)
			}
			s := &Store{Pool: pool}
			for index, identity := range []string{"microsoft:tenant:object", "microsoft:tenant:another", test.invalid} {
				mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, queryID(index+1), identity)
			}
			before := microsoftIdentityRows(t, pool, false)
			err := migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != test.code {
				t.Fatalf("migration error=%v want SQLSTATE %s", err, test.code)
			}
			if after := microsoftIdentityRows(t, pool, false); after != before {
				t.Fatalf("failed migration partially changed accounts: before=%s after=%s", before, after)
			}
			var version int64
			if err := pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version != 63 {
				t.Fatalf("failed migration advanced ledger: version=%d error=%v", version, err)
			}
		})
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
 'projects',(SELECT jsonb_agg(to_jsonb(t)-'tag_catalog_epoch' ORDER BY id) FROM projects t),
 'ownership',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id) FROM project_ownership t),
 'grants',(SELECT jsonb_agg(to_jsonb(t) ORDER BY project_id,user_id) FROM project_grants t),
 'sessions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM sessions t),
 'tokens',(SELECT jsonb_agg(to_jsonb(t)-'last_used_at' ORDER BY id) FROM personal_access_tokens t))::text`).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}
