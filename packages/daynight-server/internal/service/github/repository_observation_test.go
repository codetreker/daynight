package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func observationFixture() (store.GitHubProjectAppFacts, *store.GitHubProjectApp) {
	f := projectAppServiceFacts()
	repository, installation, credential := int64(42), int64(99), int64(3)
	f.Connection.RepositoryID, f.Connection.InstallationID = &repository, &installation
	f.AppResourceID, f.GrantID, f.CredentialVersion = stringPtr(projectAppResource), stringPtr(projectAppGrantID), &credential
	return f, &store.GitHubProjectApp{ID: projectAppResource, CredentialVersion: credential}
}

func TestObserveRepositoryRestrictsCandidateLookup(t *testing.T) {
	for _, teamAdmin := range []bool{false, true} {
		t.Run(fmt.Sprintf("team_admin=%t", teamAdmin), func(t *testing.T) {
			f, app := observationFixture()
			if !teamAdmin {
				f.Access.TeamRole = nil
			}
			var requests []string
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.Method+" "+r.URL.Path)
				switch r.URL.Path {
				case "/app/installations/99/access_tokens":
					w.WriteHeader(http.StatusCreated)
					fmt.Fprintf(w, `{"token":"token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
				case "/installation/repositories":
					fmt.Fprint(w, `{"repositories":[{"id":42,"full_name":"owner/renamed","private":true}]}`)
				case "/repos/other/candidate":
					if !teamAdmin {
						t.Error("Project administrator probed candidate path")
					}
					fmt.Fprint(w, `{"id":43,"full_name":"other/candidate","private":false}`)
				default:
					t.Errorf("unexpected request: %s", r.URL.Path)
					http.NotFound(w, r)
				}
			})
			acquired, released := 0, 0
			provider := projectAppAcquireFunc(func(_ context.Context, id string, version int64) (*remote.Client, func(), error) {
				acquired++
				if id != app.ID || version != app.CredentialVersion {
					t.Fatalf("acquire: %s %d", id, version)
				}
				return client, func() { released++ }, nil
			})
			evidence := NewProjectAppManager(nil, provider, slog.Default()).ObserveRepository(t.Context(), f, app, "https://github.com/other/candidate")
			if evidence.OldID == nil || *evidence.OldID != 42 || evidence.OldFullName != "owner/renamed" {
				t.Fatalf("old identity: %+v", evidence)
			}
			want := []string{"POST /app/installations/99/access_tokens", "GET /installation/repositories"}
			if teamAdmin {
				want = append(want, "GET /repos/other/candidate")
				if evidence.TargetID == nil || *evidence.TargetID != 43 || evidence.TargetFullName != "other/candidate" || evidence.TargetPrivate {
					t.Fatalf("target identity: %+v", evidence)
				}
			} else if evidence.TargetID != nil || evidence.TargetFullName != "" || evidence.UnverifiedReason != "no_github_access" {
				t.Fatalf("unexpected candidate disclosure: %+v", evidence)
			}
			if !reflect.DeepEqual(requests, want) || acquired != 1 || released != 1 {
				t.Fatalf("requests=%v acquired=%d released=%d", requests, acquired, released)
			}
		})
	}
}

func TestObserveRepositoryUnavailableOrUnsupported(t *testing.T) {
	for _, tc := range []struct {
		name, address, reason string
		setup                 func(*store.GitHubProjectAppFacts, **store.GitHubProjectApp)
		acquire               bool
	}{
		{"unsupported host", "https://example.test/owner/repo", "unsupported_host", nil, false},
		{"missing old identity", "https://github.com/owner/repo", "no_verified_repository", func(f *store.GitHubProjectAppFacts, app **store.GitHubProjectApp) {
			f.Connection.RepositoryID = nil
			*app = nil
		}, false},
		{"missing grant", "https://github.com/owner/repo", "no_github_access", func(f *store.GitHubProjectAppFacts, _ **store.GitHubProjectApp) { f.GrantID = nil }, false},
		{"changed credential", "https://github.com/owner/repo", "no_github_access", func(_ *store.GitHubProjectAppFacts, app **store.GitHubProjectApp) { (*app).CredentialVersion++ }, false},
		{"provider failure", "https://github.com/owner/repo", "provider_unavailable", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, app := observationFixture()
			if tc.setup != nil {
				tc.setup(&f, &app)
			}
			acquired := 0
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				acquired++
				return nil, nil, errors.New("offline")
			})
			got := NewProjectAppManager(nil, provider, slog.Default()).ObserveRepository(t.Context(), f, app, tc.address)
			if got.UnverifiedReason != tc.reason || got.TargetID != nil || (acquired == 1) != tc.acquire {
				t.Fatalf("evidence=%+v acquired=%d", got, acquired)
			}
		})
	}
}

func TestObserveRepositoryRemoteFailureDoesNotInventIdentity(t *testing.T) {
	f, app := observationFixture()
	role := model.ProjectAdmin
	f.Access.TeamRole = &role
	client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/app/installations/99/access_tokens" {
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	released := 0
	provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
		return client, func() { released++ }, nil
	})
	got := NewProjectAppManager(nil, provider, slog.Default()).ObserveRepository(t.Context(), f, app, "https://github.com/owner/repo")
	if got.OldID == nil || *got.OldID != 42 || got.OldFullName != "" || got.TargetID != nil || got.UnverifiedReason != "provider_unavailable" || released != 1 {
		t.Fatalf("evidence=%+v releases=%d", got, released)
	}
}
