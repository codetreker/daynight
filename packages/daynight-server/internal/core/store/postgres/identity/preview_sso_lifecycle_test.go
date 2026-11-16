package identity_test

import (
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestPreviewSSOServicePostgresLifecycle(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	source, mainSecret := core.NewIdentity("https://daynight.cc/api/v1/auth/callback").NewSession(now)
	source.UserID = user.ID
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		if _, err := scope.IdentityDAO().UpsertUser(ctx, user, now); err != nil {
			return err
		}
		return scope.IdentityDAO().InsertSession(ctx, source)
	})
	main := service.New(db, nil, "https://daynight.cc/api/v1/auth/callback")
	preview, err := service.NewPreviewSSO(db, "https://daynight.cc", "https://preview.daynight.cc", "https://daynight.cc/api/v1/auth/callback")
	requireNoError(t, err)
	principal, err := main.Authenticate(ctx, model.SessionCredential, mainSecret)
	requireNoError(t, err)
	if principal != (model.Principal{Kind: model.SessionCredential, CredentialID: source.ID, UserID: user.ID}) {
		t.Fatalf("main principal: %+v", principal)
	}
	target := "https://daynight.cc/projects?filter=a%2Fb&x=1"
	login, err := preview.Create(ctx, target)
	requireNoError(t, err)
	start, err := preview.Start(ctx, login.ID)
	requireNoError(t, err)
	authorization, err := preview.Authorize(ctx, login.ID, start.State, principal)
	requireNoError(t, err)
	if authorization.Code == mainSecret || authorization.ExpiresAt.After(time.Now().Add(time.Minute+time.Second)) || !authorization.ExpiresAt.After(time.Now()) {
		t.Fatalf("invalid code or expiry: %+v", authorization)
	}
	_, err = preview.Redeem(ctx, authorization.Code, start.State, secret.Random(""))
	if err == nil {
		t.Fatal("mismatched browser binding accepted")
	}
	redemption, err := preview.Redeem(ctx, authorization.Code, start.State, start.State)
	requireNoError(t, err)
	if redemption.LoginID != login.ID || redemption.Secret == mainSecret || !redemption.ExpiresAt.Equal(source.ExpiresAt) {
		t.Fatalf("redemption: %+v", redemption)
	}
	_, err = preview.Redeem(ctx, authorization.Code, start.State, start.State)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("reused code accepted or wrong failure: %v", err)
	}
	observed, expiry, err := preview.Authenticate(ctx, redemption.Secret)
	requireNoError(t, err)
	if observed != principal || !expiry.Equal(source.ExpiresAt) {
		t.Fatalf("preview session mismatch: %+v expiry=%v", observed, expiry)
	}
	mainAgain, err := main.Authenticate(ctx, model.SessionCredential, mainSecret)
	requireNoError(t, err)
	if mainAgain != principal {
		t.Fatalf("main session changed: %+v", mainAgain)
	}
	_, err = preview.Complete(ctx, login.ID, secret.Random("dnpv_"))
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("wrong preview credential accepted: %v", err)
	}
	returned, err := preview.Complete(ctx, login.ID, redemption.Secret)
	requireNoError(t, err)
	if returned != target {
		t.Fatalf("return target changed: %q", returned)
	}
	var sessions, logins int
	err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM sessions),(SELECT count(*) FROM preview_sso_logins)`).Scan(&sessions, &logins)
	requireNoError(t, err)
	if sessions != 1 || logins != 0 {
		t.Fatalf("unexpected persistent records: sessions=%d logins=%d", sessions, logins)
	}
	requireNoError(t, main.Logout(ctx, principal))
	_, err = main.Authenticate(ctx, model.SessionCredential, mainSecret)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("main credential survived logout: %v", err)
	}
	_, _, err = preview.Authenticate(ctx, redemption.Secret)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("preview credential survived logout: %v", err)
	}
}
