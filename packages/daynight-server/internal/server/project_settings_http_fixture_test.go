package server

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func settingsHTTPWrite(t *testing.T, f *projectAccessHTTPFixture, actor model.Principal, id string, input coreproject.UpdateProjectSettings, result model.Project, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	f.projects.UpdateSettingsCall = func(ctx context.Context, principal model.Principal, gotID string, got coreproject.UpdateProjectSettings) (model.Project, error) {
		called()
		f.require(ctx, principal, actor, gotID, id)
		projectHTTPCheck(t, got, input)
		return result, failure
	}
}

func settingsHTTPGraph(t *testing.T, f *projectAccessHTTPFixture, actor model.Principal, value model.Project, taskID string) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	f.tasks.GraphCall = func(ctx context.Context, principal model.Principal, projectID, root string) (model.TaskGraph, error) {
		called()
		f.require(ctx, principal, actor, projectID, value.ID)
		projectHTTPCheck(t, root, taskID)
		return model.TaskGraph{Project: value, ObservedAt: value.UpdatedAt.Add(time.Minute), Summary: model.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}, Tasks: []model.GraphTask{{ID: taskID, TitlePreview: "Settings context", Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: value.CreatedAt, UpdatedAt: value.CreatedAt}}}, nil
	}
}

func settingsHTTPAuthenticate(t *testing.T, f *projectAccessHTTPFixture, kind model.CredentialKind, value string, principal model.Principal, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	f.identity.AuthenticateFn = func(ctx context.Context, gotKind model.CredentialKind, token string) (model.Principal, error) {
		called()
		f.requestContext = ctx
		if ctx.Err() != nil {
			t.Fatalf("authentication received canceled context: %v", ctx.Err())
		}
		projectHTTPCheck(t, gotKind, kind)
		projectHTTPCheck(t, token, value)
		return principal, failure
	}
}

func settingsHTTPProjectList(t *testing.T, f *projectAccessHTTPFixture, actor model.Principal, first, second model.Project) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	f.projects.ListScopedCall = func(ctx context.Context, principal model.Principal, got coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		called()
		f.require(ctx, principal, actor, "", "")
		projectHTTPCheck(t, got, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 50}})
		return coreproject.ProjectPage{Items: []model.Project{first, second}}, nil
	}
}

func settingsHTTPExpectedProject(value model.Project) api.Project {
	return api.Project{ID: value.ID, Name: value.Name, RepoURL: value.RepoURL, CreatedAt: value.CreatedAt.UTC(), UpdatedAt: value.UpdatedAt.UTC(), Settings: api.ProjectSettings{Version: value.Settings.Version, ExecutionWarningMinutes: value.Settings.ExecutionWarningMinutes}, Ownership: api.ProjectOwnership{TeamID: value.Ownership.TeamID, Version: value.Ownership.Version}}
}
