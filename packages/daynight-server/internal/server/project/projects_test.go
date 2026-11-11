package project

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
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

func TestProjectHTTPCreateReadAndEmptyList(t *testing.T) {
	database := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 50}, []model.Project{}, false)
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
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 50}, []model.Project{*expected}, false)
	page = decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0] != project || page.NextCursor != nil {
		t.Fatalf("project list projection: %+v", page)
	}
	if !strings.Contains(logs.String(), `"project_id":"`+project.ID+`"`) || !strings.Contains(logs.String(), `"route":"POST /api/v1/projects"`) || strings.Contains(logs.String(), project.RepoURL) {
		t.Fatalf("missing resource correlation or unsafe logs: %s", &logs)
	}
}

func TestProjectHTTPRejectsInvalidBodies(t *testing.T) {
	database := newHTTPTestStore(t)
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
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 50}, []model.Project{}, false)
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 0 {
		t.Fatal("invalid request created a project")
	}
}

func TestProjectHTTPPaginationWithTiedTimestamps(t *testing.T) {
	database := newHTTPTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	path := "/api/v1/projects?limit=1"
	var after *store.Position
	for index, id := range ids {
		record := projectHTTPRecord(id, "same time", "https://github.com/example/repo", projectHTTPPersonalTeam)
		projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 1, After: after}, []model.Project{record}, index < len(ids)-1)
		page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		if len(page.Items) != 1 || page.Items[0].ID != id || (page.NextCursor != nil) != (index < len(ids)-1) {
			t.Fatalf("incorrect keyset page %d: %+v", index, page)
		}
		after = &store.Position{CreatedAt: record.CreatedAt, ID: id}
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
			assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+url.QueryEscape(base64.RawURLEncoding.EncodeToString(wrongScope)), ""), http.StatusBadRequest, "invalid_input")
		}
	}
}

func TestProjectHTTPInvalidQueriesAndMissingResources(t *testing.T) {
	database := newHTTPTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	for _, query := range []string{
		"limit=", "limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=invalid", "limit=1&limit=2",
		"cursor=", "cursor=bad", "cursor=one&cursor=two", "status=todo", "limit=%xx", "limit=1;cursor=x",
		"teamId=", "teamId=invalid", "teamId=one&teamId=two", "shared=", "shared=false", "shared=TRUE", "shared=1", "shared=true&shared=true",
		"teamId=00000000-0000-4000-8000-000000000001&shared=true",
	} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	for _, path := range []string{"not-a-uuid", "00000000-0000-4000-8000-00000000000z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+path, ""), http.StatusBadRequest, "invalid_input")
	}
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		called()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, id, "00000000-0000-4000-8000-000000000099")
		return model.ProjectAccess{}, model.ErrNotFound
	}})
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""), http.StatusNotFound, "not_found")
	deletedRead := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		deletedRead()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, id, "00000000-0000-4000-8000-000000000099")
		return model.ProjectAccess{}, model.ErrNotFound
	}})
	assertProjectError(t, projectRequest(handler, http.MethodDelete, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""), http.StatusNotFound, "not_found")
	response := projectRequest(handler, http.MethodDelete, "/api/v1/projects", "")
	assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
	if !strings.Contains(response.Header().Get("Allow"), "GET") || !strings.Contains(response.Header().Get("Allow"), "POST") {
		t.Fatalf("invalid Allow: %s", response.Header().Get("Allow"))
	}
}

func TestProjectHTTPScopedPagination(t *testing.T) {
	database := newHTTPTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	firstRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000001", "project", "https://github.com/example/repo", projectHTTPPersonalTeam)
	secondRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000002", "project", "https://github.com/example/repo", projectHTTPPersonalTeam)
	teamID := firstRecord.Ownership.TeamID
	if strings.ToUpper(teamID) == teamID {
		t.Fatal("team cursor fixture must have a distinct uppercase alias")
	}
	query := "teamId=" + strings.ToUpper(teamID)
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeTeam, teamID), store.Page{Limit: 1}, []model.Project{firstRecord}, true)
	first := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&"+query, ""), http.StatusOK)
	if len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first team page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeTeam, teamID), store.Page{Limit: 1, After: &store.Position{CreatedAt: firstRecord.CreatedAt, ID: firstRecord.ID}}, []model.Project{secondRecord}, false)
	second := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&teamId="+teamID+"&cursor="+cursor, ""), http.StatusOK)
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextCursor != nil {
		t.Fatalf("second team page: %+v", second)
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeShared, ""), store.Page{Limit: 50}, []model.Project{}, false)
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 0 || shared.Items == nil || shared.NextCursor != nil {
		t.Fatalf("shared scope included team projects: %+v", shared)
	}
	for _, scope := range []string{"", "&shared=true", "&teamId=00000000-0000-4000-8000-000000000099"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+cursor+scope, ""), http.StatusBadRequest, "invalid_input")
	}
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 1}, []model.Project{firstRecord}, true)
	all := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1", ""), http.StatusOK)
	if all.NextCursor == nil {
		t.Fatal("all-accessible cursor missing")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query+"&cursor="+url.QueryEscape(*all.NextCursor), ""), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPSharedPaginationRejectsOtherScopesAndPrincipals(t *testing.T) {
	principal := defaultHTTPPrincipal()
	principal.UserID = "00000000-0000-4000-8000-000000000040"
	database := newHTTPTestStoreForPrincipal(t, principal)
	handler := resourceTestServerForPrincipal(t, database, io.Discard, principal)
	firstRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000001", "First shared", "https://example.com/first.git", projectHTTPPersonalTeam)
	secondRecord := projectHTTPRecord("00000000-0000-4000-8000-000000000002", "Second shared", "https://example.com/second.git", projectHTTPPersonalTeam)
	secondRecord.CreatedAt = firstRecord.CreatedAt.Add(time.Second)
	secondRecord.UpdatedAt = secondRecord.CreatedAt
	projectHTTPPage(t, database, principal, projectHTTPListScope(store.ProjectScopeShared, ""), store.Page{Limit: 1}, []model.Project{firstRecord}, true)
	first := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&shared=true", ""), http.StatusOK)
	if len(first.Items) != 1 || first.Items[0].ID != firstRecord.ID || first.NextCursor == nil {
		t.Fatalf("first shared page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	projectHTTPPage(t, database, principal, projectHTTPListScope(store.ProjectScopeShared, ""), store.Page{Limit: 1, After: &store.Position{CreatedAt: firstRecord.CreatedAt, ID: firstRecord.ID}}, []model.Project{secondRecord}, false)
	next := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&shared=true&cursor="+cursor, ""), http.StatusOK)
	if len(next.Items) != 1 || next.Items[0].ID != secondRecord.ID || next.NextCursor != nil {
		t.Fatalf("second shared page: %+v", next)
	}
	for _, query := range []string{"cursor=" + cursor, "teamId=" + projectHTTPPersonalTeam + "&cursor=" + cursor} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
	outsider := defaultHTTPPrincipal()
	outsider.UserID = "00000000-0000-4000-8000-000000000041"
	other := resourceTestServerForPrincipal(t, newHTTPTestStoreForPrincipal(t, outsider), io.Discard, outsider)
	assertProjectError(t, projectRequest(other, http.MethodGet, "/api/v1/projects?shared=true&cursor="+cursor, ""), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPTeamScopeRefusesNonmembersAndExposesDatabaseFailure(t *testing.T) {
	database := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	const externalTeam = "00000000-0000-4000-8000-000000000190"
	const missingTeam = "00000000-0000-4000-8000-000000000191"
	record := projectHTTPRecord("00000000-0000-4000-8000-000000000189", "Externally shared", "https://example.com/repo", externalTeam)
	projectHTTPPage(t, database, handler.principal, projectHTTPListScope(store.ProjectScopeShared, ""), store.Page{Limit: 50}, []model.Project{record}, false)
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 1 || shared.Items[0].ID != record.ID {
		t.Fatalf("direct grant should permit the shared project: %+v", shared)
	}
	refusal := func(team string) *httptest.ResponseRecorder {
		called := projectHTTPCount(t, 1)
		projectHTTPRead(t, database, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
			called()
			projectHTTPCheck(t, p, handler.principal)
			projectHTTPCheck(t, scope, projectHTTPListScope(store.ProjectScopeTeam, team))
			projectHTTPCheck(t, page, store.Page{Limit: 50})
			return store.ProjectPage{}, model.ErrNotFound
		}})
		return projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+team, "")
	}
	nonmember, missing := refusal(externalTeam), refusal(missingTeam)
	assertProjectError(t, nonmember, http.StatusNotFound, "not_found")
	assertProjectError(t, missing, http.StatusNotFound, "not_found")
	if nonmember.Body.String() != missing.Body.String() {
		t.Fatalf("nonmember and missing Team refusals differ: %s vs %s", nonmember.Body, missing.Body)
	}
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, scope, projectHTTPListScope(store.ProjectScopeTeam, externalTeam))
		projectHTTPCheck(t, page, store.Page{Limit: 50})
		return store.ProjectPage{}, &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_membership_secret")}
	}})
	failed := projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+externalTeam, "")
	assertProjectError(t, failed, http.StatusInternalServerError, "internal_error")
	if strings.Contains(failed.Body.String(), "secret") || strings.Contains(logs.String(), "private_membership_secret") || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("database failure was hidden or disclosed: response %s, logs %s", failed.Body, &logs)
	}
}

func TestProjectHTTPDatabaseFailuresAreVisibleAndSafe(t *testing.T) {
	database := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	failure := &store.Error{Phase: "query", DatabaseFailure: true, Cause: errors.New("private_sql_secret relation missing")}
	list := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		list()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, scope, projectHTTPListScope(store.ProjectScopeAll, ""))
		projectHTTPCheck(t, page, store.Page{Limit: 50})
		return store.ProjectPage{}, failure
	}})
	responses := []*httptest.ResponseRecorder{projectRequest(handler, http.MethodGet, "/api/v1/projects", "")}
	get := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
		get()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, id, "00000000-0000-4000-8000-000000000099")
		return model.ProjectAccess{}, failure
	}})
	responses = append(responses, projectRequest(handler, http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""))
	create := projectHTTPCount(t, 1)
	database.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
		create()
		projectHTTPCheck(t, user, handler.principal.UserID)
		return store.Completion{Outcome: store.TransactionNotCommitted}, failure
	}
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
	database := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	reached, finished := make(chan struct{}), make(chan struct{})
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, database, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, p, handler.principal)
		projectHTTPCheck(t, scope, projectHTTPListScope(store.ProjectScopeAll, ""))
		projectHTTPCheck(t, page, store.Page{Limit: 50})
		close(reached)
		<-ctx.Done()
		return store.ProjectPage{}, &store.Error{Phase: "query", Cause: ctx.Err()}
	}})
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

func TestProjectCreateIdentityTargetAndAccess(t *testing.T) {
	database := newHTTPTestStore(t)
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
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusConflict, "identity_mismatch")
	for _, body := range []string{`{"name":"x","repoUrl":"host:repo"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":null}`, `{"name":"\ud800","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `"}`, `{"name":"x","repoUrl":"host:\udfff","expectedUserId":"` + actor.UserID + `"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"bad"}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":null}`, `{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":"bad"}`} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", body), http.StatusBadRequest, "invalid_input")
	}
	input.ExpectedUserID = actor.UserID
	missing := "00000000-0000-4000-8000-000000000002"
	input.TeamID = &missing
	called, lookup := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	database.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
		called()
		projectHTTPCheck(t, user, actor.UserID)
		err := op(projectHTTPCreateDAO{TeamCall: func(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
			lookup()
			projectHTTPCheck(t, id, missing)
			return store.ProjectCreationTeam{}, model.ErrNotFound
		}})
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Cause: err, Outcome: store.TransactionNotCommitted}
	}
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusNotFound, "not_found")
}

const projectTestOrigin = "https://daynight.example"

type httpTestStore struct {
	t                        *testing.T
	ReadSnapshotCall         func(context.Context, func(store.SnapshotScope) error) error
	WriteProjectCall         func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
	WriteProjectCreationCall func(context.Context, string, func(store.ProjectCreationDAO) error) (store.Completion, error)
}

func (s *httpTestStore) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		s.t.Fatal("unexpected ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, op)
}
func (s *httpTestStore) WriteProject(ctx context.Context, id string, op func(store.ProjectWriteScope) error) (store.Completion, error) {
	if s.WriteProjectCall == nil {
		s.t.Fatal("unexpected WriteProject")
	}
	return s.WriteProjectCall(ctx, id, op)
}
func (s *httpTestStore) WriteProjectCreation(ctx context.Context, owner string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
	if s.WriteProjectCreationCall == nil {
		s.t.Fatal("unexpected WriteProjectCreation")
	}
	return s.WriteProjectCreationCall(ctx, owner, op)
}
func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}
func httpTestToken(kind model.CredentialKind) string {
	const value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	switch kind {
	case model.PATCredential:
		return "dnpat_" + value
	case model.SessionCredential:
		return "dnst_" + value
	default:
		panic("unsupported credential")
	}
}
func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }
func newHTTPTestStoreForPrincipal(t *testing.T, _ model.Principal) *httpTestStore {
	return newHTTPTestStore(t)
}

type resourceTestHandler struct {
	http.Handler
	t            *testing.T
	principal    model.Principal
	token        string
	authenticate func(context.Context, model.CredentialKind, string) (model.Principal, error)
}

func (h *resourceTestHandler) setCredential(kind model.CredentialKind, token string, principal model.Principal, failure error) {
	called := projectHTTPCount(h.t, 1)
	h.authenticate = func(_ context.Context, gotKind model.CredentialKind, got string) (model.Principal, error) {
		called()
		if gotKind != kind || got != token {
			panic("unexpected credential")
		}
		if failure != nil {
			return model.Principal{}, authhttp.Failure()
		}
		return principal, nil
	}
}
func resourceTestServerForPrincipal(t *testing.T, database *httpTestStore, output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	h := &resourceTestHandler{t: t, principal: principal, token: httpTestToken(principal.Kind)}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if h.authenticate != nil {
			return h.authenticate(ctx, kind, token)
		}
		if kind != principal.Kind || token != h.token {
			return model.Principal{}, authhttp.Failure()
		}
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: projectTestOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, projectservice.NewProjects(database), auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	return h
}
func projectTestHandler(t *testing.T, database *httpTestStore, output io.Writer) *resourceTestHandler {
	return resourceTestServerForPrincipal(t, database, output, defaultHTTPPrincipal())
}
func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if h, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+h.token)
	}
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
func identityDecode[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}
func await(t *testing.T, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for operation")
	}
}

type projectHTTPReader struct {
	store.ProjectReader
	ProjectCall        func(context.Context, string) (model.Project, error)
	ProjectAccessCall  func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	ScopedProjectsCall func(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error)
}

func (d projectHTTPReader) Project(ctx context.Context, id string) (model.Project, error) {
	return d.ProjectCall(ctx, id)
}
func (d projectHTTPReader) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	return d.ProjectAccessCall(ctx, p, id)
}
func (d projectHTTPReader) ScopedProjects(ctx context.Context, p model.Principal, s store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	return d.ScopedProjectsCall(ctx, p, s, page)
}

type projectHTTPSnapshot struct {
	store.SnapshotScope
	ProjectReader store.ProjectReader
}

func (s projectHTTPSnapshot) ProjectDAO() store.ProjectReader { return s.ProjectReader }

type projectHTTPCreateDAO struct {
	store.ProjectCreationDAO
	PersonalCall func(context.Context, bool) (store.PersonalTeamFacts, error)
	TeamCall     func(context.Context, string) (store.ProjectCreationTeam, error)
	MemberCall   func(context.Context, string) (bool, error)
	InsertCall   func(context.Context, string, string, string, string) (model.Project, model.ProjectAccess, error)
}

func (d projectHTTPCreateDAO) CreationPersonalTeam(ctx context.Context, create bool) (store.PersonalTeamFacts, error) {
	return d.PersonalCall(ctx, create)
}
func (d projectHTTPCreateDAO) LockCreationTeam(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
	return d.TeamCall(ctx, id)
}
func (d projectHTTPCreateDAO) CreationTeamMember(ctx context.Context, id string) (bool, error) {
	return d.MemberCall(ctx, id)
}
func (d projectHTTPCreateDAO) InsertProject(ctx context.Context, id, name, repo, team string) (model.Project, model.ProjectAccess, error) {
	return d.InsertCall(ctx, id, name, repo, team)
}

func projectHTTPCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("unexpected Project DAO argument/result: got %#v, want %#v", got, want)
		panic("Project DAO contract violated")
	}
}
func projectHTTPCount(t *testing.T, want int) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != want {
			t.Errorf("Project DAO call count: got %d, want %d", calls, want)
		}
	})
	return func() {
		calls++
		if calls > want {
			t.Errorf("extra Project DAO call: %d > %d", calls, want)
			panic("extra Project DAO call")
		}
	}
}
func projectHTTPRead(t *testing.T, tx *httpTestStore, reader store.ProjectReader) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		called()
		return op(projectHTTPSnapshot{ProjectReader: reader})
	}
}
func projectHTTPRecord(id, name, repo, team string) model.Project {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Project{ID: id, Name: name, RepoURL: repo, CreatedAt: at, UpdatedAt: at, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}, Ownership: model.ProjectOwnership{TeamID: team, Version: 1, UpdatedAt: at}}
}
func projectHTTPAccess(p model.Principal, v model.Project) model.ProjectAccess {
	role := model.ProjectAdmin
	grant := model.ProjectGrant{ProjectID: v.ID, UserID: p.UserID, Role: role, Version: 1, CreatedAt: v.CreatedAt, UpdatedAt: v.CreatedAt}
	return model.ProjectAccess{ProjectID: v.ID, UserID: p.UserID, Role: role, DirectGrant: &grant, OwnerTeam: model.TeamRef{ID: v.Ownership.TeamID, Kind: "personal"}, Ownership: v.Ownership, TeamRole: &role, CanTransfer: true}
}
func projectHTTPGet(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project) {
	t.Helper()
	access, read := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		access()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, id, v.ID)
		return projectHTTPAccess(p, v), nil
	}, ProjectCall: func(ctx context.Context, id string) (model.Project, error) {
		read()
		projectHTTPCheck(t, id, v.ID)
		return v, nil
	}})
}
func projectHTTPPage(t *testing.T, tx *httpTestStore, p model.Principal, scope store.ProjectScope, page store.Page, items []model.Project, more bool) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ScopedProjectsCall: func(ctx context.Context, actor model.Principal, gotScope store.ProjectScope, gotPage store.Page) (store.ProjectPage, error) {
		called()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, gotScope, scope)
		projectHTTPCheck(t, gotPage, page)
		return store.ProjectPage{Items: slices.Clone(items), HasMore: more}, nil
	}})
}
func projectHTTPCreate(t *testing.T, tx *httpTestStore, p model.Principal, name, repo, team string, explicit bool) *model.Project {
	t.Helper()
	out := new(model.Project)
	writer, first, insert := projectHTTPCount(t, 1), projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	dao := projectHTTPCreateDAO{InsertCall: func(ctx context.Context, id, gotName, gotRepo, gotTeam string) (model.Project, model.ProjectAccess, error) {
		insert()
		parsed, err := uuid.Parse(id)
		if err != nil || parsed.Version() != 4 {
			t.Errorf("create did not allocate UUIDv4: %s %v", id, err)
			panic("invalid created Project ID")
		}
		projectHTTPCheck(t, gotName, name)
		projectHTTPCheck(t, gotRepo, repo)
		projectHTTPCheck(t, gotTeam, team)
		*out = projectHTTPRecord(id, name, repo, team)
		access := projectHTTPAccess(p, *out)
		if explicit {
			name := "Team"
			access.OwnerTeam = model.TeamRef{ID: team, Kind: "ordinary", Name: &name}
		}
		return *out, access, nil
	}}
	if explicit {
		member := projectHTTPCount(t, 1)
		dao.TeamCall = func(ctx context.Context, id string) (store.ProjectCreationTeam, error) {
			first()
			projectHTTPCheck(t, id, team)
			return store.ProjectCreationTeam{ID: team}, nil
		}
		dao.MemberCall = func(ctx context.Context, id string) (bool, error) {
			member()
			projectHTTPCheck(t, id, team)
			return true, nil
		}
	} else {
		dao.PersonalCall = func(ctx context.Context, create bool) (store.PersonalTeamFacts, error) {
			first()
			projectHTTPCheck(t, create, true)
			return store.PersonalTeamFacts{ID: team, MemberCount: 1, OwnerAdminCount: 1}, nil
		}
	}
	tx.WriteProjectCreationCall = func(ctx context.Context, user string, op func(store.ProjectCreationDAO) error) (store.Completion, error) {
		writer()
		projectHTTPCheck(t, user, p.UserID)
		err := op(dao)
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return out
}

const projectHTTPPersonalTeam = "d0000000-0000-4000-8000-000000000050"

func projectHTTPListScope(kind store.ProjectScopeKind, team string) store.ProjectScope {
	return store.ProjectScope{Kind: kind, TeamID: team}
}

func projectHTTPCopyPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func projectHTTPCopyAccess(value model.ProjectAccess) model.ProjectAccess {
	value.DirectGrant = projectHTTPCopyPointer(value.DirectGrant)
	value.OwnerTeam.Name = projectHTTPCopyPointer(value.OwnerTeam.Name)
	value.TeamRole = projectHTTPCopyPointer(value.TeamRole)
	return value
}
func projectHTTPCopyTeam(value model.Team) model.Team {
	value.Name = projectHTTPCopyPointer(value.Name)
	return value
}

type settingsHTTPWriteDAO struct {
	store.ProjectWriteDAO
	access  func(context.Context, model.Principal) (model.ProjectAccess, error)
	project func(context.Context) (model.Project, error)
	update  func(context.Context, int32) (model.Project, error)
}

func (d settingsHTTPWriteDAO) ProjectAccess(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
	return d.access(ctx, actor)
}
func (d settingsHTTPWriteDAO) Project(ctx context.Context) (model.Project, error) {
	return d.project(ctx)
}
func (d settingsHTTPWriteDAO) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	return d.update(ctx, minutes)
}

type settingsHTTPWriteScope struct {
	store.ProjectWriteScope
	dao store.ProjectWriteDAO
}

func (s settingsHTTPWriteScope) ProjectDAO() store.ProjectWriteDAO { return s.dao }

func settingsHTTPWrite(t *testing.T, tx *httpTestStore, actor model.Principal, before model.Project, minutes int32, result *model.Project, role model.ProjectRole, accessError error) {
	t.Helper()
	writes, access := projectHTTPCount(t, 1), projectHTTPCount(t, 1)
	order := []string{"access"}
	if accessError == nil && role == model.ProjectAdmin {
		order = append(order, "project")
		if result != nil {
			order = append(order, "update")
		}
	}
	position := 0
	next := func(method string) {
		if position >= len(order) {
			t.Errorf("extra settings DAO call %s", method)
			panic("extra settings DAO call")
		}
		projectHTTPCheck(t, method, order[position])
		position++
	}
	t.Cleanup(func() { projectHTTPCheck(t, position, len(order)) })
	dao := settingsHTTPWriteDAO{access: func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		access()
		next("access")
		projectHTTPCheck(t, principal, actor)
		value := projectHTTPAccess(actor, before)
		value.Role = role
		value.DirectGrant.Role = role
		value.TeamRole = nil
		value.CanTransfer = false
		if role == model.ProjectAdmin {
			value.TeamRole = &role
			value.CanTransfer = true
		}
		return value, accessError
	}}
	if len(order) > 1 {
		read := projectHTTPCount(t, 1)
		dao.project = func(context.Context) (model.Project, error) { read(); next("project"); return before, nil }
	}
	if result != nil {
		updated := projectHTTPCount(t, 1)
		dao.update = func(ctx context.Context, got int32) (model.Project, error) {
			updated()
			next("update")
			projectHTTPCheck(t, got, minutes)
			return *result, nil
		}
	}
	tx.WriteProjectCall = func(ctx context.Context, id string, operation func(store.ProjectWriteScope) error) (store.Completion, error) {
		writes()
		projectHTTPCheck(t, id, before.ID)
		err := operation(settingsHTTPWriteScope{dao: dao})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func accessHTTPProject(t *testing.T, tx *httpTestStore, p model.Principal, v model.Project, access model.ProjectAccess, kind string, _ *time.Time, _ *model.GraphTask) {
	t.Helper()
	if kind != "access" {
		t.Fatalf("unexpected access mode %s", kind)
	}
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		called()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, id, v.ID)
		return access, nil
	}})
}
func accessHTTPRefusal(t *testing.T, tx *httpTestStore, p model.Principal, id string, failure error) {
	t.Helper()
	called := projectHTTPCount(t, 1)
	projectHTTPRead(t, tx, projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, got string) (model.ProjectAccess, error) {
		called()
		projectHTTPCheck(t, actor, p)
		projectHTTPCheck(t, got, id)
		return model.ProjectAccess{}, failure
	}})
}
