package oauth

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestAPIAuthenticationReturnsPersistedGrantDeadlineAndIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
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
		t.Fatalf("persist application user: %+v %v", completion, err)
	}
	issuer, err := NewAPIIssuer(database, "https://application.example")
	if err != nil {
		t.Fatal(err)
	}
	issued, err := issuer.Issue(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	deadline := now.Add(37*time.Minute + 123456*time.Microsecond)
	if _, err := database.Pool.Exec(ctx, `UPDATE oauth_grants SET expires_at=$2 WHERE id=$1`, issued.Grant.ID, deadline); err != nil {
		t.Fatal(err)
	}
	a := NewAuthenticator(database)
	a.SetOrigin("https://application.example")
	identity, err := a.AuthenticateAPIAccess(ctx, issued.AccessToken)
	want := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: user.ID, CredentialID: issued.AccessID}, GrantID: issued.Grant.ID, ExpiresAt: deadline}
	if err != nil || identity != want {
		t.Fatalf("persisted application access = %+v %v; want exact %+v", identity, err, want)
	}
}
