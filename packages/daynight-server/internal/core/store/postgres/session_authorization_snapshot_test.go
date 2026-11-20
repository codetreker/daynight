package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestSessionCredentialPolicySharesSnapshotAndTransaction(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, owner, _, _ := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC()
	id := uuid.NewString()
	p, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	completion, err := db.WriteIdentity(ctx, func(s store.IdentityScope) error {
		return s.IdentityDAO().InsertPAT(ctx, model.PersonalAccessToken{ID: id, UserID: owner.UserID, Name: "session-policy", CreatedAt: now, TokenHash: secret.Hash(uuid.NewString()), ScopePolicy: &p})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("create PAT: %v %+v", err, completion)
	}
	principal := model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: id}
	check := func(s store.SnapshotScope, version int64) error {
		reader, ok := s.(store.ScopedSessionSnapshot)
		if !ok {
			return fmt.Errorf("snapshot lacks authorization capability")
		}
		token, e := reader.SessionPATPolicy(ctx, principal, now)
		if e != nil {
			return e
		}
		if token.ScopePolicy == nil || token.ScopePolicy.Version() != version {
			return fmt.Errorf("policy version: %+v", token.ScopePolicy)
		}
		return nil
	}
	err = db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		if err := check(s, 1); err != nil {
			return err
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:send'],scope_version=2 WHERE id=$1`, id); err != nil {
			return err
		}
		return check(s, 1)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.ReadSnapshot(ctx, func(s store.SnapshotScope) error { return check(s, 2) }); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(s store.SessionScope) error {
		scoped, ok := s.(store.SessionCredentialScope)
		if !ok {
			return fmt.Errorf("Session transaction lacks policy DAOs")
		}
		token, err := scoped.SessionPATScopeDAO().ReadLockedPATScope(ctx, owner.UserID, id)
		if err != nil {
			return err
		}
		if token.ScopePolicy == nil || token.ScopePolicy.Version() != 2 {
			return fmt.Errorf("locked policy: %+v", token.ScopePolicy)
		}
		if _, err = scoped.SessionPATManagementDAO().FreshPATTime(ctx, now); err != nil {
			return err
		}
		if scoped.SessionOAuthScopeDAO() == nil {
			return fmt.Errorf("OAuth DAO unavailable")
		}
		return nil
	})
}

func TestSessionOAuthPolicySharesSnapshotAndEnforcesBindings(t *testing.T) {
	parallelRootDatabaseTest(t)
	db, owner, _, _ := membershipFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"session:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: owner.UserID, ClientID: "test-client", ClientSnapshot: []byte(`{}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour), ScopePolicy: &policy},
		AccessID: uuid.NewString(), AccessHash: secret.Hash(uuid.NewString()), RefreshHash: secret.Hash(uuid.NewString()), AccessExpiresAt: now.Add(time.Hour),
	}
	completion, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue OAuth family: %v %+v", err, completion)
	}
	principal := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: issue.AccessID}
	bindings := []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope, ClientID: issue.Grant.ClientID}}
	check := func(scope store.SnapshotScope, version int64, permission scopepolicy.ScopeID) error {
		reader, ok := scope.(store.ScopedSessionSnapshot)
		if !ok {
			return fmt.Errorf("snapshot lacks authorization capability")
		}
		actual, err := reader.SessionOAuthPolicy(ctx, principal, bindings, now)
		if err != nil {
			return err
		}
		if actual.Principal != principal || actual.GrantID != issue.Grant.ID || actual.ScopePolicy == nil || actual.ScopePolicy.Version() != version {
			return fmt.Errorf("unexpected OAuth policy identity: %+v", actual)
		}
		return actual.ScopePolicy.Require(permission)
	}
	err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		reader := scope.(store.ScopedSessionSnapshot)
		for _, binding := range []store.OAuthBinding{
			{Resource: "https://other.test/mcp", Scope: issue.Grant.Scope, ClientID: issue.Grant.ClientID},
			{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope, ClientID: "other-client"},
		} {
			if _, err := reader.SessionOAuthPolicy(ctx, principal, []store.OAuthBinding{binding}, now); !errors.Is(err, model.ErrNotFound) {
				return fmt.Errorf("incorrect binding accepted: %v", err)
			}
		}
		if err := check(scope, 1, "session:read"); err != nil {
			return err
		}
		if _, err := db.Pool.Exec(ctx, `UPDATE oauth_grants SET business_scopes=ARRAY['session:send'],scope_version=2 WHERE id=$1`, issue.Grant.ID); err != nil {
			return err
		}
		return check(scope, 1, "session:read")
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error { return check(scope, 2, "session:send") }); err != nil {
		t.Fatal(err)
	}
	completion, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		_, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, issue.Grant.ID, now)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("revoke OAuth family: %v %+v", err, completion)
	}
	err = db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		_, err := scope.(store.ScopedSessionSnapshot).SessionOAuthPolicy(ctx, principal, bindings, now)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked OAuth access was not refused: %v", err)
	}
}
