package github

import (
	"context"
	"crypto/rsa"
	"errors"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func (s *appTestStore) RequireAppVisible(_ context.Context, id, actor string) error {
	s.visibilityCalls++
	if id == "" || actor == "" {
		panic("missing visibility identity")
	}
	if s.missing {
		return model.ErrNotFound
	}
	return nil
}

func scopeAppAuth(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	p, e := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if e != nil {
		t.Fatal(e)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, CredentialID: "33333333-3333-4333-8333-333333333333", UserID: "a29f02b3-8966-412e-a789-847503bb40de"}, Profile: model.ScopedPATProfile, Policy: &p}
}
func scopeAppFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestScopedAppVisibilityAndWriteAdmission(t *testing.T) {
	ctx := context.Background()
	db := &appTestStore{}
	proofs := 0
	m := &AppManager{db: db, verify: func(context.Context, int64, *rsa.PrivateKey) (remote.AppIdentity, error) {
		proofs++
		return remote.AppIdentity{}, nil
	}}
	read := scopeAppAuth(t, "github:read")
	write := scopeAppAuth(t, "github:manage")
	id := "7cb65a54-6173-42fa-b789-df86414a19c1"
	db.missing = true
	_, err := m.GetAppAuthorized(ctx, write, id)
	scopeAppFault(t, err, "not_found")
	db.missing = false
	if db.getCalls != 0 {
		t.Fatal("invisible App projection was fetched")
	}
	got, err := m.GetAppAuthorized(ctx, write, id)
	scopeAppFault(t, err, "insufficient_scope")
	if db.getCalls != 0 {
		t.Fatal("scope refusal fetched App projection")
	}
	if got != (core.AppMetadata{}) {
		t.Fatal("scope refusal leaked app")
	}
	got, err = m.GetAppAuthorized(ctx, read, id)
	if err != nil || got.ID != id {
		t.Fatalf("got %+v, %v", got, err)
	}
	before := db.readCalls
	_, err = m.ListAppsAuthorized(ctx, write, core.ListAppsInput{})
	scopeAppFault(t, err, "insufficient_scope")
	if db.readCalls != before {
		t.Fatal("list read after refusal")
	}
	input := core.CreateAppInput{ID: id, Name: "App", GitHubAppID: 9, PrivateKeyPEM: "nonempty", WebhookSecret: "secret", ExpectedUserID: read.Principal.UserID}
	for _, auth := range []model.CredentialAuthorization{read, write} {
		_, err = m.CreateAppAuthorized(ctx, auth, input)
		scopeAppFault(t, err, "insufficient_scope")
	}
	if proofs != 0 || db.writeCalls != 0 {
		t.Fatal("denied creation performed proof or write")
	}
	session := model.CredentialAuthorization{Principal: read.Principal, Profile: model.SessionProfile}
	session.Principal.Kind = model.SessionCredential
	if _, err = m.GetAppAuthorized(ctx, session, id); err != nil {
		t.Fatalf("session: %v", err)
	}
	fixed := session
	fixed.Principal.Kind = model.OAuthCredential
	fixed.Profile = model.OAuthAPIProfile
	if _, err = m.GetAppAuthorized(ctx, fixed, id); err != nil {
		t.Fatalf("fixed API: %v", err)
	}
}

type appReaderWithoutVisibility struct{ store.GitHubAppReadDAO }
type appStoreWithoutVisibility struct{ *appTestStore }

func (s appStoreWithoutVisibility) ReadGitHubApps(ctx context.Context, work func(store.GitHubAppReadDAO) error) error {
	return s.appTestStore.ReadGitHubApps(ctx, func(dao store.GitHubAppReadDAO) error { return work(appReaderWithoutVisibility{dao}) })
}
func TestScopedAppReadFailsClosedWithoutVisibilityCapability(t *testing.T) {
	db := &appTestStore{}
	m := NewAppManager(appStoreWithoutVisibility{db})
	auth := scopeAppAuth(t, "github:read")
	if _, err := m.GetAppAuthorized(t.Context(), auth, "7cb65a54-6173-42fa-b789-df86414a19c1"); err == nil || db.getCalls != 0 {
		t.Fatalf("err=%v, projections=%d", err, db.getCalls)
	}
}

func TestScopedCreateRechecksAuthorityAfterRemoteProof(t *testing.T) {
	_, _, key := configServiceFixture(t)
	original := scopeAppAuth(t, "github:manage", "github:read")
	reduced := scopeAppAuth(t, "github:read")
	reduced.Principal = original.Principal
	started, release := make(chan struct{}), make(chan struct{})
	db := &appTestStore{}
	m := &AppManager{db: db, verify: func(_ context.Context, id int64, _ *rsa.PrivateKey) (remote.AppIdentity, error) {
		close(started)
		<-release
		return remote.AppIdentity{ID: id, Name: "verified", Slug: "verified"}, nil
	}, current: func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
		if got.Principal != original.Principal || got.Profile != original.Profile {
			t.Error("credential identity changed")
		}
		return reduced, nil
	}}
	input := core.CreateAppInput{ID: "7cb65a54-6173-42fa-b789-df86414a19c1", Name: "App", GitHubAppID: 9, PrivateKeyPEM: key, WebhookSecret: "secret", ExpectedUserID: original.Principal.UserID}
	done := make(chan error, 1)
	go func() { _, err := m.CreateAppAuthorized(t.Context(), original, input); done <- err }()
	<-started
	close(release)
	scopeAppFault(t, <-done, "insufficient_scope")
	if db.writeCalls != 0 {
		t.Fatal("scope revoked during proof wrote App")
	}
}
