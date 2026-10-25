package service

import (
	"context"
	"crypto/rand"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func serviceDatabaseURL(t *testing.T) string {
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
	schema := "service_" + strings.ToLower(rand.Text())
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
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
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("timezone", "UTC")
	query.Set("application_name", schema)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func projectService(t *testing.T) (*Projects, *store.Store, string, core.Principal) {
	t.Helper()
	databaseURL := serviceDatabaseURL(t)
	database, err := store.Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return NewProjects(database), database, databaseURL, servicePrincipal(t, database)
}

func servicePrincipal(t *testing.T, database *store.Store) core.Principal {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	secret := randomSecret("dnst_")
	credential := core.Session{ID: uuid.NewString(), TokenHash: secretHash(secret), CreatedAt: now, ExpiresAt: now.Add(SessionLifetime)}
	if _, err := database.CreateIdentitySession(ctx, core.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential); err != nil {
		t.Fatal(err)
	}
	principal, err := database.Authenticate(ctx, core.SessionCredential, secretHash(secret), now)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}
