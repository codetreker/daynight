package postgres

import (
	"context"
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
		scoped, ok := s.(store.ScopedSessionAuthorizationScope)
		if !ok {
			return fmt.Errorf("Session transaction lacks policy DAOs")
		}
		token, err := scoped.PATScopeDAO().ReadLockedPATScope(ctx, owner.UserID, id)
		if err != nil {
			return err
		}
		if token.ScopePolicy == nil || token.ScopePolicy.Version() != 2 {
			return fmt.Errorf("locked policy: %+v", token.ScopePolicy)
		}
		if _, err = scoped.PATManagementDAO().FreshPATTime(ctx, now); err != nil {
			return err
		}
		if scoped.OAuthScopeDAO() == nil {
			return fmt.Errorf("OAuth DAO unavailable")
		}
		return nil
	})
}
