package s2s

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestIssuerKeyReplacementDoesNotAlterPersistedFamily(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	database, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	const origin = "https://application.example"
	identity := identityservice.New(database, nil, origin+"/api/v1/auth/callback")
	issuer, err := oauthservice.NewUserAPIIssuer(database, identity.EnsureUser, origin)
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	keyB := "replacement-shared-key-012345678901234567890"
	original := New(issuer, testKey, logger(&logs))
	// Each handler captures one startup-loaded key; replacing it has no family-store mutation.
	replacement := New(issuer, keyB, logger(&logs))
	disabled := New(issuer, "", logger(&logs))
	externalID := "s2s-key-lifecycle-" + uuid.NewString()
	issue := func(handler *Handler, key, externalID string) api.OAuthAPITokens {
		t.Helper()
		r := request(`{"externalUserId":"` + externalID + `"}`).WithContext(ctx)
		r.Header.Set("Authorization", "S2S "+key)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("issue status %d", w.Code)
		}
		var tokens api.OAuthAPITokens
		if err := json.Unmarshal(w.Body.Bytes(), &tokens); err != nil {
			t.Fatal(err)
		}
		return tokens
	}
	first := issue(original, testKey, externalID)
	for _, attempt := range []struct {
		handler *Handler
		key     string
	}{{replacement, testKey}, {disabled, keyB}} {
		r := request(`{"externalUserId":"not-created-` + externalID + `"}`).WithContext(ctx)
		r.Header.Set("Authorization", "S2S "+attempt.key)
		w := httptest.NewRecorder()
		attempt.handler.ServeHTTP(w, r)
		errorCode(t, w, http.StatusUnauthorized, "unauthenticated")
	}
	var refusedAccounts int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE uniauth_id=$1`, "not-created-"+externalID).Scan(&refusedAccounts); err != nil || refusedAccounts != 0 {
		t.Fatalf("refused key created accounts: %d %v", refusedAccounts, err)
	}
	authenticator := oauthservice.NewAuthenticator(database)
	authenticator.SetOrigin(origin)
	initialIdentity, err := authenticator.AuthenticateAPIAccess(ctx, first.AccessToken)
	if err != nil || initialIdentity.Principal.UserID != first.UserID || initialIdentity.GrantID != first.GrantID {
		t.Fatalf("existing access after key replacement: %+v %v", initialIdentity, err)
	}
	lifecycle := coreoauth.NewGrantLifecycle(database)
	rotated, err := lifecycle.Rotate(ctx, first.RefreshToken, coreoauth.APIClientID, origin+"/api/v1", func(_ context.Context, clientID string) error {
		if clientID != coreoauth.APIClientID {
			t.Fatalf("refresh client: %q", clientID)
		}
		return nil
	})
	if err != nil || rotated.Grant.ID != first.GrantID || rotated.Grant.UserID != first.UserID {
		t.Fatalf("key-independent refresh: %v", err)
	}
	if actual, err := authenticator.AuthenticateAPIAccess(ctx, rotated.AccessToken); err != nil || actual.GrantID != first.GrantID || actual.Principal.UserID != first.UserID {
		t.Fatalf("refreshed identity: %+v %v", actual, err)
	}
	second := issue(replacement, keyB, externalID)
	if second.UserID != first.UserID || second.GrantID == first.GrantID {
		t.Fatalf("explicit new grant: user=%s first=%s second=%s", second.UserID, first.GrantID, second.GrantID)
	}
	var grants, liveGrants int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE revoked_at IS NULL) FROM oauth_grants WHERE user_id=$1`, first.UserID).Scan(&grants, &liveGrants); err != nil || grants != 2 || liveGrants != 2 {
		t.Fatalf("independent families: total=%d live=%d err=%v", grants, liveGrants, err)
	}
	if actual, err := authenticator.AuthenticateAPIAccess(ctx, first.AccessToken); err != nil || actual.Principal != initialIdentity.Principal || actual.GrantID != first.GrantID {
		t.Fatalf("original access preserved: %+v %v", actual, err)
	}
	for _, secret := range []string{testKey, keyB, externalID, first.AccessToken, first.RefreshToken, rotated.AccessToken, rotated.RefreshToken, second.AccessToken, second.RefreshToken} {
		if strings.Contains(logs.String(), secret) {
			t.Fatal("issuance log contains secret or external identity")
		}
	}
}
