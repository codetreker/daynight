package github

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type projectionAuth struct{}

func (projectionAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r, model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: projectAppGrant})
	}
}

type projectionStore struct {
	t               *testing.T
	facts           store.GitHubProjectAppFacts
	reads, appReads int
}

func (s *projectionStore) ReadGitHubProjectApp(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
	if id != projectID {
		s.t.Fatalf("unexpected Project %s", id)
	}
	s.reads++
	return work(s)
}
func (s *projectionStore) WriteGitHubProjectApp(context.Context, string, string, string, func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
	s.t.Fatal("unexpected write")
	return store.Completion{}, nil
}
func (s *projectionStore) Facts(_ context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
	if p.UserID != userID || p.CredentialID != projectAppGrant || p.Kind != model.SessionCredential {
		s.t.Fatalf("principal: %+v", p)
	}
	return s.facts, nil
}
func (s *projectionStore) App(_ context.Context, app, grant, team string) (store.GitHubProjectApp, error) {
	s.appReads++
	if app != appID || grant != projectAppGrant || team != userID {
		s.t.Fatalf("App selection: %s %s %s", app, grant, team)
	}
	return store.GitHubProjectApp{ID: appID, Name: "Shared App", GitHubSlug: "shared-app", GitHubAppID: 9, Version: 2, CredentialVersion: 3}, nil
}

func TestProjectAppHTTPProjectsConnectedIdentityByTeamRole(t *testing.T) {
	for _, tc := range []struct {
		name     string
		teamRole *model.ProjectRole
		manage   bool
	}{
		{"direct Project admin", nil, false},
		{"Team member", pointer(model.ProjectMemberRole), false},
		{"Team admin", pointer(model.ProjectAdmin), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := githubpr.DefaultConnection(projectID)
			c.Enabled = true
			c.AppID, c.InstallationID, c.RepositoryID = pointer(int64(9)), pointer(int64(8)), pointer(int64(7))
			c.InstallationAccountLogin, c.RepositoryFullName = pointer("owner"), pointer("owner/repo")
			db := &projectionStore{t: t, facts: store.GitHubProjectAppFacts{
				Project: model.Project{Ownership: model.ProjectOwnership{TeamID: userID}},
				Access:  model.ProjectAccess{Role: model.ProjectAdmin, TeamRole: tc.teamRole}, Connection: c,
				AppResourceID: pointer(appID), GrantID: pointer(projectAppGrant), CredentialVersion: pointer(int64(3)),
			}}
			mux := http.NewServeMux()
			RegisterProjectAppRoutes(mux, service.NewProjectAppManager(db, nil), projectionAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/github", nil))
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || w.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s err=%v", w.Code, w.Body, err)
			}
			wantApp := map[string]any{"id": appID, "name": "Shared App", "githubSlug": "shared-app", "githubAppId": "9"}
			if body["connection"] != "connected" || body["canManageConnection"] != tc.manage || !reflect.DeepEqual(body["app"], wantApp) {
				t.Fatalf("projection: %s", w.Body)
			}
			grant, present := body["grantId"]
			if !present || (tc.manage && grant != projectAppGrant) || (!tc.manage && grant != nil) {
				t.Fatalf("grant projection: %s", w.Body)
			}
			if db.reads != 1 || db.appReads != 1 {
				t.Fatalf("reads=%d App reads=%d", db.reads, db.appReads)
			}
		})
	}
}
