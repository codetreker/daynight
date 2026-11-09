package testutil

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func OAuthFamily(t *testing.T, writer store.CredentialFamilyWriter, user string, now time.Time) (store.OAuthGrant, string, string) {
	t.Helper()
	access, refresh := secret.Random(model.OAuthAccessPrefix), secret.Random("dnmcr_")
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "client", ClientSnapshot: []byte(`{"clientName":"client"}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	completion, err := writer.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(t.Context(), store.OAuthFamilyIssue{Grant: grant, AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(time.Hour)})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %v %v", completion, err)
	}
	return grant, access, refresh
}

func AddOAuthUser(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	user := uuid.NewString()
	if _, err := pool.Exec(t.Context(), `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, user, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	return user
}
