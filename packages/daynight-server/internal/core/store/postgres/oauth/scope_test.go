package oauth_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestScopedOAuthStorage(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	issue := family(now, "scope-client")
	ids := []scopepolicy.ScopeID{"project:read", "task:read"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, ids, 1)
	check(t, err)
	issue.Grant.ScopePolicy = &policy
	_, err = tx.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
	check(t, err)
	check(t, dao.IssueFamily(ctx, issue))
	bindings := []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope}}
	assert := func(actual *scopepolicy.Policy, version int64, scopes []scopepolicy.ScopeID) {
		t.Helper()
		if actual == nil || actual.Version() != version || !slices.Equal(actual.Scopes(), scopes) {
			t.Fatalf("scope policy = %#v, want %d %v", actual, version, scopes)
		}
	}
	identity, err := dao.ScopedAccess(ctx, issue.AccessHash, bindings, now)
	check(t, err)
	if identity.GrantID != issue.Grant.ID || identity.Principal.CredentialID != issue.AccessID {
		t.Fatalf("incorrect original identity: %+v", identity)
	}
	assert(identity.ScopePolicy, 1, ids)
	locked, err := dao.LockScopedAccess(ctx, identity.Principal, bindings, now)
	check(t, err)
	if locked.Principal != identity.Principal || locked.GrantID != issue.Grant.ID || !locked.ExpiresAt.Equal(issue.AccessExpiresAt) {
		t.Fatalf("locked access identity: %+v", locked)
	}
	assert(locked.ScopePolicy, 1, ids)
	for _, tc := range []struct {
		name     string
		actor    model.Principal
		bindings []store.OAuthBinding
	}{
		{"missing access", model.Principal{Kind: model.OAuthCredential, UserID: issue.Grant.UserID, CredentialID: uuid.NewString()}, bindings},
		{"foreign owner", model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: issue.AccessID}, bindings},
		{"wrong kind", model.Principal{Kind: model.PATCredential, UserID: issue.Grant.UserID, CredentialID: issue.AccessID}, bindings},
		{"wrong binding", identity.Principal, []store.OAuthBinding{{Resource: "https://other.example/mcp", Scope: issue.Grant.Scope}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := dao.LockScopedAccess(ctx, tc.actor, tc.bindings, now)
			missing(t, err)
		})
	}
	grants, err := dao.ScopedOwnerGrants(ctx, issue.Grant.UserID)
	check(t, err)
	if len(grants) != 1 || grants[0].ID != issue.Grant.ID {
		t.Fatalf("grants: %+v", grants)
	}
	assert(grants[0].ScopePolicy, 1, ids)
	_, err = dao.LockGrantScope(ctx, uuid.NewString(), issue.Grant.ID)
	missing(t, err)
	grant, err := dao.LockGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID)
	check(t, err)
	assert(grant.ScopePolicy, 1, ids)
	_, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 2, ids, now)
	missing(t, err)
	grant, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 1, ids, now)
	check(t, err)
	assert(grant.ScopePolicy, 1, ids)
	changed := []scopepolicy.ScopeID{"task:read"}
	grant, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 1, changed, now)
	check(t, err)
	assert(grant.ScopePolicy, 2, changed)
	identity, err = dao.ScopedAccess(ctx, issue.AccessHash, bindings, now)
	check(t, err)
	assert(identity.ScopePolicy, 2, changed)
	locked, err = dao.LockScopedAccess(ctx, identity.Principal, bindings, now)
	check(t, err)
	assert(locked.ScopePolicy, 2, changed)
	_, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 1, ids, now)
	missing(t, err)
	if _, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 2, []scopepolicy.ScopeID{"task:read", "task:read"}, now); err == nil {
		t.Fatal("duplicate scopes accepted")
	}
	_, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 2, ids, issue.Grant.ExpiresAt)
	missing(t, err)
	_, err = dao.RevokeFamily(ctx, issue.Grant.ID, now)
	check(t, err)
	_, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 2, ids, now)
	missing(t, err)
	_, err = dao.ScopedAccess(ctx, issue.AccessHash, bindings, now)
	missing(t, err)
}

func TestScopedOAuthCorruptAndFixedProfiles(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	mcp, api := family(now, "tool"), apiFamily(now)
	for _, issue := range []store.OAuthFamilyIssue{mcp, api} {
		_, err := tx.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
		check(t, err)
		check(t, dao.IssueFamily(ctx, issue))
	}
	bind := func(v store.OAuthFamilyIssue) []store.OAuthBinding {
		return []store.OAuthBinding{{Resource: v.Grant.Resource, Scope: v.Grant.Scope, ClientID: v.Grant.ClientID}}
	}
	fixed, err := dao.ScopedAccess(ctx, api.AccessHash, bind(api), now)
	check(t, err)
	if fixed.ScopePolicy != nil {
		t.Fatal("fixed API profile acquired a policy")
	}
	fixedLocked, err := dao.LockScopedAccess(ctx, fixed.Principal, bind(api), now)
	check(t, err)
	if fixedLocked.ScopePolicy != nil || fixedLocked.GrantID != api.Grant.ID {
		t.Fatalf("fixed API locked access: %+v", fixedLocked)
	}
	_, err = dao.CompareGrantScope(ctx, api.Grant.UserID, api.Grant.ID, 1, []scopepolicy.ScopeID{"task:read"}, now)
	missing(t, err)
	for _, tc := range []struct {
		ids     []string
		version *int64
	}{
		{nil, nil}, {[]string{"task:read", "task:read"}, int64ptr(1)}, {[]string{"worker:claim"}, int64ptr(1)}, {[]string{"task:read"}, int64ptr(0)}, {nil, int64ptr(1)},
	} {
		_, err = tx.Exec(ctx, `UPDATE oauth_grants SET business_scopes=$2,scope_version=$3 WHERE id=$1`, mcp.Grant.ID, tc.ids, tc.version)
		check(t, err)
		if _, err = dao.ScopedAccess(ctx, mcp.AccessHash, bind(mcp), now); err == nil {
			t.Fatalf("corrupt MCP policy accepted: %+v", tc)
		}
		principal := model.Principal{Kind: model.OAuthCredential, UserID: mcp.Grant.UserID, CredentialID: mcp.AccessID}
		if _, err = dao.LockScopedAccess(ctx, principal, bind(mcp), now); err == nil {
			t.Fatalf("corrupt MCP policy accepted under lock: %+v", tc)
		}
	}
	_, err = tx.Exec(ctx, `UPDATE oauth_grants SET business_scopes=ARRAY['task:read'],scope_version=1 WHERE id=$1`, api.Grant.ID)
	check(t, err)
	if _, err = dao.ScopedAccess(ctx, api.AccessHash, bind(api), now); err == nil {
		t.Fatal("fixed profile accepted stored policy")
	}
	p, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 2)
	check(t, err)
	invalid := family(now, "invalid")
	invalid.Grant.ScopePolicy = &p
	if err = dao.IssueFamily(ctx, invalid); err == nil {
		t.Fatal("noninitial version accepted")
	}
}

func int64ptr(v int64) *int64 { return &v }

func TestOAuthApprovedScopePersistence(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	a := authorizationRecord(now)
	created, err := dao.InsertAuthorization(ctx, a, 5, now)
	check(t, err)
	if !created {
		t.Fatal("authorization not created")
	}
	a, err = dao.Authorization(ctx, a.ID, true)
	check(t, err)
	if a.ApprovedScopes != nil {
		t.Fatal("pending authorization has scopes")
	}
	a.Status, a.UserID, a.CodeHash = "approved", uuid.NewString(), digest("scope-code")
	a.ApprovedScopes = []scopepolicy.ScopeID{"project:read", "task:read"}
	check(t, dao.UpdateAuthorization(ctx, a))
	got, err := dao.AuthorizationByCode(ctx, a.CodeHash, false)
	check(t, err)
	if !slices.Equal(got.ApprovedScopes, a.ApprovedScopes) {
		t.Fatalf("approved scopes: %v", got.ApprovedScopes)
	}
	a.Status = "consumed"
	check(t, dao.UpdateAuthorization(ctx, a))
	got, err = dao.Authorization(ctx, a.ID, false)
	check(t, err)
	if !slices.Equal(got.ApprovedScopes, a.ApprovedScopes) {
		t.Fatal("consumption discarded approved scopes")
	}
	a.Status = "denied"
	if err = dao.UpdateAuthorization(ctx, a); err == nil {
		t.Fatal("denial with scopes accepted")
	}
	_, err = tx.Exec(ctx, `UPDATE oauth_authorizations SET approved_business_scopes=ARRAY['bad:scope'] WHERE id=$1`, a.ID)
	check(t, err)
	if _, err = dao.Authorization(ctx, a.ID, false); err == nil {
		t.Fatal("corrupt approved scopes accepted")
	}
}

func TestRefreshWaitsForGrantScopeEdit(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	issue := family(now, "client")
	p, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"project:read", "task:read"}, 1)
	check(t, err)
	issue.Grant.ScopePolicy = &p
	_, err = db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
	check(t, err)
	refreshToken := secret.Random(coreoauth.RefreshPrefix)
	issue.RefreshHash = secret.Hash(refreshToken)
	_, err = db.WriteCredentialFamily(ctx, func(s store.CredentialFamilyScope) error { return s.CredentialFamilyDAO().IssueFamily(ctx, issue) })
	check(t, err)
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	dao := oauth.NewDAO(holder)
	_, err = dao.LockGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID)
	check(t, err)
	changed := []scopepolicy.ScopeID{"task:read"}
	_, err = dao.CompareGrantScope(ctx, issue.Grant.UserID, issue.Grant.ID, 1, changed, now)
	check(t, err)
	type result struct {
		issued coreoauth.RotatedTokens
		err    error
	}
	done := make(chan result, 1)
	finished := false
	go func() {
		v, err := coreoauth.NewGrantLifecycle(db).Rotate(ctx, refreshToken, issue.Grant.ClientID, issue.Grant.Resource, func(context.Context, string) error { return nil })
		done <- result{issued: v, err: err}
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Error("refresh did not drain")
			}
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants", holder.Conn().PgConn().PID())
	check(t, holder.Commit(ctx))
	var rotated result
	select {
	case rotated = <-done:
		finished = true
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	check(t, rotated.err)
	if rotated.issued.Grant == nil || rotated.issued.Grant.ID != issue.Grant.ID {
		t.Fatal("refresh changed grant")
	}
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	read := oauth.NewDAO(tx)
	bindings := []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope}}
	for _, hash := range [][]byte{issue.AccessHash, secret.Hash(rotated.issued.AccessToken)} {
		got, err := read.ScopedAccess(ctx, hash, bindings, now)
		check(t, err)
		if got.GrantID != issue.Grant.ID || got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), changed) {
			t.Fatalf("access after edit/refresh: %+v", got)
		}
	}
	got, err := read.LockScopedAccess(ctx, model.Principal{Kind: model.OAuthCredential, UserID: issue.Grant.UserID, CredentialID: issue.AccessID}, bindings, now)
	check(t, err)
	if got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), changed) {
		t.Fatalf("locked original access policy: %+v", got)
	}
}
