package github

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

func TestProjectAppManagerSettingsContextAndCompletion(t *testing.T) {
	cause := errors.New("transaction failure")
	for _, tc := range []struct {
		name       string
		outcome    store.TransactionOutcome
		completion error
		refused    bool
		code       string
	}{
		{"committed", store.TransactionCommitted, nil, false, ""},
		{"unknown", store.TransactionUnknown, cause, false, "github_write_outcome_unknown"},
		{"not committed", store.TransactionNotCommitted, nil, false, "error"},
		{"store failure", store.TransactionNotCommitted, cause, false, "error"},
		{"member refusal", store.TransactionNotCommitted, nil, true, "forbidden"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			facts := projectAppServiceFacts()
			if tc.refused {
				facts.Access.Role = model.ProjectMemberRole
			}
			dao := projectAppReadDAO(t, facts)
			writes, saves := 0, 0
			dao.save = func(ctx context.Context, w store.GitHubProjectAppWrite) (bool, error) {
				saves++
				if w.Configuration.PollIntervalMinutes != 10 || w.Configuration.ExpectedVersion != 1 || w.Configuration.Version != 2 || w.ClearWork {
					t.Fatalf("settings write: %+v", w)
				}
				return true, nil
			}
			db := projectAppScopeStub{t: t, write: func(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				deadline, ok := ctx.Deadline()
				if id != mgmtProject || actor != mgmtPrincipal.UserID || app != "" || requestid.From(ctx) != "sync-context" || !ok || time.Until(deadline) <= 0 {
					t.Fatalf("scope/context: %s %s %s", id, actor, app)
				}
				return store.Completion{Outcome: tc.outcome}, errors.Join(work(dao), tc.completion)
			}}
			ctx := requestid.With(context.Background(), "sync-context")
			_, err := NewProjectAppManager(db, nil, slog.Default()).Settings(ctx, mgmtPrincipal, mgmtProject, 1, 10)
			wantSaves := 1
			if tc.refused {
				wantSaves = 0
			}
			if writes != 1 || saves != wantSaves {
				t.Fatalf("writes=%d saves=%d error=%v", writes, saves, err)
			}
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || tc.completion != nil && !errors.Is(err, tc.completion) {
				t.Fatalf("completion: %v", err)
			}
			if tc.code != "error" {
				assertManagementCode(t, err, tc.code)
			}
		})
	}
}

func TestProjectAppManagerSyncCarriesContextAndReportsOutcome(t *testing.T) {
	cause := errors.New("commit receipt lost")
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			facts := projectAppServiceFacts()
			appID, installationID, repositoryID, credential := int64(13), int64(99), int64(42), int64(3)
			facts.AppResourceID, facts.GrantID, facts.CredentialVersion = stringPointer(projectAppResource), stringPointer(projectAppGrantID), &credential
			facts.Connection.Enabled, facts.Connection.AppID, facts.Connection.InstallationID, facts.Connection.RepositoryID, facts.Connection.AccessState = true, &appID, &installationID, &repositoryID, "available"
			dao := projectAppReadDAO(t, facts)
			dao.facts = func(_ context.Context, principal model.Principal) (store.GitHubProjectAppFacts, error) {
				if principal != mgmtPrincipal {
					t.Fatalf("principal=%+v", principal)
				}
				return facts, nil
			}
			writes, saves := 0, 0
			dao.save = func(_ context.Context, w store.GitHubProjectAppWrite) (bool, error) {
				saves++
				if !w.Configuration.SyncEnabled || w.Configuration.Version != 2 || w.Configuration.Generation != 1 || w.Configuration.NextPollAt == nil || w.ClearWork {
					t.Fatalf("sync write=%+v", w)
				}
				facts.Connection.SyncEnabled, facts.Connection.Version, facts.Connection.Generation = true, w.Configuration.Version, w.Configuration.Generation
				return true, nil
			}
			db := projectAppScopeStub{t: t, write: func(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				deadline, ok := ctx.Deadline()
				if id != mgmtProject || actor != mgmtPrincipal.UserID || app != "" || requestid.From(ctx) != "sync-context" || !ok || time.Until(deadline) <= 0 {
					t.Fatalf("scope/context=%s %s %s", id, actor, app)
				}
				err := work(dao)
				if outcome == store.TransactionUnknown {
					err = errors.Join(err, cause)
				}
				return store.Completion{Outcome: outcome}, err
			}}
			ctx := requestid.With(context.Background(), "sync-context")
			result, err := NewProjectAppManager(db, nil, slog.Default()).Sync(ctx, mgmtPrincipal, mgmtProject, 1, true)
			if writes != 1 || saves != 1 {
				t.Fatalf("writes=%d saves=%d err=%v", writes, saves, err)
			}
			if outcome == store.TransactionUnknown {
				assertManagementCode(t, err, "github_write_outcome_unknown")
				if !errors.Is(err, cause) {
					t.Fatalf("lost cause: %v", err)
				}
			} else if err != nil || !result.Connection.SyncEnabled {
				t.Fatalf("committed=%+v err=%v", result, err)
			}
		})
	}
}

func stringPointer(value string) *string { return &value }

func TestProjectAppManagerRechecksAuthorizationAfterProof(t *testing.T) {
	for _, scenario := range []struct {
		name, code string
		change     func(*store.GitHubProjectAppFacts)
	}{
		{"team authority revoked", "forbidden", func(f *store.GitHubProjectAppFacts) { f.Access.TeamRole = nil }},
		{"repository changed", "github_repository_mismatch", func(f *store.GitHubProjectAppFacts) { f.Project.RepoURL = "https://github.com/owner/changed" }},
		{"configuration changed", "version_conflict", func(f *store.GitHubProjectAppFacts) { f.Connection.Version++ }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) { projectAppRemoteResponse(t, w, r) })
			original := projectAppServiceFacts()
			reads, writes, releases := 0, 0, 0
			db := projectAppScopeStub{t: t, read: func(_ context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				reads++
				if id != mgmtProject {
					t.Fatalf("project=%s", id)
				}
				return work(projectAppReadDAO(t, original))
			}, write: func(_ context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				if id != mgmtProject || actor != mgmtPrincipal.UserID || app != projectAppResource {
					t.Fatalf("scope=%s %s %s", id, actor, app)
				}
				current := original
				scenario.change(&current)
				dao := projectAppReadDAO(t, current)
				dao.save = func(context.Context, store.GitHubProjectAppWrite) (bool, error) {
					t.Fatal("stale proof wrote configuration")
					return false, nil
				}
				return store.Completion{Outcome: store.TransactionNotCommitted}, work(dao)
			}}
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				return client, func() { releases++ }, nil
			})
			_, err := NewProjectAppManager(db, provider, slog.Default()).Connect(t.Context(), mgmtPrincipal, mgmtProject, core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99})
			assertManagementCode(t, err, scenario.code)
			if reads != 1 || writes != 1 || releases != 1 {
				t.Fatalf("reads=%d writes=%d releases=%d", reads, writes, releases)
			}
		})
	}
}
