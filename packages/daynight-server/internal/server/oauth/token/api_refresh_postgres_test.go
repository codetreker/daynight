package token

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAPIRefreshClassifiesActualPostgresLifecycleRefusals(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	completion, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		_, err := scope.IdentityDAO().UpsertUser(ctx, user, now)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("prepare OAuth account: %+v %v", completion, err)
	}
	for _, name := range []string{"expired", "binding mismatch", "missing refresh", "database failure"} {
		t.Run(name, func(t *testing.T) {
			var issued core.IssuedFamily
			createdAt := now
			if name == "expired" {
				createdAt = now.Add(-31 * 24 * time.Hour)
			}
			completion, err := database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
				var err error
				issued, err = core.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user.ID, "https://server.test/api/v1", createdAt)
				return err
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("prepare API family: %+v %v", completion, err)
			}
			status, code := http.StatusBadRequest, "invalid_grant"
			switch name {
			case "binding mismatch":
				_, err = database.Pool.Exec(ctx, `UPDATE oauth_grants SET resource='https://other.test/api/v1' WHERE id=$1`, issued.Grant.ID)
			case "missing refresh":
				_, err = database.Pool.Exec(ctx, `DELETE FROM oauth_refresh_tokens WHERE grant_id=$1`, issued.Grant.ID)
			case "database failure":
				_, err = database.Pool.Exec(ctx, `ALTER TABLE oauth_refresh_tokens RENAME TO unavailable_refresh_tokens`)
				t.Cleanup(func() {
					cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if _, restoreErr := database.Pool.Exec(cleanupCtx, `ALTER TABLE unavailable_refresh_tokens RENAME TO oauth_refresh_tokens`); restoreErr != nil {
						t.Error(restoreErr)
					}
				})
				status, code = http.StatusInternalServerError, "server_error"
			}
			if err != nil {
				t.Fatal(err)
			}
			h := apiTokenAdapter(core.NewGrantLifecycle(database))
			w := tokenRequest(h.Token, apiRefreshForm(issued.RefreshToken).Encode())
			if w.Code != status || w.Body.String() != "{\"error\":\""+code+"\"}\n" || strings.Contains(w.Body.String(), "access_token") {
				t.Fatalf("actual PostgreSQL lifecycle refusal: status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestAPIRefreshReturnsPersistedUTCDeadlinesFromNonUTCDriver(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	config := database.Pool.Config()
	config.MaxConns = 1
	config.MinConns = 0
	config.AfterConnect = func(_ context.Context, connection *pgx.Conn) error {
		connection.TypeMap().RegisterType(&pgtype.Type{Name: "timestamptz", OID: pgtype.TimestamptzOID, Codec: &pgtype.TimestamptzCodec{ScanLocation: time.FixedZone("UTC+08", 8*60*60)}})
		return nil
	}
	replacement, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	original := database.Pool
	database.Pool = replacement
	original.Close()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	completion, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		_, err := scope.IdentityDAO().UpsertUser(ctx, user, now)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("prepare user: %v", err)
	}
	var issued core.IssuedFamily
	completion, err = database.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = core.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user.ID, "https://server.test/api/v1", now)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("prepare family: %v", err)
	}
	h := apiTokenAdapter(core.NewGrantLifecycle(database))
	w := tokenRequest(h.Token, apiRefreshForm(issued.RefreshToken).Encode())
	if w.Code != http.StatusOK {
		t.Fatalf("refresh HTTP status=%d", w.Code)
	}
	var fields map[string]json.RawMessage
	var result api.OAuthAPITokens
	if json.Unmarshal(w.Body.Bytes(), &fields) != nil || json.Unmarshal(w.Body.Bytes(), &result) != nil {
		t.Fatal("decode refreshed token response failed")
	}
	utcMicrosecond := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$`)
	for _, field := range []string{"access_expires_at", "grant_expires_at"} {
		var value string
		if json.Unmarshal(fields[field], &value) != nil || !utcMicrosecond.MatchString(value) {
			t.Fatalf("refreshed %s is not canonical UTC microseconds", field)
		}
	}
	var accessExpiry, grantExpiry, refreshExpiry, created time.Time
	err = database.Pool.QueryRow(ctx, `SELECT a.expires_at,g.expires_at,r.expires_at,a.created_at FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id JOIN oauth_refresh_tokens r ON r.grant_id=g.id WHERE a.token_hash=$1 AND r.token_hash=$2`, secret.Hash(result.AccessToken), secret.Hash(result.RefreshToken)).Scan(&accessExpiry, &grantExpiry, &refreshExpiry, &created)
	if err != nil {
		t.Fatal("read rotated persisted deadlines failed")
	}
	if _, offset := created.Zone(); offset != 8*60*60 {
		t.Fatal("actual rotation did not retain the non-UTC driver scan configuration")
	}
	if !result.AccessExpiresAt.Equal(accessExpiry) || !result.GrantExpiresAt.Equal(grantExpiry) || !grantExpiry.Equal(refreshExpiry) || accessExpiry.Sub(created) != core.AccessLifetime || grantExpiry.Sub(created) != core.GrantLifetime {
		t.Fatal("response deadlines or issuing instant differ from persisted rotation")
	}
}
