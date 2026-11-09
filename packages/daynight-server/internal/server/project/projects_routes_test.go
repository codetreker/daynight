package project

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func projectRoutesHarness(t *testing.T) *membershipHarness {
	t.Helper()
	h := membershipTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, projectservice.NewProjects(h.Database), h.Auth, logger)
	NewMembershipRoutes(projectservice.NewMemberships(h.Database), h.Auth, logger).RegisterRoutes(mux)
	h.Handler = httpx.RequestLogging(logger, mux)
	return h
}

func TestProjectRoutesCreateListAccessAndSettings(t *testing.T) {
	h := projectRoutesHarness(t)
	body := fmt.Sprintf(`{"name":"Project API","repoUrl":"https://example.com/api","expectedUserId":%q}`, h.adminID)
	response := h.call(http.MethodPost, "/api/v1/projects", body, h.admin)
	created := decodeResponse[api.ProjectDocument](t, response, http.StatusCreated)
	if created.Name != "Project API" || created.Access.ProjectID != created.ID || created.Access.DirectGrant == nil || created.Access.EffectiveRole != "admin" || response.Header().Get("Location") != "/api/v1/projects/"+created.ID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("creation document: %+v headers=%v", created, response.Header())
	}
	path := "/api/v1/projects/" + created.ID
	read := decodeResponse[api.ProjectDocument](t, h.call(http.MethodGet, path, "", h.admin), http.StatusOK)
	access := decodeResponse[api.ProjectAccess](t, h.call(http.MethodGet, path+"/access", "", h.admin), http.StatusOK)
	if read.Project != created.Project || access.Ownership != created.Ownership || access.ProjectID != created.ID || access.DirectGrant == nil {
		t.Fatalf("inconsistent project/access projections: %+v %+v", read, access)
	}
	page := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects", "", h.admin), http.StatusOK)
	if len(page.Items) != 2 || page.Items[1] != created.Project || page.NextCursor != nil {
		t.Fatalf("list: %+v", page)
	}
	teamPage := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?teamId="+created.Ownership.TeamID, "", h.admin), http.StatusOK)
	if len(teamPage.Items) != 2 {
		t.Fatalf("team scope: %+v", teamPage)
	}
	shared := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?shared=true", "", h.admin), http.StatusOK)
	if shared.Items == nil || len(shared.Items) != 0 {
		t.Fatalf("shared scope: %+v", shared)
	}
	updated := decodeResponse[api.Project](t, h.call(http.MethodPatch, path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.admin), http.StatusOK)
	if updated.Settings.Version != 2 || updated.Settings.ExecutionWarningMinutes != 90 || updated.ID != created.ID {
		t.Fatalf("settings: %+v", updated)
	}
	assertProjectError(t, h.call(http.MethodPatch, path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.admin), http.StatusConflict, "version_conflict")
	if read := decodeResponse[api.ProjectDocument](t, h.call(http.MethodGet, path, "", h.admin), http.StatusOK); read.Project != updated {
		t.Fatalf("updated settings not visible: %+v", read)
	}
	assertProjectError(t, h.call(http.MethodGet, path+"/access", "", h.outsider), http.StatusNotFound, "not_found")
}

func TestProjectRoutesRejectInvalidInputs(t *testing.T) {
	h := projectRoutesHarness(t)
	path := "/api/v1/projects/" + h.project.ID
	validName := `"name":"x"`
	validRepo := `"repoUrl":"host:repo"`
	validActor := fmt.Sprintf(`"expectedUserId":%q`, h.adminID)
	for _, body := range []string{
		`{`, `{"name":"\udfff","repoUrl":"host:repo"}`,
		`{` + validRepo + `,` + validActor + `}`, `{` + validName + `,` + validActor + `}`,
		`{` + validName + `,` + validRepo + `,"teamId":null,` + validActor + `}`,
		`{` + validName + `,` + validRepo + `}`,
		`{` + validName + `,` + validRepo + `,"expectedUserId":"bad"}`,
	} {
		assertProjectError(t, h.call(http.MethodPost, "/api/v1/projects", body, h.admin), http.StatusBadRequest, "invalid_input")
	}
	for _, query := range []string{"unknown=1", "limit=0", "shared=false", "shared=true&teamId=" + h.project.Ownership.TeamID, "teamId=bad"} {
		assertProjectError(t, h.call(http.MethodGet, "/api/v1/projects?"+query, "", h.admin), http.StatusBadRequest, "invalid_input")
	}
	for _, requestPath := range []string{"/api/v1/projects/bad", path + "/access?unexpected=1", "/api/v1/projects/bad/access"} {
		assertProjectError(t, h.call(http.MethodGet, requestPath, "", h.admin), http.StatusBadRequest, "invalid_input")
	}
	for _, test := range []struct{ path, body string }{
		{"/api/v1/projects/bad/settings", `{"version":1,"executionWarningMinutes":90}`},
		{path + "/settings?x=1", `{"version":1,"executionWarningMinutes":90}`},
		{path + "/settings", `{`}, {path + "/settings", `{"version":0,"executionWarningMinutes":90}`},
		{path + "/settings", `{"version":1,"executionWarningMinutes":0}`},
	} {
		assertProjectError(t, h.call(http.MethodPatch, test.path, test.body, h.admin), http.StatusBadRequest, "invalid_input")
	}
	owner := fmt.Sprintf(`{"teamId":%q,"version":1}`, h.project.Ownership.TeamID)
	target := fmt.Sprintf(`{"id":%q,"version":1}`, h.project.Ownership.TeamID)
	for _, body := range []string{
		`{"ownership":{"version":1},"targetTeam":` + target + `,"expectedUserId":` + fmt.Sprintf("%q", h.adminID) + `}`,
		`{"ownership":` + owner + `,"targetTeam":null,"expectedUserId":` + fmt.Sprintf("%q", h.adminID) + `}`,
		`{"ownership":` + owner + `,"targetTeam":{"version":1},"expectedUserId":` + fmt.Sprintf("%q", h.adminID) + `}`,
		`{"ownership":` + owner + `,"targetTeam":{"id":"` + h.project.Ownership.TeamID + `","version":0},"expectedUserId":` + fmt.Sprintf("%q", h.adminID) + `}`,
	} {
		assertProjectError(t, h.call(http.MethodPost, path+"/transfer", body, h.admin), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, h.call(http.MethodPost, path+"/transfer-preview?x=1", `{"targetTeamId":"`+h.project.Ownership.TeamID+`"}`, h.admin), http.StatusBadRequest, "invalid_input")

	assertProjectError(t, h.call(http.MethodPatch, path+"/settings", `{"version":1,"executionWarningMinutes":90}`, h.outsider), http.StatusNotFound, "not_found")
	if strings.Contains(h.Logs.String(), "host:repo") {
		t.Fatal("request content was logged")
	}
}

func TestProjectRoutesDatabaseFailuresRemainSafe(t *testing.T) {
	h := projectRoutesHarness(t)
	if _, err := h.Database.Pool.Exec(context.Background(), `ALTER TABLE projects RENAME TO private_sql_secret`); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects/" + h.project.ID
	for _, test := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/projects", ""}, {http.MethodGet, path, ""}, {http.MethodGet, path + "/access", ""},
		{http.MethodPatch, path + "/settings", `{"version":1,"executionWarningMinutes":90}`},
		{http.MethodPost, "/api/v1/projects", fmt.Sprintf(`{"name":"x","repoUrl":"host:repo","expectedUserId":%q}`, h.adminID)},
	} {
		response := h.call(test.method, test.path, test.body, h.admin)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), "private_sql_secret") {
			t.Fatal("database details leaked")
		}
	}
	if strings.Contains(h.Logs.String(), "private_sql_secret") {
		t.Fatal("database details leaked in logs")
	}
}

func TestProjectHTTPPageCountAndCursor(t *testing.T) {
	h := projectRoutesHarness(t)
	var projects []api.Project
	for _, suffix := range []string{"one", "two"} {
		name := strings.Repeat("<", 250) + suffix
		body := jsonBody(t, api.CreateProjectRequest{Name: name, RepoURL: "host:repo-" + suffix, ExpectedUserID: h.adminID})
		project := decodeResponse[api.ProjectDocument](t, h.call(http.MethodPost, "/api/v1/projects", body, h.admin), http.StatusCreated)
		projects = append(projects, project.Project)
	}
	complete := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=100", "", h.admin), http.StatusOK)
	if len(complete.Items) != 3 || complete.Items[1] != projects[0] || complete.Items[2] != projects[1] || complete.NextCursor != nil {
		t.Fatalf("complete page: %+v", complete)
	}
	first := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=2", "", h.admin), http.StatusOK)
	if len(first.Items) != 2 || first.Items[1] != projects[0] || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	next := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=2&cursor="+*first.NextCursor, "", h.admin), http.StatusOK)
	if len(next.Items) != 1 || next.Items[0] != projects[1] || next.NextCursor != nil {
		t.Fatalf("continuation: %+v", next)
	}
}
