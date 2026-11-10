package project

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func assertProjectInvocation(t *testing.T, h *httpHarness, ctx context.Context, principal model.Principal, ids ...string) {
	t.Helper()
	if principal != h.Principal || ctx == nil || httpx.RequestID(ctx) == "" {
		t.Fatalf("business invocation principal=%+v context=%v", principal, ctx)
	}
	for _, id := range ids {
		if id != h.Project.ID {
			t.Fatalf("project ID: %q, want %q", id, h.Project.ID)
		}
	}
}

func routeAccess(h *httpHarness) model.ProjectAccess {
	grant := model.ProjectGrant{ProjectID: h.Project.ID, UserID: h.Principal.UserID, Role: model.ProjectAdmin, Version: 1, CreatedAt: h.Project.CreatedAt, UpdatedAt: h.Project.UpdatedAt}
	return model.ProjectAccess{ProjectID: h.Project.ID, UserID: h.Principal.UserID, Role: model.ProjectAdmin, DirectGrant: &grant, Ownership: h.Project.Ownership, OwnerTeam: model.TeamRef{ID: h.Project.Ownership.TeamID, Kind: "personal"}, CanTransfer: true}
}

func assertProjectPage(t *testing.T, got api.ProjectPage, projects []model.Project, cursor *string) {
	t.Helper()
	if got.Items == nil || len(got.Items) != len(projects) || !reflect.DeepEqual(got.NextCursor, cursor) {
		t.Fatalf("page count=%d want=%d cursor=%v want=%v items=%+v", len(got.Items), len(projects), got.NextCursor, cursor, got.Items)
	}
	for index, expected := range projects {
		item := got.Items[index]
		if item.ID != expected.ID || item.Name != expected.Name || item.RepoURL != expected.RepoURL ||
			item.CreatedAt != expected.CreatedAt.UTC() || item.UpdatedAt != expected.UpdatedAt.UTC() ||
			item.Settings.Version != expected.Settings.Version || item.Settings.ExecutionWarningMinutes != expected.Settings.ExecutionWarningMinutes ||
			item.Ownership.TeamID != expected.Ownership.TeamID || item.Ownership.Version != expected.Ownership.Version {
			t.Fatalf("page item %d=%+v want fields from %+v", index, item, expected)
		}
	}
}

func TestProjectRoutesCreateListAccessAndSettings(t *testing.T) {
	h := newHTTPHarness(t)
	project := h.Project
	project.Name, project.RepoURL = "Project API", "https://example.com/api"
	existing := h.Project
	existing.ID = "33333333-3333-4333-8333-333333333333"
	access := routeAccess(h)
	h.Projects.CreateWithAccessFunc = func(ctx context.Context, p model.Principal, in coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p)
		want := coreproject.CreateProject{Name: project.Name, RepoURL: project.RepoURL, ExpectedUserID: h.Principal.UserID}
		if !reflect.DeepEqual(in, want) {
			t.Fatalf("create input: %+v", in)
		}
		return project, access, nil
	}
	response := h.call(http.MethodPost, "/api/v1/projects", fmt.Sprintf(`{"name":"Project API","repoUrl":"https://example.com/api","expectedUserId":%q}`, h.Principal.UserID), h.Cookie)
	created := decodeResponse[api.ProjectDocument](t, response, http.StatusCreated)
	if created.Project != ProjectResponse(project) || created.Access.ProjectID != project.ID || created.Access.DirectGrant == nil || created.Access.EffectiveRole != "admin" || response.Header().Get("Location") != "/api/v1/projects/"+project.ID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("creation: %+v headers=%v", created, response.Header())
	}
	h.Projects.GetWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return project, access, nil
	}
	h.Projects.AccessFunc = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return access, nil
	}
	path := "/api/v1/projects/" + project.ID
	read := decodeResponse[api.ProjectDocument](t, h.call(http.MethodGet, path, "", h.Cookie), 200)
	observedAccess := decodeResponse[api.ProjectAccess](t, h.call(http.MethodGet, path+"/access", "", h.Cookie), 200)
	if read.Project != created.Project || !reflect.DeepEqual(observedAccess, AccessResponse(access)) {
		t.Fatalf("project/access: %+v %+v", read, observedAccess)
	}
	for _, test := range []struct {
		query  string
		team   *string
		shared bool
		items  []model.Project
	}{
		{"", nil, false, []model.Project{existing, project}},
		{"?teamId=" + project.Ownership.TeamID, &project.Ownership.TeamID, false, []model.Project{existing, project}},
		{"?shared=true", nil, true, nil},
	} {
		h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
			assertProjectInvocation(t, h, ctx, p)
			if !reflect.DeepEqual(in, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 50}, TeamID: test.team, Shared: test.shared}) {
				t.Fatalf("list input: %+v", in)
			}
			return coreproject.ProjectPage{Items: test.items}, nil
		}
		page := decodeResponse[api.ProjectPage](t, h.call("GET", "/api/v1/projects"+test.query, "", h.Cookie), 200)
		assertProjectPage(t, page, test.items, nil)
	}
	updated := project
	updated.Settings = model.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}
	h.Projects.UpdateSettingsFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.UpdateProjectSettings) (model.Project, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if in != (coreproject.UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90}) {
			t.Fatalf("settings: %+v", in)
		}
		return updated, nil
	}
	got := decodeResponse[api.Project](t, h.call("PATCH", path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.Cookie), 200)
	if got != ProjectResponse(updated) {
		t.Fatalf("updated project: %+v", got)
	}
	h.Projects.UpdateSettingsFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.UpdateProjectSettings) (model.Project, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if in.Version != 1 || in.ExecutionWarningMinutes != 90 {
			t.Fatalf("stale settings: %+v", in)
		}
		return model.Project{}, &model.Fault{Code: "version_conflict", Message: "Project settings version does not match."}
	}
	assertProjectError(t, h.call("PATCH", path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.Cookie), 409, "version_conflict")
	h.Projects.GetWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return updated, access, nil
	}
	if got := decodeResponse[api.ProjectDocument](t, h.call("GET", path, "", h.Cookie), 200); got.Project != ProjectResponse(updated) {
		t.Fatalf("updated read: %+v", got)
	}
	h.Projects.AccessFunc = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return model.ProjectAccess{}, coreproject.ProjectNotFound(model.ErrNotFound)
	}
	assertProjectError(t, h.call("GET", path+"/access", "", h.Cookie), 404, "not_found")
	h.assertCalls(map[string]int{"CreateWithAccess": 1, "GetWithAccess": 2, "Access": 2, "ListScoped": 3, "UpdateSettings": 2})
}

func TestProjectRoutesRejectInvalidInputs(t *testing.T) {
	h := newHTTPHarness(t)
	path := "/api/v1/projects/" + h.Project.ID
	actor := fmt.Sprintf(`"expectedUserId":%q`, h.Principal.UserID)
	for _, body := range []string{`{`, `{"name":"\udfff","repoUrl":"host:repo"}`, `{"repoUrl":"host:repo",` + actor + `}`, `{"name":"x",` + actor + `}`, `{"name":"x","repoUrl":"host:repo","teamId":null,` + actor + `}`, `{"name":"x","repoUrl":"host:repo"}`} {
		assertProjectError(t, h.call("POST", "/api/v1/projects", body, h.Cookie), 400, "invalid_input")
	}
	for _, query := range []string{"unknown=1", "limit=0", "shared=false", "shared=true&teamId=" + h.Project.Ownership.TeamID} {
		assertProjectError(t, h.call("GET", "/api/v1/projects?"+query, "", h.Cookie), 400, "invalid_input")
	}
	for _, requestPath := range []string{"/api/v1/projects/bad", path + "/access?unexpected=1", "/api/v1/projects/bad/access"} {
		assertProjectError(t, h.call("GET", requestPath, "", h.Cookie), 400, "invalid_input")
	}
	for _, test := range []struct{ path, body string }{{"/api/v1/projects/bad/settings", `{"version":1,"executionWarningMinutes":90}`}, {path + "/settings?x=1", `{"version":1,"executionWarningMinutes":90}`}, {path + "/settings", `{`}, {path + "/settings", `{"version":0,"executionWarningMinutes":90}`}, {path + "/settings", `{"version":1,"executionWarningMinutes":0}`}} {
		assertProjectError(t, h.call("PATCH", test.path, test.body, h.Cookie), 400, "invalid_input")
	}
	owner := fmt.Sprintf(`{"teamId":%q,"version":1}`, h.Project.Ownership.TeamID)
	target := fmt.Sprintf(`{"id":%q,"version":1}`, h.Project.Ownership.TeamID)
	for _, body := range []string{`{"ownership":{"version":1},"targetTeam":` + target + `,` + actor + `}`, `{"ownership":` + owner + `,"targetTeam":null,` + actor + `}`, `{"ownership":` + owner + `,"targetTeam":{"version":1},` + actor + `}`, `{"ownership":` + owner + `,"targetTeam":{"id":"` + h.Project.Ownership.TeamID + `","version":0},` + actor + `}`} {
		assertProjectError(t, h.call("POST", path+"/transfer", body, h.Cookie), 400, "invalid_input")
	}
	assertProjectError(t, h.call("POST", path+"/transfer-preview?x=1", `{"targetTeamId":"`+h.Project.Ownership.TeamID+`"}`, h.Cookie), 400, "invalid_input")
	h.assertCalls(map[string]int{})
	h.Projects.CreateWithAccessFunc = func(ctx context.Context, p model.Principal, in coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p)
		if in.ExpectedUserID != "bad" || in.Name != "x" || in.RepoURL != "host:repo" {
			t.Fatalf("invalid actor forwarded: %+v", in)
		}
		return model.Project{}, model.ProjectAccess{}, &model.Fault{Code: "invalid_input", Message: "Invalid actor."}
	}
	assertProjectError(t, h.call("POST", "/api/v1/projects", `{"name":"x","repoUrl":"host:repo","expectedUserId":"bad"}`, h.Cookie), 400, "invalid_input")
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		assertProjectInvocation(t, h, ctx, p)
		if in.TeamID == nil || *in.TeamID != "bad" {
			t.Fatalf("team: %+v", in)
		}
		return coreproject.ProjectPage{}, &model.Fault{Code: "invalid_input", Message: "Invalid Team."}
	}
	assertProjectError(t, h.call("GET", "/api/v1/projects?teamId=bad", "", h.Cookie), 400, "invalid_input")
	h.Projects.UpdateSettingsFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.UpdateProjectSettings) (model.Project, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if in != (coreproject.UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90}) {
			t.Fatalf("settings: %+v", in)
		}
		return model.Project{}, coreproject.ProjectNotFound(model.ErrNotFound)
	}
	assertProjectError(t, h.call("PATCH", path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.Cookie), 404, "not_found")
	if strings.Contains(h.Logs.String(), "host:repo") {
		t.Fatal("request content was logged")
	}
	h.assertCalls(map[string]int{"CreateWithAccess": 1, "ListScoped": 1, "UpdateSettings": 1})
}

func TestProjectRoutesBusinessFailuresRemainSafe(t *testing.T) {
	h := newHTTPHarness(t)
	failure := errors.New("private_sql_secret")
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		assertProjectInvocation(t, h, ctx, p)
		if in.Page.Limit != 50 || in.Page.Cursor != nil || in.TeamID != nil || in.Shared {
			t.Fatalf("list input %+v", in)
		}
		return coreproject.ProjectPage{}, failure
	}
	h.Projects.GetWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return model.Project{}, model.ProjectAccess{}, failure
	}
	h.Projects.AccessFunc = func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		return model.ProjectAccess{}, failure
	}
	h.Projects.UpdateSettingsFunc = func(ctx context.Context, p model.Principal, id string, in coreproject.UpdateProjectSettings) (model.Project, error) {
		assertProjectInvocation(t, h, ctx, p, id)
		if in != (coreproject.UpdateProjectSettings{Version: 1, ExecutionWarningMinutes: 90}) {
			t.Fatalf("settings %+v", in)
		}
		return model.Project{}, failure
	}
	h.Projects.CreateWithAccessFunc = func(ctx context.Context, p model.Principal, in coreproject.CreateProject) (model.Project, model.ProjectAccess, error) {
		assertProjectInvocation(t, h, ctx, p)
		if in.Name != "x" || in.RepoURL != "host:repo" || in.ExpectedUserID != h.Principal.UserID || in.TeamID != nil {
			t.Fatalf("create %+v", in)
		}
		return model.Project{}, model.ProjectAccess{}, failure
	}
	path := "/api/v1/projects/" + h.Project.ID
	for _, test := range []struct{ method, path, body string }{{"GET", "/api/v1/projects", ""}, {"GET", path, ""}, {"GET", path + "/access", ""}, {"PATCH", path + "/settings", `{"version":1,"executionWarningMinutes":90}`}, {"POST", "/api/v1/projects", fmt.Sprintf(`{"name":"x","repoUrl":"host:repo","expectedUserId":%q}`, h.Principal.UserID)}} {
		response := h.call(test.method, test.path, test.body, h.Cookie)
		assertProjectError(t, response, 500, "internal_error")
		if strings.Contains(response.Body.String(), "private_sql_secret") {
			t.Fatal("database details leaked")
		}
	}
	if strings.Contains(h.Logs.String(), "private_sql_secret") {
		t.Fatal("database details leaked in logs")
	}
	h.assertCalls(map[string]int{"ListScoped": 1, "GetWithAccess": 1, "Access": 1, "UpdateSettings": 1, "CreateWithAccess": 1})
}

func TestProjectHTTPPageCountAndCursor(t *testing.T) {
	h := newHTTPHarness(t)
	one, two := h.Project, h.Project
	one.ID = "33333333-3333-4333-8333-333333333333"
	two.ID = "44444444-4444-4444-8444-444444444444"
	one.Name = strings.Repeat("<", 250) + "one"
	two.Name = strings.Repeat("<", 250) + "two"
	one.RepoURL = "host:repo-one"
	two.RepoURL = "host:repo-two"
	cursor := "opaque+continuation/cursor="
	for _, test := range []struct {
		path    string
		request model.PageRequest
		items   []model.Project
		next    *string
	}{
		{"?limit=100", model.PageRequest{Limit: 100}, []model.Project{h.Project, one, two}, nil},
		{"?limit=2", model.PageRequest{Limit: 2}, []model.Project{h.Project, one}, &cursor},
		{"?limit=2&cursor=opaque%2Bcontinuation%2Fcursor%3D", model.PageRequest{Limit: 2, Cursor: &cursor}, []model.Project{two}, nil},
	} {
		h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
			assertProjectInvocation(t, h, ctx, p)
			if !reflect.DeepEqual(in, coreproject.ProjectListRequest{Page: test.request}) {
				t.Fatalf("page request %+v", in)
			}
			return coreproject.ProjectPage{Items: test.items, NextCursor: test.next}, nil
		}
		response := h.call("GET", "/api/v1/projects"+test.path, "", h.Cookie)
		got := decodeResponse[api.ProjectPage](t, response, 200)
		assertProjectPage(t, got, test.items, test.next)
	}
	h.assertCalls(map[string]int{"ListScoped": 3})
}
