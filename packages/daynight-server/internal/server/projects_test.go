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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func projectTestStore(t *testing.T) *store.Store { return testsupport.TestStore(t) }

func projectTestHandler(t *testing.T, database *store.Store, output io.Writer) *resourceTestHandler {
	t.Helper()
	return resourceTestServer(t, database, attachmentTestFiles(t), output)
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
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	empty := projectRequest(handler, http.MethodGet, "/api/v1/projects", "")
	page := decodeResponse[api.ProjectPage](t, empty, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil || !strings.Contains(empty.Body.String(), `"items":[]`) || !strings.Contains(empty.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty list shape: %s", empty.Body)
	}
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
	read := decodeResponse[api.Project](t, projectRequest(handler, http.MethodGet, "/api/v1/projects/"+strings.ToUpper(project.ID), ""), http.StatusOK)
	if read != project {
		t.Fatalf("read differs from create: %+v %+v", read, project)
	}
	page = decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 1 || page.Items[0] != project || page.NextCursor != nil {
		t.Fatalf("persisted list: %+v", page)
	}
	if !strings.Contains(logs.String(), `"project_id":"`+project.ID+`"`) || !strings.Contains(logs.String(), `"route":"POST /api/v1/projects"`) || strings.Contains(logs.String(), project.RepoURL) {
		t.Fatalf("missing resource correlation or unsafe logs: %s", &logs)
	}
}

func TestProjectHTTPRejectsInvalidBodies(t *testing.T) {
	database := projectTestStore(t)
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
		`{"name":null,"repoUrl":"https://github.com/example/repo"}`,
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
		`{"name":"` + strings.Repeat("x", httpx.MaxJSONBody) + `","repoUrl":"https://github.com/example/repo","expectedUserId":"` + handler.principal.UserID + `"}`,
	} {
		t.Run(string(body[:min(len(body), 80)]), func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", body), http.StatusBadRequest, "invalid_input")
		})
	}
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
	page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects", ""), http.StatusOK)
	if len(page.Items) != 0 {
		t.Fatal("invalid request created a project")
	}
}

func TestProjectHTTPPaginationWithTiedTimestamps(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	for _, id := range ids {
		if _, err := database.CreatePrivateProject(context.Background(), handler.principal, id, "same time", "https://github.com/example/repo"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := database.Pool.Exec(context.Background(), "UPDATE projects SET created_at='2026-01-01T00:00:00Z', updated_at='2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	path := "/api/v1/projects?limit=1"
	for index, id := range ids {
		page := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		if len(page.Items) != 1 || page.Items[0].ID != id || (page.NextCursor != nil) != (index < len(ids)-1) {
			t.Fatalf("incorrect keyset page %d: %+v", index, page)
		}
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
			tampered := base64.RawURLEncoding.EncodeToString(wrongScope)
			assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+url.QueryEscape(tampered), ""), http.StatusBadRequest, "invalid_input")
		}
	}
}

func TestProjectHTTPInvalidQueriesAndMissingResources(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
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
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""), http.StatusNotFound, "not_found")
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/unknown-secret-path?query=secret", ""), http.StatusNotFound, "not_found")
	for _, path := range []string{"/api/v1/projects", "/api/v1/projects/00000000-0000-4000-8000-000000000099"} {
		response := projectRequest(handler, http.MethodDelete, path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if !strings.Contains(response.Header().Get("Allow"), "GET") || strings.Contains(response.Header().Get("Allow"), "POST") != (path == "/api/v1/projects") {
			t.Fatalf("invalid Allow: %s", response.Header().Get("Allow"))
		}
	}
}

func TestProjectHTTPScopedPagination(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	ctx := context.Background()
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"}
	var teamID string
	for _, id := range ids {
		project, err := database.CreatePrivateProject(ctx, handler.principal, id, "project", "https://github.com/example/repo")
		if err != nil {
			t.Fatal(err)
		}
		teamID = project.Ownership.TeamID
	}
	query := "teamId=" + strings.ToUpper(teamID)
	first := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&"+query, ""), http.StatusOK)
	if len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("first team page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	second := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1&teamId="+teamID+"&cursor="+cursor, ""), http.StatusOK)
	if len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextCursor != nil {
		t.Fatalf("second team page: %+v", second)
	}
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 0 || shared.Items == nil || shared.NextCursor != nil {
		t.Fatalf("shared scope included team projects: %+v", shared)
	}
	for _, scope := range []string{"", "&shared=true", "&teamId=00000000-0000-4000-8000-000000000099"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?cursor="+cursor+scope, ""), http.StatusBadRequest, "invalid_input")
	}
	all := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1", ""), http.StatusOK)
	if all.NextCursor == nil {
		t.Fatal("all-accessible cursor missing")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, "/api/v1/projects?"+query+"&cursor="+url.QueryEscape(*all.NextCursor), ""), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPSharedPaginationRejectsOtherScopesAndPrincipals(t *testing.T) {
	h := membershipTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	projectRoutes(mux, service.NewProjects(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	ctx := context.Background()
	admin, err := h.Identity.Authenticate(ctx, model.SessionCredential, h.admin.Value)
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.NewProjects(h.Database).Create(ctx, admin, service.CreateProject{ExpectedUserID: admin.UserID, Name: "Second shared", RepoURL: "https://example.com/second.git"})
	if err != nil {
		t.Fatal(err)
	}
	other := decodeResponse[api.User](t, h.call(http.MethodGet, "/api/v1/me", "", h.outsider), http.StatusOK)
	member := decodeResponse[api.User](t, h.call(http.MethodGet, "/api/v1/me", "", h.member), http.StatusOK)
	for index, project := range []model.Project{h.project, second} {
		if _, err := h.Database.Pool.Exec(ctx, `UPDATE projects SET created_at='2024-01-01 00:00:00+00'::timestamptz + $2::int * interval '1 second' WHERE id=$1`, project.ID, index); err != nil {
			t.Fatal(err)
		}
		for _, userID := range []string{h.memberID, other.ID} {
			if _, err := h.Database.Pool.Exec(ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, userID); err != nil {
				t.Fatal(err)
			}
		}
	}
	first := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=1&shared=true", "", h.member), http.StatusOK)
	if len(first.Items) != 1 || first.Items[0].ID != h.project.ID || first.NextCursor == nil {
		t.Fatalf("first shared page: %+v", first)
	}
	cursor := url.QueryEscape(*first.NextCursor)
	next := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=1&shared=true&cursor="+cursor, "", h.member), http.StatusOK)
	if len(next.Items) != 1 || next.Items[0].ID != second.ID || next.NextCursor != nil {
		t.Fatalf("second shared page: %+v", next)
	}
	for _, query := range []string{"cursor=" + cursor, "teamId=" + member.PersonalTeam.ID + "&cursor=" + cursor} {
		assertProjectError(t, h.call(http.MethodGet, "/api/v1/projects?"+query, "", h.member), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, h.call(http.MethodGet, "/api/v1/projects?shared=true&cursor="+cursor, "", h.outsider), http.StatusBadRequest, "invalid_input")
}

func TestProjectHTTPTeamScopeRefusesNonmembersAndExposesDatabaseFailure(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	ctx := context.Background()
	project, err := database.CreatePrivateProject(ctx, handler.principal, "00000000-0000-4000-8000-000000000189", "Externally shared", "https://example.com/repo")
	if err != nil {
		t.Fatal(err)
	}
	const externalTeam = "00000000-0000-4000-8000-000000000190"
	const missingTeam = "00000000-0000-4000-8000-000000000191"
	if _, err := database.Pool.Exec(ctx, `INSERT INTO teams(id,name) VALUES($1,'External team')`, externalTeam); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE project_ownership SET team_id=$2 WHERE project_id=$1`, project.ID, externalTeam); err != nil {
		t.Fatal(err)
	}
	shared := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?shared=true", ""), http.StatusOK)
	if len(shared.Items) != 1 || shared.Items[0].ID != project.ID {
		t.Fatalf("direct grant should permit the shared project: %+v", shared)
	}
	nonmember := projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+externalTeam, "")
	missing := projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+missingTeam, "")
	assertProjectError(t, nonmember, http.StatusNotFound, "not_found")
	assertProjectError(t, missing, http.StatusNotFound, "not_found")
	if nonmember.Body.String() != missing.Body.String() {
		t.Fatalf("nonmember and missing Team refusals differ: %s vs %s", nonmember.Body, missing.Body)
	}
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE team_members RENAME TO private_membership_secret`); err != nil {
		t.Fatal(err)
	}
	failed := projectRequest(handler, http.MethodGet, "/api/v1/projects?teamId="+externalTeam, "")
	assertProjectError(t, failed, http.StatusInternalServerError, "internal_error")
	if strings.Contains(failed.Body.String(), "secret") || strings.Contains(logs.String(), "private_membership_secret") || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("database failure was hidden or disclosed: response %s, logs %s", failed.Body, &logs)
	}
}

func TestProjectHTTPDatabaseFailuresAreVisibleAndSafe(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	if _, err := database.Pool.Exec(context.Background(), "ALTER TABLE projects RENAME TO private_sql_secret"); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/v1/projects", ""},
		{http.MethodGet, "/api/v1/projects/00000000-0000-4000-8000-000000000099", ""},
		{http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "secret-body", RepoURL: "https://github.com/example/private-secret", ExpectedUserID: handler.principal.UserID})},
	} {
		response := projectRequest(handler, request.method, request.path, request.body)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), "database") || strings.Contains(response.Body.String(), "SQL") || strings.Contains(response.Body.String(), "secret") {
			t.Fatalf("unsafe server response: %s", response.Body)
		}
	}
	if !strings.Contains(logs.String(), `"cause":"database"`) || !strings.Contains(logs.String(), `"request_id":"project-test"`) || strings.Contains(logs.String(), "secret") || strings.Contains(logs.String(), "relation") {
		t.Fatalf("unsafe or uncorrelated diagnostics: %s", &logs)
	}
}

func TestProjectHTTPCanceledDatabaseRequestDoesNotWrite(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	transaction, err := database.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback(context.Background())
	if _, err := transaction.Exec(context.Background(), "LOCK TABLE projects IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response, finished := httptest.NewRecorder(), make(chan struct{})
	go func() { handler.ServeHTTP(response, request); close(finished) }()
	for {
		var waiting bool
		err := database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE pid <> pg_backend_pid() AND application_name=current_setting('application_name')
			AND wait_event_type='Lock' AND query LIKE '%FROM projects%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-finished:
			t.Fatal("blocked request completed before cancellation")
		case <-ctx.Done():
			t.Fatal("query did not wait for table lock")
		case <-time.After(5 * time.Millisecond):
		}
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

func TestPublicHealthAndReadinessUseLiveDatabase(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	created := projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "private-health-project", RepoURL: "https://example.test/private.git", ExpectedUserID: handler.principal.UserID}))
	decodeResponse[api.Project](t, created, http.StatusCreated)
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
	database.Close()
	response := request(http.MethodGet, "/readyz")
	assertProjectError(t, response, http.StatusServiceUnavailable, "service_unavailable")
	if strings.Contains(response.Body.String(), "private-health-project") || strings.Contains(response.Body.String(), "database") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("readiness failure exposed data or cached state: %s %+v", response.Body, response.Header())
	}
	decodeResponse[map[string]string](t, request(http.MethodGet, "/healthz"), http.StatusOK)
}

func TestProjectCreateIdentityTargetAndAccess(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	ctx := context.Background()
	actor := handler.principal
	team, err := teamservice.NewTeams(database).Create(ctx, actor, coreteam.CreateTeam{Name: "Team", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	input := api.CreateProjectRequest{Name: " 原文 ", RepoURL: "git@example.com:Org/Repo.git", TeamID: &team.ID, ExpectedUserID: actor.UserID}
	response := projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input))
	doc := decodeResponse[api.ProjectDocument](t, response, http.StatusCreated)
	if doc.Name != input.Name || doc.RepoURL != input.RepoURL || doc.Ownership.TeamID != team.ID || doc.Access.Ownership != doc.Ownership || doc.Access.ProjectID != doc.ID || doc.Access.DirectGrant == nil || doc.Access.DirectGrant.UserID != actor.UserID || doc.Access.DirectGrant.Role != "admin" || doc.Access.EffectiveRole != "admin" {
		t.Fatalf("created document: %+v", doc)
	}
	snapshot := func() string {
		var state string
		err := database.Pool.QueryRow(ctx, `SELECT jsonb_build_object('teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'ownership',(SELECT jsonb_agg(to_jsonb(o) ORDER BY project_id) FROM project_ownership o),'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY project_id,user_id) FROM project_grants g))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	input.ExpectedUserID = "00000000-0000-4000-8000-000000000001"
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusConflict, "identity_mismatch")
	for _, body := range []string{
		`{"name":"x","repoUrl":"host:repo"}`,
		`{"name":"x","repoUrl":"host:repo","expectedUserId":null}`,
		`{"name":"\ud800","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `"}`,
		`{"name":"x","repoUrl":"host:\udfff","expectedUserId":"` + actor.UserID + `"}`,
		`{"name":"x","repoUrl":"host:repo","expectedUserId":"bad"}`,
		`{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":null}`,
		`{"name":"x","repoUrl":"host:repo","expectedUserId":"` + actor.UserID + `","teamId":"bad"}`,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", body), http.StatusBadRequest, "invalid_input")
	}
	input.ExpectedUserID = actor.UserID
	missing := "00000000-0000-4000-8000-000000000002"
	input.TeamID = &missing
	assertProjectError(t, projectRequest(handler, http.MethodPost, "/api/v1/projects", jsonBody(t, input)), http.StatusNotFound, "not_found")
	if after := snapshot(); before != after {
		t.Fatal("rejected writes changed domain rows or versions")
	}
}

func TestProjectCreateUnknownOutcomeClassification(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	request := httptest.NewRequest(http.MethodPost, "/api/v1/projects", nil)
	request.Header.Set("X-Request-ID", "project-test")
	for _, test := range []struct {
		err    error
		status int
		code   string
	}{
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: &model.Fault{Code: "forbidden", Message: "private"}}, 500, "internal_error"},
		{&store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionNotCommitted, Cause: errors.New("private")}, 500, "internal_error"},
	} {
		response := httptest.NewRecorder()
		httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeProjectCreateError(w, r, logger, test.err) })).ServeHTTP(response, request)
		assertProjectError(t, response, test.status, test.code)
	}
	for _, short := range []bool{false, true} {
		writer := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: short}
		httpx.WriteMutationJSON(writer, request, logger, "project", 201, api.ProjectDocument{})
		if writer.calls != 1 {
			t.Fatal("response replayed")
		}
	}
	if strings.Contains(logs.String(), "private") {
		t.Fatal("private errors leaked")
	}
}
