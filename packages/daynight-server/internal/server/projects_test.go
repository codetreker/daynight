package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

func projectTestHandler(t *testing.T, database *projectHTTPOperations, output io.Writer) *resourceTestHandler {
	t.Helper()
	return newOperationHTTPServer(t, func(deps *httpDependencies) { deps.Projects = database }, output, defaultHTTPPrincipal())
}

func projectRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

func TestProjectHTTPCreateReadAndEmptyList(t *testing.T) {
	database := newProjectHTTPOperations(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(50, nil, nil, false), []model.Project{}, nil)
	empty := projectRequest(handler, http.MethodGet, "/api/v1/projects", "")
	page := decodeResponse[api.ProjectPage](t, empty, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil || !strings.Contains(empty.Body.String(), `"items":[]`) || !strings.Contains(empty.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty list shape: %s", empty.Body)
	}
	expected := projectHTTPCreate(t, database, handler.principal, "API work", "git@github.com:example/repository.git", projectHTTPPersonalTeam, false)
	response := projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "API work", RepoURL: "git@github.com:example/repository.git", ExpectedUserID: handler.principal.UserID}))
	project := decodeResponse[api.Project](t, response, http.StatusCreated)
	if project.Name != "API work" || project.RepoURL != "git@github.com:example/repository.git" || project.ID == "" || project.CreatedAt.IsZero() || project.CreatedAt.Location() != time.UTC || project.UpdatedAt != project.CreatedAt {
		t.Fatalf("created project: %+v", project)
	}
	if response.Header().Get("Location") != "/api/v1/projects/"+project.ID {
		t.Fatalf("invalid resource location: %s", response.Header().Get("Location"))
	}
	var fields map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 8 {
		t.Fatalf("unexpected project DTO: %s %v", response.Body, err)
	}
	for _, key := range []string{"id", "name", "repoUrl", "createdAt", "updatedAt", "settings", "ownership", "access"} {
		if _, exists := fields[key]; !exists {
			t.Fatalf("missing DTO field %s: %s", key, response.Body)
		}
	}
	projectHTTPGet(t, database, handler.principal, *expected)
	read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+strings.ToUpper(project.ID), ""), http.StatusOK)
	if read != project {
		t.Fatalf("read differs from create: %+v %+v", read, project)
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(50, nil, nil, false), []model.Project{*expected}, nil)
	page = decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0] != project || page.NextCursor != nil {
		t.Fatalf("project list projection: %+v", page)
	}
	if !strings.Contains(logs.String(), `"project_id":"`+project.ID+`"`) || !strings.Contains(logs.String(), `"route":"POST /api/v1/projects"`) || strings.Contains(logs.String(), project.RepoURL) {
		t.Fatalf("missing resource correlation or unsafe logs: %s", &logs)
	}
}

func TestProjectHTTPRejectsInvalidBodies(t *testing.T) {
	database := newProjectHTTPOperations(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	for _, body := range []string{
		"", "null", "[]", `"value"`, `true`, `{`, `{"name":`, `{"name"}`, `{"name":"ok"`, `{"name":"ok"]`,
		`{"name":"ok","repoUrl":"https://github.com/example/repo"} {}`,
		`{"name":"ok","repoUrl":"https://github.com/example/repo"} trailing`,
		`{"Name":"ok","repoUrl":"https://github.com/example/repo"}`,
		`{"name":"one","name":"two","repoUrl":"https://github.com/example/repo"}`,
		`{"name":"ok","repoUrl":"https://github.com/example/repo","id":"read-only"}`,
		`{"name":"ok","repoUrl":"https://github.com/example/repo","unknown":"secret-body"}`,
		`{"name":null}`, `{"name":null,"repoUrl":"https://github.com/example/repo"}`,
		`{"name":42,"repoUrl":"https://github.com/example/repo"}`,
		`{"name":true,"repoUrl":"https://github.com/example/repo"}`,
		`{"name":[],"repoUrl":"https://github.com/example/repo"}`,
		`{"name":{},"repoUrl":"https://github.com/example/repo"}`,
		`{"repoUrl":"https://github.com/example/repo"}`,
		`{"name":"ok"}`, `{"name":"ok","repoUrl":null}`, `{"name":"ok","repoUrl":1}`,
		`{"name":" ","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`,
		`{"name":"\u0000","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`,
		`{"name":"ok","repoUrl":"https://user:password-secret@github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`,
		`{"name":"ok","repoUrl":"not-a-repository","expectedUserId":"` + handler.principal.UserID + `"}`,
		"{\"name\":\"" + string([]byte{0xff}) + "\",\"repoUrl\":\"https://github.com/example/repo\",\"expectedUserId\":\"" + handler.principal.UserID + "\"}",
	} {
		t.Run(string(body[:min(len(body), 80)]), func(t *testing.T) {
			switch body {
			case `{"name":" ","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`:
				projectHTTPCreateResult(t, database, handler.principal, coreproject.CreateProject{Name: " ", RepoURL: "https://github.com/example/repo", ExpectedUserID: handler.principal.UserID}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "Project name must be nonempty UTF-8 text without NUL characters."))
			case `{"name":"\u0000","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`:
				projectHTTPCreateResult(t, database, handler.principal, coreproject.CreateProject{Name: "\x00", RepoURL: "https://github.com/example/repo", ExpectedUserID: handler.principal.UserID}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "Project name must be nonempty UTF-8 text without NUL characters."))
			case `{"name":"ok","repoUrl":"https://user:password-secret@github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`:
				projectHTTPCreateResult(t, database, handler.principal, coreproject.CreateProject{Name: "ok", RepoURL: "https://user:password-secret@github.com/example/repo", ExpectedUserID: handler.principal.UserID}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "Repository address must be a valid HTTPS, SSH, or SCP address."))
			case `{"name":"ok","repoUrl":"not-a-repository","expectedUserId":"` + handler.principal.UserID + `"}`:
				projectHTTPCreateResult(t, database, handler.principal, coreproject.CreateProject{Name: "ok", RepoURL: "not-a-repository", ExpectedUserID: handler.principal.UserID}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "Repository address must be a valid HTTPS, SSH, or SCP address."))
			}
			assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", body), http.StatusBadRequest, "invalid_input")
		})
	}
	oversized := `{"name":"` + strings.Repeat("x", httpx.MaxJSONBody) + `","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", oversized), http.StatusRequestEntityTooLarge, "payload_too_large")
	for _, contentType := range []string{"", "text/plain", "application/json; charset=iso-8859-1", "application/json; charset=", "application/json; charset=utf-8; charset=us-ascii"} {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/projects", strings.NewReader(jsonBody(t, api.CreateProjectRequest{Name: "ok", RepoURL: "https://github.com/example/repo", ExpectedUserID: handler.principal.UserID})))
		authorizeResourceRequest(handler, request)
		request.Header.Set("Content-Type", contentType)
		request.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	if strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "github.com") {
		t.Fatalf("request content leaked: %s", &logs)
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(50, nil, nil, false), []model.Project{}, nil)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 0 {
		t.Fatal("invalid request created a project")
	}
}

func TestProjectHTTPPaginationWithTiedTimestamps(t *testing.T) {
	database := newProjectHTTPOperations(t)
	handler := projectTestHandler(t, database, io.Discard)
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	path := "/api/v1/projects?limit=1"
	var pageCursor *string
	for index, id := range ids {
		record := projectHTTPRecord(id, "same time", "https://github.com/example/repo", projectHTTPPersonalTeam)
		var nextCursor *string
		if index < len(ids)-1 {
			nextCursor = projectHTTPTestCursor(t, handler.principal, "all", "", record)
		}
		projectHTTPPage(t, database, handler.principal, projectHTTPListInput(1, pageCursor, nil, false), []model.Project{record}, nextCursor)
		page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		if len(page.Items) != 1 || page.Items[0].ID != id || (page.NextCursor != nil) != (index < len(ids)-1) {
			t.Fatalf("incorrect keyset page %d: %+v", index, page)
		}
		pageCursor = projectHTTPCopyPointer(page.NextCursor)
		if page.NextCursor != nil {
			path = "/api/v1/projects?limit=1&cursor=" + url.QueryEscape(*page.NextCursor)
			data, err := base64.RawURLEncoding.DecodeString(*page.NextCursor)
			if err != nil {
				t.Fatal(err)
			}
			var cursor map[string]any
			if err := json.Unmarshal(data, &cursor); err != nil {
				t.Fatal(err)
			}
			cursor["kind"] = "tasks"
			wrongScope, err := json.Marshal(cursor)
			if err != nil {
				t.Fatal(err)
			}
			rawWrongScope := base64.RawURLEncoding.EncodeToString(wrongScope)
			projectHTTPListRefusal(t, database, handler.principal, projectHTTPListInput(50, &rawWrongScope, nil, false))
			assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+url.QueryEscape(base64.RawURLEncoding.EncodeToString(wrongScope)), ""), http.StatusBadRequest, "invalid_input")
		}
	}
}

func TestProjectHTTPInvalidQueriesAndMissingResources(t *testing.T) {
	database := newProjectHTTPOperations(t)
	handler := projectTestHandler(t, database, io.Discard)
	for _, query := range []string{
		"limit=", "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=invalid", "limit=1&limit=2",
		"cursor=", "cursor=bad", "cursor=one&cursor=two", "status=todo", "limit=%xx", "limit=1;cursor=x",
		"teamId=", "teamId=invalid", "teamId=one&teamId=two", "shared=", "shared=false", "shared=TRUE", "shared=1", "shared=true&shared=true",
		"teamId=00000000-0000-4000-8000-000000000001&shared=true",
	} {
		switch query {
		case "cursor=bad":
			raw := "bad"
			projectHTTPListRefusal(t, database, handler.principal, projectHTTPListInput(50, &raw, nil, false))
		case "teamId=invalid":
			raw := "invalid"
			projectHTTPPageResult(t, database, handler.principal, projectHTTPListInput(50, nil, &raw, false), nil, nil, projectHTTPFault("invalid_input", "ID must be a hyphenated UUID."))
		}
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	for _, path := range []string{"not-a-uuid", "00000000-0000-4000-8000-00000000000z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+path, ""), http.StatusBadRequest, "invalid_input")
	}
	projectHTTPGetResult(t, database, handler.principal, "00000000-0000-4000-8000-000000000099", model.Project{}, model.ProjectAccess{}, projectHTTPFault("not_found", "Project was not found."))
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/unknown-secret-path?query=secret", ""), http.StatusNotFound, "not_found")
	deleteCall := projectHTTPCount(t, 1)
	database.DeleteCall = func(ctx context.Context, p model.Principal, id string) (projectservice.DeletionReceipt, error) {
		deleteCall()
		projectHTTPContext(t, ctx, p, handler.principal)
		projectHTTPCheck(t, id, "00000000-0000-4000-8000-000000000099")
		return projectservice.DeletionReceipt{}, projectHTTPFault("not_found", "Project was not found.")
	}
	assertProjectError(t, projectRequest(handler, http.MethodDelete, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""), http.StatusNotFound, "not_found")
	response := projectRequest(handler, http.MethodDelete, "/api/v1/projects", "")
	assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
	if !strings.Contains(response.Header().Get("Allow"), "GET") || !strings.Contains(response.Header().Get("Allow"), "POST") {
		t.Fatalf("invalid Allow: %s", response.Header().Get("Allow"))
	}
}

func TestProjectHTTPScopedPagination(t *testing.T) {
	database := newProjectHTTPOperations(t)
	handler := projectTestHandler(t, database, io.Discard)
	firstRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000001", "project", "https://github.com/example/repo", projectHTTPPersonalTeam)
	secondRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000002", "project", "https://github.com/example/repo", projectHTTPPersonalTeam)
	teamID := firstRecord.Ownership.TeamID
	if strings.ToUpper(teamID) == teamID {
		t.Fatal("team cursor fixture must have a distinct uppercase alias")
	}
	upperTeam := strings.ToUpper(teamID)
	query := "teamId=" + upperTeam
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(1, nil, projectHTTPCopyPointer(&upperTeam), false), []model.Project{firstRecord}, projectHTTPTestCursor(t, handler.principal, "team", teamID, firstRecord))
	first := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&"+query, ""), http.StatusOK)
	if len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first team page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(1, first.NextCursor, &teamID, false), []model.Project{secondRecord}, nil)
	second := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&teamId="+teamID+"&cursor="+cursor, ""), http.StatusOK)
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextCursor != nil {
		t.Fatalf("second team page: %+v", second)
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(50, nil, nil, true), []model.Project{}, nil)
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 0 || shared.Items == nil || shared.NextCursor != nil {
		t.Fatalf("shared scope included team projects: %+v", shared)
	}
	for _, scope := range []string{"", "&shared=true", "&teamId=00000000-0000-4000-8000-000000000099"} {
		input := projectHTTPListInput(50, first.NextCursor, nil, scope == "&shared=true")
		if scope == "&teamId=00000000-0000-4000-8000-000000000099" {
			team := "00000000-0000-4000-8000-000000000099"
			input.TeamID = &team
		}
		projectHTTPListRefusal(t, database, handler.principal, input)
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+cursor+scope, ""), http.StatusBadRequest, "invalid_input")
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(1, nil, nil, false), []model.Project{firstRecord}, projectHTTPTestCursor(t, handler.principal, "all", "", firstRecord))
	all := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1", ""), http.StatusOK)
	if all.NextCursor == nil {
		t.Fatal("all-accessible cursor missing")
	}
	projectHTTPListRefusal(t, database, handler.principal, projectHTTPListInput(50, all.NextCursor, &upperTeam, false))
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query+"&cursor="+url.QueryEscape(*all.NextCursor), ""), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPSharedPaginationRejectsOtherScopesAndPrincipals(t *testing.T) {
	principal := defaultHTTPPrincipal()
	principal.UserID = "00000000-0000-4000-8000-000000000040"
	database := newProjectHTTPOperations(t)
	handler := newOperationHTTPServer(t, func(deps *httpDependencies) { deps.Projects = database }, io.Discard, principal)
	firstRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000001", "First shared", "https://example.com/first.git", projectHTTPPersonalTeam)
	secondRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000002", "Second shared", "https://example.com/second.git", projectHTTPPersonalTeam)
	secondRecord.CreatedAt = firstRecord.CreatedAt.Add(time.Second)
	secondRecord.UpdatedAt = secondRecord.CreatedAt
	projectHTTPPage(t, database, principal, projectHTTPListInput(1, nil, nil, true), []model.Project{firstRecord}, projectHTTPTestCursor(t, principal, "shared", "", firstRecord))
	first := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&shared=true", ""), http.StatusOK)
	if len(first.Items) != 1 || first.Items[0].ID != firstRecord.ID || first.NextCursor == nil {
		t.Fatalf("first shared page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	projectHTTPPage(t, database, principal, projectHTTPListInput(1, first.NextCursor, nil, true), []model.Project{secondRecord}, nil)
	next := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&shared=true&cursor="+cursor, ""), http.StatusOK)
	if len(next.Items) != 1 || next.Items[0].ID != secondRecord.ID || next.NextCursor != nil {
		t.Fatalf("second shared page: %+v", next)
	}
	for _, query := range []string{"cursor=" + cursor, "teamId=" + projectHTTPPersonalTeam + "&cursor=" + cursor} {
		input := projectHTTPListInput(50, first.NextCursor, nil, false)
		if strings.HasPrefix(query, "teamId=") {
			team := projectHTTPPersonalTeam
			input.TeamID = &team
		}
		projectHTTPListRefusal(t, database, principal, input)
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	outsider := defaultHTTPPrincipal()
	outsider.UserID = "00000000-0000-4000-8000-000000000041"
	otherOperations := newProjectHTTPOperations(t)
	other := newOperationHTTPServer(t, func(deps *httpDependencies) { deps.Projects = otherOperations }, io.Discard, outsider)
	projectHTTPListRefusal(t, otherOperations, outsider, projectHTTPListInput(50, first.NextCursor, nil, true))
	assertProjectError(t, projectRequest(other, http.MethodGet, "/api/v1/projects?shared=true&cursor="+cursor, ""), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPTeamScopeRefusesNonmembersAndExposesDatabaseFailure(t *testing.T) {
	database := newProjectHTTPOperations(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	const externalTeam = "00000000-0000-4000-8000-000000000190"
	const missingTeam = "00000000-0000-4000-8000-000000000191"
	externalTeamValue := externalTeam
	record := projectHTTPRecord("00000000-0000-4000-8000-000000000189", "Externally shared", "https://example.com/repo", externalTeam)
	projectHTTPPage(t, database, handler.principal, projectHTTPListInput(50, nil, nil, true), []model.Project{record}, nil)
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 1 || shared.Items[0].ID != record.ID {
		t.Fatalf("direct grant should permit the shared project: %+v", shared)
	}
	refusal := func(team string) *httptest.ResponseRecorder {
		projectHTTPPageResult(t, database, handler.principal, projectHTTPListInput(50, nil, &team, false), nil, nil, &model.Fault{Code: "not_found", Message: "Team was not found.", Cause: model.ErrNotFound})
		return projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+team, "")
	}
	nonmember, missing := refusal(externalTeam), refusal(missingTeam)
	assertProjectError(t, nonmember, http.StatusNotFound, "not_found")
	assertProjectError(t, missing, http.StatusNotFound, "not_found")
	if nonmember.Body.String() != missing.Body.String() {
		t.Fatalf("nonmember and missing Team refusals differ: %s vs %s", nonmember.Body, missing.Body)
	}
	projectHTTPPageResult(t, database, handler.principal, projectHTTPListInput(50, nil, projectHTTPCopyPointer(&externalTeamValue), false), nil, nil, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_membership_secret")})
	failed := projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+externalTeam, "")
	assertProjectError(t, failed, http.StatusInternalServerError, "internal_error")
	if strings.Contains(failed.Body.String(), "secret") || strings.Contains(logs.String(), "private_membership_secret") || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("database failure was hidden or disclosed: response %s, logs %s", failed.Body, &logs)
	}
}

func TestProjectHTTPDatabaseFailuresAreVisibleAndSafe(t *testing.T) {
	database := newProjectHTTPOperations(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_sql_secret relation missing")}
	projectHTTPPageResult(t, database, handler.principal, projectHTTPListInput(50, nil, nil, false), nil, nil, failure)
	responses := []*httptest.ResponseRecorder{projectRequest(handler, http.MethodGet, "/api/v1/projects", "")}
	projectHTTPGetResult(t, database, handler.principal, "00000000-0000-4000-8000-000000000099", model.Project{}, model.ProjectAccess{}, failure)
	responses = append(responses, projectRequest(handler, http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""))
	projectHTTPCreateResult(t, database, handler.principal, coreproject.CreateProject{Name: "secret-body", RepoURL: "https://github.com/example/private-secret", ExpectedUserID: handler.principal.UserID}, model.Project{}, model.ProjectAccess{}, failure)
	responses = append(responses, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "secret-body", RepoURL: "https://github.com/example/private-secret", ExpectedUserID: handler.principal.UserID})))
	for _, response := range responses {
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), "database") || strings.Contains(response.Body.String(), "SQL") || strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("unsafe server response: %s", response.Body)
		}
	}
	if !strings.Contains(logs.String(), `"cause":"database"`) || !strings.Contains(logs.String(), `"request_id":"project-test"`) || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "relation") {
		t.Fatalf("unsafe or uncorrelated diagnostics: %s", &logs)
	}
}

func TestProjectHTTPCanceledReadDoesNotWrite(t *testing.T) {
	database := newProjectHTTPOperations(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	reached, finished := make(chan struct{}), make(chan struct{})
	called := projectHTTPCount(t, 1)
	database.ListScopedCall = func(ctx context.Context, p model.Principal, input coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		called()
		projectHTTPContext(t, ctx, p, handler.principal)
		projectHTTPCheck(t, input, projectHTTPListInput(50, nil, nil, false))
		close(reached)
		<-ctx.Done()
		return coreproject.ProjectPage{}, &store.Error{Phase: "query", Cause: ctx.Err()}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	go func() { defer close(finished); handler.ServeHTTP(response, request) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("canceled HTTP handler did not drain")
		}
	})
	await(t, reached)
	select {
	case <-finished:
		t.Fatal("request completed before cancellation")
	default:
	}
	cancel()
	await(t, finished)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled query wrote a response or lost cause: %s %s", response.Body, &logs)
	}
}

type failingResponseWriter struct{ header http.Header }

func (w *failingResponseWriter) Header() http.Header { return w.header }
func (*failingResponseWriter) WriteHeader(int)       {}
func (*failingResponseWriter) Write([]byte) (int, error) {
	return 0, errors.New("private-connection-secret")
}

func TestHTTPErrorMappingAndWriteFailure(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, err := range []error{
		errors.Join(model.ErrNotFound, errors.New("private-database-secret")),
		&model.Fault{Code: "unexpected", Message: "private-service-secret"},
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			httpx.WriteError(w, request, logger, "project", "get", err)
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	}
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		httpx.WriteError(w, request, logger, "project", "get", &model.Fault{Code: "invalid_input", Message: "invalid references", TaskIDs: []string{"task-id"}})
	})).ServeHTTP(response, request)
	value := decodeResponse[api.ErrorResponse](t, response, http.StatusBadRequest)
	if value.Error.Details == nil || len(value.Error.Details.TaskIDs) != 1 || value.Error.Details.TaskIDs[0] != "task-id" {
		t.Fatalf("missing error details: %+v", value)
	}
	httpx.WriteJSON(&failingResponseWriter{header: make(http.Header)}, request, logger, http.StatusOK, api.Project{})
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	canceled := httptest.NewRecorder()
	httpx.WriteJSON(canceled, request.WithContext(ctx), logger, http.StatusOK, api.Project{})
	if canceled.Body.Len() != 0 || len(canceled.Header()) != 0 {
		t.Fatalf("already canceled request wrote a response: %s %+v", canceled.Body, canceled.Header())
	}
	if strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"phase":"response"`) {
		t.Fatalf("write failure not safely diagnosed: %s", &logs)
	}
}

func TestPublicHealthAndReadinessUseConfiguredProbe(t *testing.T) {
	ready := true
	readyCalls := 0
	handler := newOperationHTTPServer(t, func(deps *httpDependencies) {
		deps.Ready = func(ctx context.Context) error {
			readyCalls++
			if !ready {
				return &store.Error{Phase: "ping", DatabaseFailure: true, Cause: errors.New("private-health-project database unavailable")}
			}
			return nil
		}
	}, io.Discard, defaultHTTPPrincipal())
	request := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("X-Request-ID", "project-test")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		return response
	}
	assertProjectError(t, request(http.MethodGet, "/api/v1/projects"), http.StatusUnauthorized, "unauthenticated")
	for path, status := range map[string]string{"/healthz": "ok", "/readyz": "ready"} {
		response := request(http.MethodGet, path)
		value := decodeResponse[map[string]string](t, response, http.StatusOK)
		if len(value) != 1 || value["status"] != status || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("health response exposed data or cached state: %s %+v", response.Body, response.Header())
		}
		unsupported := request(http.MethodPost, path)
		assertProjectError(t, unsupported, http.StatusMethodNotAllowed, "method_not_allowed")
		if unsupported.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("health method boundary: %+v", unsupported.Header())
		}
	}
	ready = false
	response := request(http.MethodGet, "/readyz")
	assertProjectError(t, response, http.StatusServiceUnavailable, "service_unavailable")
	if strings.Contains(response.Body.String(), "private-health-project") || strings.Contains(response.Body.String(), "database") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness failure exposed data or cached state: %s %+v", response.Body, response.Header())
	}
	decodeResponse[map[string]string](t, request(http.MethodGet, "/healthz"), http.StatusOK)
	if readyCalls != 2 {
		t.Fatalf("readiness callback calls: %d", readyCalls)
	}
}

func TestProjectCreateIdentityTargetAndAccess(t *testing.T) {
	database := newProjectHTTPOperations(t)
	handler := projectTestHandler(t, database, io.Discard)
	actor := handler.principal
	teamID := "00000000-0000-4000-8000-000000000090"
	input := api.CreateProjectRequest{Name: " 原文 ", RepoURL: "git@example.com:Org/Repo.git", TeamID: &teamID, ExpectedUserID: actor.UserID}
	projectHTTPCreate(t, database, actor, input.Name, input.RepoURL, teamID, true)
	response := projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input))
	doc := decodeResponse[api.ProjectDocument](t, response, http.StatusCreated)
	if doc.Name != input.Name || doc.RepoURL != input.RepoURL || doc.Ownership.TeamID != teamID || doc.Access.Ownership != doc.Ownership || doc.Access.ProjectID != doc.ID || doc.Access.DirectGrant == nil || doc.Access.DirectGrant.UserID != actor.UserID || doc.Access.DirectGrant.Role != "admin" || doc.Access.EffectiveRole != "admin" {
		t.Fatalf("created document: %+v", doc)
	}
	input.ExpectedUserID = "00000000-0000-4000-8000-000000000001"
	projectHTTPCreateResult(t, database, actor, coreproject.CreateProject{Name: input.Name, RepoURL: input.RepoURL, TeamID: input.TeamID, ExpectedUserID: input.ExpectedUserID}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("identity_mismatch", "The signed-in account changed. Review the Team operation again."))
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusConflict, "identity_mismatch")
	for _, body := range []string{`{"name":"x","repoUrl":"host:repo"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":null}`, `{"name":"\ud800","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `"}`, `{"name":"x","repoUrl":"host:\udfff","expectedUserId":"` + actor.UserID + `"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"bad"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":null}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":"bad"}`} {
		switch body {
		case `{"name":"x","repoUrl":"host:repo","expectedUserId":"bad"}`:
			projectHTTPCreateResult(t, database, actor, coreproject.CreateProject{Name: "x", RepoURL: "host:repo", ExpectedUserID: "bad"}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "expectedUserId must be a canonical user UUID."))
		case `{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":"bad"}`:
			badTeam := "bad"
			projectHTTPCreateResult(t, database, actor, coreproject.CreateProject{Name: "x", RepoURL: "host:repo", ExpectedUserID: actor.UserID, TeamID: &badTeam}, model.Project{}, model.ProjectAccess{}, projectHTTPFault("invalid_input", "Team ID must be a canonical UUID."))
		}
		assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", body), http.StatusBadRequest, "invalid_input")
	}
	input.ExpectedUserID = actor.UserID
	missing := "00000000-0000-4000-8000-000000000002"
	input.TeamID = &missing
	projectHTTPCreateResult(t, database, actor, coreproject.CreateProject{Name: input.Name, RepoURL: input.RepoURL, TeamID: input.TeamID, ExpectedUserID: input.ExpectedUserID}, model.Project{}, model.ProjectAccess{}, &store.TransactionError{Phase: "operation", Cause: model.ErrNotFound, Outcome: store.TransactionNotCommitted})
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusNotFound, "not_found")
}
