package postgres

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

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
