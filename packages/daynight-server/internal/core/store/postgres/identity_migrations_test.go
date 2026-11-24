package postgres

import (
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMicrosoftLoginKeepsExistingAccountAndOwnership(t *testing.T) {
	ctx := t.Context()
	s := isolatedStore(t)
	pool := s.Pool
	for index, identity := range []string{"msft:object@tenant", "msft:existing@tenant", "google:123", "github:123"} {
		mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,name,created_at,updated_at) VALUES($1,$2,'Retained profile',now(),now())`, queryID(index+1), identity)
	}
	mustQueryExec(t, s, `INSERT INTO teams(id,personal_user_id) VALUES($1,$2)`, queryID(10), queryID(1))
	mustQueryExec(t, s, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, queryID(10), queryID(1))
	mustQueryExec(t, s, `INSERT INTO projects(id,name,repo_url) VALUES($1,'Retained project','https://example.test/retained')`, queryID(20))
	mustQueryExec(t, s, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, queryID(20), queryID(10))
	mustQueryExec(t, s, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, queryID(20), queryID(1))
	mustQueryExec(t, s, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, queryID(30), queryID(1), deviceStoreHash("retained-session"))
	mustQueryExec(t, s, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'Retained token',now(),ARRAY['task:read'],1)`, queryID(31), queryID(1), deviceStoreHash("retained-pat"))
	beforeOwnership := microsoftIdentityOwnership(t, pool)
	assertMicrosoftSessionLegacyFieldsUnset(t, pool)
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
			if updated.ID != queryID(1) || updated.UniAuthID != "msft:object@tenant" {
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
