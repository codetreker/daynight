package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAuthorizationScopeCommitsAndRollsBackAllDAOsTogether(t *testing.T) {
	for _, commit := range []bool{true, false} {
		t.Run(fmt.Sprintf("commit=%t", commit), func(t *testing.T) {
			database := isolatedStore(t)
			ctx := t.Context()
			now := time.Now().UTC().Truncate(time.Microsecond)
			user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
			client := store.OAuthClient{ID: "scope-client", Metadata: []byte(`{"client_name":"Scope client"}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
			issue := store.OAuthFamilyIssue{
				Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user.ID, ClientID: client.ID, Resource: "https://server.test/mcp", Scope: "daynight:mcp", ClientSnapshot: client.Metadata, CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
				AccessID: uuid.NewString(), AccessHash: bytes.Repeat([]byte{1}, 32), RefreshHash: bytes.Repeat([]byte{2}, 32), AccessExpiresAt: now.Add(time.Hour),
			}
			authorization := authorizationFailureRecord(now)
			refusal := errors.New("reject composed authorization")
			completion, err := database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
				persisted, err := scope.IdentityDAO().UpsertUser(ctx, user, now)
				if err != nil {
					return err
				}
				if persisted.ID != user.ID || persisted.UniAuthID != user.UniAuthID {
					return fmt.Errorf("identity DAO returned wrong user: %+v", persisted)
				}
				inserted, err := scope.OAuthClientDAO().InsertClient(ctx, client, 10, now)
				if err != nil {
					return err
				}
				if !inserted {
					return errors.New("client DAO rejected available capacity")
				}
				if err := scope.CredentialFamilyDAO().IssueFamily(ctx, issue); err != nil {
					return err
				}
				identity, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, issue.AccessHash, issue.Grant.Resource, issue.Grant.Scope, now)
				if err != nil {
					return err
				}
				if identity.GrantID != issue.Grant.ID || identity.Principal.UserID != user.ID || identity.Principal.CredentialID != issue.AccessID {
					return fmt.Errorf("credential DAO did not observe composed identity: %+v", identity)
				}
				inserted, err = scope.AuthorizationDAO().InsertAuthorization(ctx, authorization, 10, now)
				if err != nil {
					return err
				}
				if !inserted {
					return errors.New("authorization DAO rejected available capacity")
				}
				stored, err := scope.AuthorizationDAO().Authorization(ctx, authorization.ID, false)
				if err != nil {
					return err
				}
				if stored.ID != authorization.ID || stored.Status != "pending" || stored.State != authorization.State {
					return fmt.Errorf("authorization DAO lost pending request: %+v", stored)
				}
				if !commit {
					return refusal
				}
				return nil
			})
			wantRows := 0
			if commit {
				wantRows = 1
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("commit completion = %+v, %v", completion, err)
				}
			} else if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("rollback completion = %+v, %v; want original refusal", completion, err)
			}
			var users, clients, grants, access, refresh, authorizations int
			err = database.Pool.QueryRow(ctx, `SELECT
				(SELECT count(*) FROM users WHERE id=$1),
				(SELECT count(*) FROM oauth_clients WHERE id=$2),
				(SELECT count(*) FROM oauth_grants WHERE id=$3),
				(SELECT count(*) FROM oauth_access_tokens WHERE id=$4),
				(SELECT count(*) FROM oauth_refresh_tokens WHERE token_hash=$5),
				(SELECT count(*) FROM oauth_authorizations WHERE id=$6)`, user.ID, client.ID, issue.Grant.ID, issue.AccessID, issue.RefreshHash, authorization.ID).Scan(&users, &clients, &grants, &access, &refresh, &authorizations)
			if err != nil || users != wantRows || clients != wantRows || grants != wantRows || access != wantRows || refresh != wantRows || authorizations != wantRows {
				t.Fatalf("composed rows users/client/grant/access/refresh/authorization=%d/%d/%d/%d/%d/%d; want each %d, error=%v", users, clients, grants, access, refresh, authorizations, wantRows, err)
			}
		})
	}
}

func TestAuthorizationScopeCanceledBeginDoesNotInvokeCallback(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	completion, err := database.WriteAuthorizations(ctx, func(store.AuthorizationScope) error {
		called = true
		return nil
	})
	if called || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("canceled begin callback=%t, completion=%+v, error=%v", called, completion, err)
	}
}
