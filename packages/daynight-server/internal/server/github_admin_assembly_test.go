package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

const assemblyAppID = "58484824-12a6-42f3-914a-052a6673403b"

type adminAssemblyStore struct {
	store.GitHubAppAdminWriter
	t             *testing.T
	reads, writes int
	invitation    githubpr.AppInvitation
	hash          []byte
}

func (s *adminAssemblyStore) AppAdminVisibility(_ context.Context, appID, userID string) error {
	if appID != assemblyAppID || userID != defaultHTTPPrincipal().UserID {
		s.t.Fatalf("unexpected visibility %q %q", appID, userID)
	}
	return nil
}
func (s *adminAssemblyStore) AdminMembershipVisibility(context.Context, string, string) error {
	s.t.Fatal("unexpected membership visibility")
	return nil
}
func (s *adminAssemblyStore) AdminInvitationVisibility(context.Context, string, string) error {
	s.t.Fatal("unexpected invitation visibility")
	return nil
}

func (s *adminAssemblyStore) AvailableAdminInvitation(context.Context, []byte) (store.GitHubAdminInvitationRef, error) {
	s.t.Fatal("unexpected invitation lookup")
	return store.GitHubAdminInvitationRef{}, nil
}
func (s *adminAssemblyStore) ReadGitHubAppAdmins(ctx context.Context, fn func(store.GitHubAppAdminReader) error) error {
	s.reads++
	return fn(s)
}
func (s *adminAssemblyStore) WriteGitHubAppAdmins(ctx context.Context, appID string, fn func(store.GitHubAppAdminWriter) error) (store.Completion, error) {
	s.writes++
	if appID != assemblyAppID {
		s.t.Fatalf("unexpected App scope %q", appID)
	}
	if err := fn(s); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func (s *adminAssemblyStore) App(_ context.Context, appID string) (githubpr.AppIdentity, error) {
	if appID != assemblyAppID {
		s.t.Fatalf("unexpected App %q", appID)
	}
	return githubpr.AppIdentity{ID: appID}, nil
}
func (s *adminAssemblyStore) Membership(_ context.Context, appID, userID string) (githubpr.AdminMembership, error) {
	if appID != assemblyAppID || userID != defaultHTTPPrincipal().UserID {
		s.t.Fatalf("unexpected membership %q %q", appID, userID)
	}
	return githubpr.AdminMembership{AppID: appID, UserID: userID, Version: 7}, nil
}
func (s *adminAssemblyStore) AdminPage(_ context.Context, appID string, page store.Page) (store.GitHubAppAdminPage, error) {
	if appID != assemblyAppID || page.Limit != 25 || page.After != nil {
		s.t.Fatalf("unexpected list %q %+v", appID, page)
	}
	return store.GitHubAppAdminPage{Items: []githubpr.AdminProfile{}}, nil
}
func (s *adminAssemblyStore) ObservedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC), nil
}
func (s *adminAssemblyStore) CreateInvitation(_ context.Context, invitation githubpr.AppInvitation, hash []byte) error {
	s.invitation, s.hash = invitation, append([]byte(nil), hash...)
	return nil
}

func TestGitHubAdminProductionRouteAssembly(t *testing.T) {
	cfg := configuredTestConfig()
	db := newHTTPTestStore(t)
	client, err := service.NewIdentityClient(cfg.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, db, nil, attachmentTestFiles(t), client)
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	adminStore := &adminAssemblyStore{t: t}
	app.GitHubAdmins = githubservice.NewAdminManager(adminStore)
	witness := &rootIdentityWitness{IdentityOperations: app.Identity}
	app.Identity = witness
	var logs bytes.Buffer
	root, err := New(app, cfg, slog.New(slog.NewTextHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		root.BeginShutdown()
		if err := root.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})

	// All routes share authentication before invoking the administrator store.
	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/github/apps/" + assemblyAppID + "/admins"},
		{http.MethodPost, "/api/v1/github/apps/" + assemblyAppID + "/admins/" + defaultHTTPPrincipal().UserID + "/remove"},
		{http.MethodGet, "/api/v1/github/apps/" + assemblyAppID + "/admin-invitations"},
		{http.MethodPost, "/api/v1/github/apps/" + assemblyAppID + "/admin-invitations"},
		{http.MethodPost, "/api/v1/github/apps/" + assemblyAppID + "/admin-invitations/58484824-12a6-42f3-914a-052a6673403c/revoke"},
		{http.MethodPost, "/api/v1/github-app-admin-invitations/inspect"},
		{http.MethodPost, "/api/v1/github-app-admin-invitations/accept"},
	} {
		res := httptest.NewRecorder()
		root.ServeHTTP(res, httptest.NewRequest(tc.method, tc.path, nil))
		if res.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, res.Code, res.Body.String())
		}
	}
	if witness.calls != 0 || adminStore.reads != 0 || adminStore.writes != 0 {
		t.Fatal("unauthenticated call reached dependencies")
	}

	request := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+defaultHTTPToken())
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		res := httptest.NewRecorder()
		root.ServeHTTP(res, req)
		return res
	}
	base := "/api/v1/github/apps/" + assemblyAppID
	res := request(http.MethodGet, base+"/admins", "")
	if res.Code != http.StatusOK || adminStore.reads != 1 || !strings.Contains(res.Body.String(), `"items":[]`) {
		t.Fatalf("admin list: %d %s logs=%s", res.Code, res.Body.String(), logs.String())
	}
	res = request(http.MethodPost, base+"/admin-invitations", `{"expectedUserId":"`+defaultHTTPPrincipal().UserID+`"}`)
	if res.Code != http.StatusCreated || adminStore.writes != 1 {
		t.Fatalf("invitation: %d %s", res.Code, res.Body.String())
	}
	var created api.CreatedGitHubAppAdminInvitation
	if err := json.Unmarshal(res.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	prefix := cfg.Server.PublicOrigin + "/github-app-admin-invitations#"
	if !strings.HasPrefix(created.Link, prefix+"dn_gai_") || created.AppID != assemblyAppID || created.CreatedBy != defaultHTTPPrincipal().UserID || created.IssuerMembershipVersion != "7" || !created.Available {
		t.Fatalf("unexpected invitation response: %+v", created.GitHubAppAdminInvitation)
	}
	if !bytes.Equal(adminStore.hash, secretutil.Hash(strings.TrimPrefix(created.Link, prefix))) {
		t.Fatal("published link does not match stored invitation")
	}
	if witness.calls != 2 || adminStore.invitation.ID != created.ID {
		t.Fatalf("authentication calls=%d", witness.calls)
	}
}
