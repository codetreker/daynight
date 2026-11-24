package postgres

import (
	"bytes"
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

func TestSessionCredentialScopeSharesTransactionAndLocks(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, kind := range []string{"pat", "oauth"} {
		t.Run(kind, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			now := time.Now().UTC().Truncate(time.Microsecond)
			id := uuid.NewString()
			var actor model.Principal
			var bindings []store.OAuthBinding
			var editSQL string
			if kind == "pat" {
				actor = model.Principal{Kind: model.PATCredential, UserID: owner.UserID, CredentialID: id}
				mustQueryExec(t, db, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,$3,'scope',now(),now()+interval '1 day',ARRAY['session:send'],1)`, id, owner.UserID, bytes.Repeat([]byte{1}, 32))
				editSQL = `UPDATE personal_access_tokens SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`
			} else {
				policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"session:send"}, 1)
				if err != nil {
					t.Fatal(err)
				}
				issue := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: id, UserID: owner.UserID, ClientID: "scope-client", ClientSnapshot: []byte(`{"client_name":"Scope client"}`), Resource: "https://server.test/mcp", Scope: "daynight:mcp", ScopePolicy: &policy, CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, AccessID: uuid.NewString(), AccessHash: bytes.Repeat([]byte{2}, 32), RefreshHash: bytes.Repeat([]byte{3}, 32), AccessExpiresAt: now.Add(time.Hour)}
				completion, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
					return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
				})
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("issue grant: %+v %v", completion, err)
				}
				actor = model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: issue.AccessID}
				bindings = []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope}}
				editSQL = `UPDATE oauth_grants SET business_scopes=ARRAY['session:read'],scope_version=2 WHERE id=$1`
			}
			editor, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer editor.Rollback(context.Background())
			done := make(chan error, 1)
			started := false
			defer func() {
				cancel()
				if started {
					<-done
				}
			}()
			completion, err := db.WriteSession(ctx, func(scope store.SessionScope) error {
				credentials, ok := scope.(store.SessionCredentialScope)
				if !ok {
					return errors.New("missing credential scope")
				}
				if kind == "pat" {
					token, err := credentials.SessionPATScopeDAO().ReadLockedPATScope(ctx, actor.UserID, actor.CredentialID)
					if err != nil || token.ScopePolicy.Version() != 1 {
						return errors.New("PAT policy lock failed")
					}
					if _, err := credentials.SessionPATManagementDAO().FreshPATTime(ctx, now); err != nil {
						return err
					}
				} else {
					access, err := credentials.SessionOAuthScopeDAO().LockScopedAccess(ctx, actor, bindings, now)
					if err != nil || access.ScopePolicy.Version() != 1 {
						return errors.New("grant policy lock failed")
					}
				}
				go func() {
					_, e := editor.Exec(ctx, editSQL, id)
					if e == nil {
						e = editor.Commit(ctx)
					}
					done <- e
				}()
				started = true
				sessionPID := scope.(*sessionScope).tx.Conn().PgConn().PID()
				ticker := time.NewTicker(5 * time.Millisecond)
				defer ticker.Stop()
				for {
					var waiting bool
					if err := db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, sessionPID, editor.Conn().PgConn().PID()).Scan(&waiting); err != nil {
						return err
					}
					if waiting {
						break
					}
					select {
					case e := <-done:
						started = false
						return errors.Join(errors.New("scope edit did not wait for Session transaction"), e)
					case <-ctx.Done():
						return ctx.Err()
					case <-ticker.C:
					}
				}
				// Locking the credential does not end the Session transaction.
				_, err := scope.SessionDAO().(store.SessionOperationExistenceDAO).SessionOperationExists(ctx, uuid.NewString(), uuid.NewString())
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("session transaction: %+v %v", completion, err)
			}
			if err := <-done; err != nil {
				t.Fatalf("scope edit after commit: %v", err)
			}
			started = false
			sessionDAOTransaction(t, db, func(scope store.SessionScope) error {
				credentials := scope.(store.SessionCredentialScope)
				if kind == "pat" {
					token, err := credentials.SessionPATScopeDAO().ReadLockedPATScope(ctx, actor.UserID, actor.CredentialID)
					if err != nil || token.ScopePolicy.Version() != 2 || token.ScopePolicy.Scopes()[0] != "session:read" {
						t.Fatalf("new PAT policy: %+v %v", token, err)
					}
				} else {
					access, err := credentials.SessionOAuthScopeDAO().LockScopedAccess(ctx, actor, bindings, now)
					if err != nil || access.ScopePolicy.Version() != 2 || access.ScopePolicy.Scopes()[0] != "session:read" {
						t.Fatalf("new grant policy: %+v %v", access, err)
					}
				}
				return nil
			})
		})
	}
}
