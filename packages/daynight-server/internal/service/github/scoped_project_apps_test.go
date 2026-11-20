package github

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func TestScopedProjectAppPreservesAccessAndStopsBeforeEffects(t *testing.T) {
	auth := scopeAppAuth(t, "github:read")
	facts := projectAppServiceFacts()
	factsErr := error(nil)
	factsCalls, appCalls := 0, 0
	dao := projectAppDAOStub{access: func(_ context.Context, p model.Principal) (store.GitHubProjectAppAccess, error) {
		return store.GitHubProjectAppAccess{Access: facts.Access, TeamID: facts.Project.Ownership.TeamID, OwnershipVersion: facts.Project.Ownership.Version, ConnectionVersion: facts.Connection.Version}, factsErr
	}, version: func(context.Context, string, string, string) (int64, error) { return 2, nil }, facts: func(_ context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
		factsCalls++
		if p != auth.Principal {
			t.Fatal("principal changed")
		}
		return facts, factsErr
	}, app: func(context.Context, string, string, string) (store.GitHubProjectApp, error) {
		appCalls++
		return store.GitHubProjectApp{ID: projectAppResource, GitHubAppID: 13, Version: 2, CredentialVersion: 3}, nil
	}, save: func(context.Context, store.GitHubProjectAppWrite) (bool, error) {
		t.Fatal("unexpected save")
		return false, nil
	}}
	db := projectAppScopeStub{t: t, read: func(_ context.Context, _ string, work func(store.GitHubProjectAppReadDAO) error) error {
		return work(dao)
	}, write: func(_ context.Context, _, _, _ string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
		e := work(dao)
		return store.Completion{Outcome: store.TransactionNotCommitted}, e
	}}
	providerCalls := 0
	provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
		providerCalls++
		t.Fatal("unexpected remote proof")
		return nil, nil, nil
	})
	m := NewProjectAppManager(db, provider, slog.Default())
	input := core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99}
	factsErr = model.ErrNotFound
	_, err := m.ConnectAuthorized(t.Context(), auth, mgmtProject, input)
	scopeAppFault(t, err, "not_found")
	factsErr = nil
	_, err = m.ConnectAuthorized(t.Context(), auth, mgmtProject, input)
	scopeAppFault(t, err, "insufficient_scope")
	if providerCalls != 0 {
		t.Fatal("denial performed remote proof")
	}
	_, err = m.SettingsAuthorized(t.Context(), auth, mgmtProject, 1, 15)
	scopeAppFault(t, err, "insufficient_scope")
	denied := scopeAppAuth(t, "github:manage")
	denied.Principal = auth.Principal
	_, err = m.GetAuthorized(t.Context(), denied, mgmtProject)
	scopeAppFault(t, err, "insufficient_scope")
	if factsCalls != 0 || appCalls != 0 {
		t.Fatalf("refusal read protected projections: facts=%d app=%d", factsCalls, appCalls)
	}

}

func TestScopedProjectAppRechecksAuthorityAfterRemoteProof(t *testing.T) {
	for _, operation := range []string{"discover", "connect"} {
		t.Run(operation, func(t *testing.T) {
			original := scopeAppAuth(t, "github:manage", "github:read")
			reduced := scopeAppAuth(t, "task:read")
			reduced.Principal = original.Principal
			started, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
				once.Do(func() { close(started); <-release })
				projectAppRemoteResponse(t, w, r)
			})
			facts := projectAppServiceFacts()
			dao := projectAppDAOStub{access: func(_ context.Context, p model.Principal) (store.GitHubProjectAppAccess, error) {
				return store.GitHubProjectAppAccess{Access: facts.Access, TeamID: facts.Project.Ownership.TeamID, OwnershipVersion: facts.Project.Ownership.Version, ConnectionVersion: facts.Connection.Version}, nil
			}, version: func(context.Context, string, string, string) (int64, error) { return 2, nil }, facts: func(_ context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
				if p != original.Principal {
					t.Error("principal changed")
				}
				return facts, nil
			}, app: func(context.Context, string, string, string) (store.GitHubProjectApp, error) {
				return store.GitHubProjectApp{ID: projectAppResource, GitHubAppID: 13, Version: 2, CredentialVersion: 3}, nil
			}, save: func(context.Context, store.GitHubProjectAppWrite) (bool, error) {
				t.Error("scope revoked during proof wrote connection")
				return false, nil
			}}
			db := projectAppScopeStub{t: t, read: func(_ context.Context, _ string, work func(store.GitHubProjectAppReadDAO) error) error {
				return work(dao)
			}, write: func(_ context.Context, _, _, _ string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				e := work(dao)
				return store.Completion{Outcome: store.TransactionNotCommitted}, e
			}}
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) { return client, func() {}, nil })
			m := NewScopedProjectAppManager(db, provider, slog.Default(), func(_ context.Context, got model.CredentialAuthorization) (model.CredentialAuthorization, error) {
				if got.Principal != original.Principal || got.Profile != original.Profile {
					t.Error("credential identity changed")
				}
				return reduced, nil
			})
			done := make(chan error, 1)
			go func() {
				if operation == "discover" {
					out, e := m.DiscoverAuthorized(t.Context(), original, mgmtProject, projectAppServiceSelection())
					if out != (core.InstallationCandidate{}) {
						t.Error("discovery data leaked")
					}
					done <- e
					return
				}
				_, e := m.ConnectAuthorized(t.Context(), original, mgmtProject, core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99})
				done <- e
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("remote proof did not start")
			}
			close(release)
			scopeAppFault(t, <-done, "insufficient_scope")
		})
	}
}
