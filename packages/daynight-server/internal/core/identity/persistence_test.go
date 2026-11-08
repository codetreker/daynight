package identity

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func identityDatabase(t *testing.T) *postgres.Store {
	t.Helper()
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "identity_" + uuid.NewString()[0:8]
	if _, err = pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		pool.Close()
	})
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	q := parsed.Query()
	q.Set("search_path", schema)
	q.Set("timezone", "UTC")
	parsed.RawQuery = q.Encode()
	database, err := postgres.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}

func TestIdentityDomainAgainstDatabase(t *testing.T) {
	db := identityDatabase(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	m := NewIdentity("https://example.test/auth/callback")
	write := func(fn func(store.IdentityScope) error) error {
		completion, err := db.WriteIdentity(ctx, fn)
		if err != nil {
			return err
		}
		if completion.Outcome != store.TransactionCommitted {
			t.Fatalf("unexpected completion: %#v", completion)
		}
		return nil
	}
	start, pending, err := m.StartLogin("github", "/projects", now)
	if err != nil {
		t.Fatal(err)
	}
	pending.ScopeHash = secret.Hash(secret.Random(""))
	if err = write(func(scope store.IdentityScope) error {
		_, err := m.CreateLogin(ctx, scope.IdentityDAO(), pending, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = write(func(scope store.IdentityScope) error {
		actual, err := m.ConsumeLogin(ctx, scope.IdentityDAO(), start.State, start.BrowserBinding, now)
		if err == nil && actual.ID != start.ID {
			t.Fatalf("consumed wrong login: %#v", actual)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	session, sessionSecret := m.NewSession(now)
	var user model.User
	if err = write(func(scope store.IdentityScope) error {
		var err error
		user, err = m.CompleteLogin(ctx, scope.IdentityDAO(), model.User{UniAuthID: "integration:user"}, now)
		if err != nil {
			return err
		}
		user.PersonalTeam, err = team.BootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), user.ID, now)
		if err != nil {
			return err
		}
		session.UserID = user.ID
		return m.CreateSession(ctx, scope.IdentityDAO(), session)
	}); err != nil {
		t.Fatal(err)
	}
	var principal model.Principal
	if err = write(func(scope store.IdentityScope) error {
		var err error
		principal, err = m.Authenticate(ctx, scope.IdentityDAO(), model.SessionCredential, sessionSecret, now)
		return err
	}); err != nil || principal.UserID != user.ID {
		t.Fatalf("session authentication: %#v %v", principal, err)
	}
	var token MintedPAT
	if err = write(func(scope store.IdentityScope) error {
		var err error
		token, err = m.CreatePAT(ctx, scope.IdentityDAO(), principal, CreatePAT{Name: "integration"}, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = write(func(scope store.IdentityScope) error {
		list, err := m.ListPATs(ctx, scope.IdentityDAO(), principal, now)
		if err == nil && (len(list) != 1 || list[0].ID != token.Credential.ID) {
			t.Fatalf("PAT list: %#v", list)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = write(func(scope store.IdentityScope) error {
		return m.RevokePAT(ctx, scope.IdentityDAO(), principal, token.Credential.ID, now)
	}); err != nil {
		t.Fatal(err)
	}
	err = write(func(scope store.IdentityScope) error {
		_, err := m.Authenticate(ctx, scope.IdentityDAO(), model.PATCredential, token.Secret, now)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked PAT authenticated: %v", err)
	}
}
