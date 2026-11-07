package team_test

import (
	"context"
	"crypto/rand"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"

	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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

func projectService(t *testing.T) (*projectservice.Projects, *postgres.Store, string, model.Principal) {
	t.Helper()
	databaseURL := serviceDatabaseURL(t)
	database, err := postgres.Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return projectservice.NewProjects(database), database, databaseURL, servicePrincipal(t, database)
}

func servicePrincipal(t *testing.T, database *postgres.Store) model.Principal {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	secret := secretutil.Random("dnst_")
	credential := model.Session{ID: uuid.NewString(), TokenHash: secretutil.Hash(secret), CreatedAt: now, ExpiresAt: now.Add(identitycore.SessionLifetime)}
	principal := fixtureIdentitySession(t, database, model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}, credential)

	return principal
}

func requireIdentityOperationalError(t *testing.T, err error) {
	t.Helper()
	var fault *model.Fault
	var databaseError *store.Error
	if err == nil || errors.As(err, &fault) || !errors.As(err, &databaseError) || databaseError.Unwrap() == nil {
		t.Fatalf("expected retained database failure, got %#v", err)
	}
}

func fixtureIdentitySession(t *testing.T, database *postgres.Store, user model.User, session model.Session) model.Principal {
	t.Helper()
	ctx := context.Background()
	var principal model.Principal
	_, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		var err error
		user, err = scope.IdentityDAO().UpsertUser(ctx, user, session.CreatedAt)
		if err != nil {
			return err
		}
		if _, err = team.BootstrapPersonalTeam(ctx, scope.PersonalTeamDAO(), user.ID, session.CreatedAt); err != nil {
			return err
		}
		session.UserID = user.ID
		if err = scope.IdentityDAO().InsertSession(ctx, session); err != nil {
			return err
		}
		principal, err = scope.IdentityDAO().Authenticate(ctx, model.SessionCredential, session.TokenHash, session.CreatedAt)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func pointer[T any](value T) *T { return &value }
