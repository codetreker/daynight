package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

func TestProjectAppTransactionLogging(t *testing.T) {
	for _, tc := range []struct {
		name, action                             string
		outcome                                  store.TransactionOutcome
		noOp, refuse, cancel, failBeforeCallback bool
	}{
		{name: "connect", action: "connect", outcome: store.TransactionCommitted},
		{name: "disconnect", action: "disconnect", outcome: store.TransactionCommitted},
		{name: "settings", action: "settings", outcome: store.TransactionCommitted},
		{name: "sync", action: "sync", outcome: store.TransactionCommitted},
		{name: "no_op", action: "disconnect", outcome: store.TransactionCommitted, noOp: true},
		{name: "rollback", action: "connect", outcome: store.TransactionNotCommitted},
		{name: "unknown", action: "connect", outcome: store.TransactionUnknown},
		{name: "refusal", action: "disconnect", outcome: store.TransactionNotCommitted, refuse: true},
		{name: "cancelled", action: "connect", outcome: store.TransactionNotCommitted, cancel: true},
		{name: "scope_failure", action: "connect", outcome: store.TransactionNotCommitted, failBeforeCallback: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			const secret = "private-key webhook-secret invitation-token raw-remote-body"
			var logs bytes.Buffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			ctx, cancel := context.WithCancel(requestid.With(t.Context(), "project-app-request"))
			defer cancel()
			initial := projectAppServiceFacts()
			initial.Connection.Version, initial.Connection.Generation = 7, 11
			if tc.refuse {
				initial.Access.TeamRole = nil
			}
			appID, credential, installation, repository := int64(13), int64(3), int64(99), int64(42)
			if tc.action != "connect" && !tc.noOp {
				initial.AppResourceID, initial.GrantID, initial.CredentialVersion = stringPtr(projectAppResource), stringPtr(projectAppGrantID), &credential
				initial.Connection.Enabled = true
				initial.Connection.AccessState = "available"
				initial.Connection.AppID, initial.Connection.InstallationID, initial.Connection.RepositoryID = &appID, &installation, &repository
			}
			factsCalls, appCalls, saves, impacts, writes := 0, 0, 0, 0, 0
			saved := false
			dao := projectAppReadDAO(t, initial)
			dao.facts = func(context.Context, model.Principal) (store.GitHubProjectAppFacts, error) {
				factsCalls++
				if factsCalls > 2 {
					t.Fatal("unexpected extra facts query")
				}
				f := initial
				// These are independently supplied post-operation facts, not persistence.
				if saved {
					f.Connection.Version = 8
					f.Connection.Generation = 12
					if tc.action == "settings" {
						f.Connection.Generation = 11
					}
					if tc.action == "connect" {
						f.AppResourceID, f.GrantID, f.CredentialVersion = stringPtr(projectAppResource), stringPtr(projectAppGrantID), &credential
						f.Connection.AppID, f.Connection.InstallationID, f.Connection.RepositoryID = &appID, &installation, &repository
						f.Connection.Enabled = true
					}
					if tc.action == "disconnect" {
						f.AppResourceID, f.GrantID, f.CredentialVersion = nil, nil, nil
						f.Connection.AppID, f.Connection.InstallationID = nil, nil
						f.Connection.Enabled, f.Connection.SyncEnabled = false, false
					}
				}
				return f, nil
			}
			originalApp := dao.app
			dao.app = func(ctx context.Context, a, g, team string) (store.GitHubProjectApp, error) {
				appCalls++
				if appCalls > 2 {
					t.Fatal("unexpected extra App query")
				}
				aResult, err := originalApp(ctx, a, g, team)
				aResult.Name, aResult.GitHubSlug = secret, secret
				return aResult, err
			}
			dao.save = func(_ context.Context, w store.GitHubProjectAppWrite) (bool, error) {
				saves++
				if saves > 1 || w.Configuration.Version != 8 {
					t.Fatalf("unexpected save: %+v", w)
				}
				saved = true
				return true, nil
			}
			dao.impact = func(context.Context, string) error { impacts++; return nil }
			cause := errors.New(secret)
			db := projectAppScopeStub{t: t, write: func(workCtx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				if requestid.From(workCtx) != "project-app-request" || id != mgmtProject || actor != mgmtPrincipal.UserID {
					t.Fatal("wrong scope context or identity")
				}
				if tc.failBeforeCallback {
					return store.Completion{Outcome: tc.outcome}, cause
				}
				callbackErr := work(dao)
				if tc.refuse && callbackErr == nil {
					t.Fatal("refusal was not executed")
				}
				if !tc.refuse && callbackErr != nil {
					t.Fatal(callbackErr)
				}
				if tc.cancel {
					cancel()
					return store.Completion{Outcome: tc.outcome}, errors.Join(context.Canceled, cause)
				}
				if tc.outcome != store.TransactionCommitted {
					// Contradictory nested metadata must not override scope Completion.
					return store.Completion{Outcome: tc.outcome}, errors.Join(callbackErr, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: cause})
				}
				return store.Completion{Outcome: tc.outcome}, callbackErr
			}}
			selection := projectAppServiceSelection()
			if tc.action != "connect" {
				selection.AppResourceID, selection.GrantID = "", ""
			}
			input := core.ProjectAppConnect{ProjectAppSelection: selection, Version: 7, InstallationID: 99, RepositoryVersion: initial.RepositoryVersion}
			candidate := core.InstallationCandidate{}
			candidate.Installation.ID, candidate.Installation.AccountLogin = 99, "owner"
			candidate.Repository.ID, candidate.Repository.FullName = 42, "owner/repo"
			result, err := NewProjectAppManager(db, nil, logger).write(ctx, mgmtPrincipal, mgmtProject, tc.action, input, 17, true, initial.Project.RepoURL, candidate)
			if tc.outcome == store.TransactionCommitted && err != nil {
				t.Fatal(err)
			}
			if tc.outcome != store.TransactionCommitted && (err == nil || result.Connection.Version != 0) {
				t.Fatalf("completion result=%+v err=%v", result, err)
			}
			if writes != 1 {
				t.Fatalf("writes=%d", writes)
			}
			wantSaves := 1
			if tc.noOp || tc.refuse || tc.failBeforeCallback {
				wantSaves = 0
			}
			if saves != wantSaves {
				t.Fatalf("saves=%d want=%d", saves, wantSaves)
			}
			if impacts > 1 {
				t.Fatalf("impacts=%d", impacts)
			}
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatalf("logs=%s: %v", logs.String(), err)
			}
			for key, want := range map[string]any{"component": "github", "phase": tc.action, "request_id": "project-app-request", "user_id": mgmtPrincipal.UserID, "project_id": mgmtProject, "write_outcome": string(tc.outcome)} {
				if record[key] != want {
					t.Errorf("%s=%v want=%v", key, record[key], want)
				}
			}
			if strings.Count(logs.String(), `"write_outcome"`) != 1 {
				t.Fatal("duplicate transaction outcome")
			}
			for _, marker := range strings.Fields(secret) {
				if strings.Contains(logs.String(), marker) {
					t.Fatalf("secret leaked: %s", logs.String())
				}
			}
			if tc.failBeforeCallback {
				if _, ok := record["team_id"]; ok {
					t.Fatal("invented authorization facts")
				}
			} else if record["team_id"] != projectAppTeamID || record["ownership_version"] != float64(8) {
				t.Fatalf("ownership=%v", record)
			}
			if tc.outcome == store.TransactionCommitted {
				wantGeneration := float64(12)
				if tc.noOp || tc.action == "settings" {
					wantGeneration = 11
				}
				if record["generation"] != wantGeneration {
					t.Fatalf("generation=%v", record)
				}
			} else if _, ok := record["generation"]; ok {
				t.Fatal("uncommitted generation reported as durable")
			}
			if !tc.noOp && !tc.refuse && !tc.failBeforeCallback {
				if record["app_resource_id"] != projectAppResource || record["grant_id"] != projectAppGrantID || record["credential_version"] != float64(3) || record["app_id"] != float64(13) {
					t.Fatalf("binding=%v", record)
				}
			}
		})
	}
}

func stringPtr(s string) *string { return &s }

func TestProjectAppObservationDiscardsPartialFailures(t *testing.T) {
	secret := errors.New("private-key webhook-secret token remote-body")
	observed := &projectAppObservation{}
	dao := &observedProjectAppDAO{observation: observed, GitHubProjectAppWriteDAO: projectAppDAOStub{
		facts: func(context.Context, model.Principal) (store.GitHubProjectAppFacts, error) {
			return projectAppServiceFacts(), secret
		},
		app: func(context.Context, string, string, string) (store.GitHubProjectApp, error) {
			return store.GitHubProjectApp{ID: projectAppResource, Version: 7}, secret
		},
		save: func(context.Context, store.GitHubProjectAppWrite) (bool, error) { return true, secret },
	}}
	if _, err := dao.Facts(t.Context(), mgmtPrincipal); err != secret {
		t.Fatal(err)
	}
	if _, err := dao.App(t.Context(), projectAppResource, projectAppGrantID, projectAppTeamID); err != secret {
		t.Fatal(err)
	}
	if _, err := dao.Save(t.Context(), store.GitHubProjectAppWrite{}); err != secret {
		t.Fatal(err)
	}
	if observed.facts != nil || observed.app != nil || observed.proposed != nil {
		t.Fatalf("captured failed observations: %+v", observed)
	}
}
