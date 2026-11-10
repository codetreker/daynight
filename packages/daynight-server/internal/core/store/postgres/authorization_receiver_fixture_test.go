package postgres

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type authorizationReceiverFixture struct {
	database      *Store
	now           time.Time
	authorization store.OAuthAuthorization
	client        store.OAuthClient
	issue         store.OAuthFamilyIssue
}

func newAuthorizationReceiverFixture(t *testing.T, clientID, status string) authorizationReceiverFixture {
	t.Helper()
	f := authorizationReceiverFixture{database: isolatedStore(t), now: time.Now().UTC().Truncate(time.Microsecond)}
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	f.client = store.OAuthClient{ID: clientID, Metadata: []byte(`{"client_name":"Receiver"}`), CreatedAt: f.now, LastUsedAt: f.now, ExpiresAt: f.now.Add(7 * 24 * time.Hour)}
	f.authorization = authorizationFailureRecord(f.now)
	f.authorization.ClientID, f.authorization.Client = clientID, bytes.Clone(f.client.Metadata)
	f.authorization.BindingHash = secret.Hash("receiver-binding")
	f.issue = store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user.ID, ClientID: clientID, ClientSnapshot: bytes.Clone(f.client.Metadata), Resource: f.authorization.Resource, Scope: f.authorization.Scope, CreatedAt: f.now, ExpiresAt: f.now.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: secret.Hash("receiver-access"), RefreshHash: secret.Hash("receiver-refresh"), AccessExpiresAt: f.now.Add(time.Hour),
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if _, err := scope.IdentityDAO().UpsertUser(ctx, user, f.now); err != nil {
			return err
		}
		inserted, err := scope.OAuthClientDAO().InsertClient(ctx, f.client, 100, f.now)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.New("receiver client fixture unexpectedly reached capacity")
		}
		inserted, err = scope.AuthorizationDAO().InsertAuthorization(ctx, f.authorization, 100, f.now)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.New("receiver authorization fixture unexpectedly reached capacity")
		}
		if status == "approved" {
			expiry := f.now.Add(time.Minute)
			f.authorization.Status, f.authorization.UserID = status, user.ID
			f.authorization.CodeHash, f.authorization.CodeExpiresAt = secret.Hash("receiver-code"), &expiry
			if err := scope.AuthorizationDAO().UpdateAuthorization(ctx, f.authorization); err != nil {
				return err
			}
		}
		f.authorization, err = scope.AuthorizationDAO().Authorization(ctx, f.authorization.ID, false)
		if err != nil {
			return err
		}
		f.client, err = scope.OAuthClientDAO().Client(ctx, clientID, false)
		return err
	})
	authorizationReceiverCommitted(t, completion, err)
	return f
}

func authorizationReceiverCommitted(t *testing.T, completion store.Completion, err error) {
	t.Helper()
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("receiver transaction completion=%+v, error=%v", completion, err)
	}
}

func authorizationReceiverRow(t *testing.T, ctx context.Context, database *Store, table, column string, key any) string {
	t.Helper()
	var row string
	query := "SELECT to_jsonb(row)::text FROM " + pgx.Identifier{table}.Sanitize() + " AS row WHERE " + pgx.Identifier{column}.Sanitize() + "=$1"
	if err := database.Pool.QueryRow(ctx, query, key).Scan(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

func authorizationReceiverCounts(t *testing.T, ctx context.Context, database *Store) [3]int64 {
	t.Helper()
	var counts [3]int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&counts[0], &counts[1], &counts[2]); err != nil {
		t.Fatal(err)
	}
	return counts
}

func authorizationReceiverClientCounts(t *testing.T, ctx context.Context, database *Store, clientID string) [3]int64 {
	t.Helper()
	var counts [3]int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE client_id=$1),
 (SELECT count(*) FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id WHERE g.client_id=$1),
 (SELECT count(*) FROM oauth_refresh_tokens WHERE client_id=$1)`, clientID).Scan(&counts[0], &counts[1], &counts[2]); err != nil {
		t.Fatal(err)
	}
	return counts
}

func authorizationReceiverAssertRow(t *testing.T, ctx context.Context, database *Store, table, column string, key any, want string) {
	t.Helper()
	if got := authorizationReceiverRow(t, ctx, database, table, column, key); got != want {
		t.Fatalf("%s row changed: got %s, want %s", table, got, want)
	}
}
