package server

import (
	"bytes"
	"context"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5/pgconn"
)

func taskProject(t *testing.T, handler http.Handler) api.Project {
	t.Helper()
	return decodeResponse[api.Project](t, projectRequest(handler, http.MethodPost, "/api/v1/projects", `{"name":"Task project","repoUrl":"https://github.com/example/tasks"}`), http.StatusCreated)
}

func taskCollection(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }

func taskPath(task api.Task) string { return taskCollection(task.ProjectID) + "/" + task.ID }

func jsonBody(t *testing.T, input any) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func createHTTPTask(t *testing.T, handler http.Handler, projectID, title string, dependencies ...string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPost, taskCollection(projectID), jsonBody(t, map[string]any{
		"title": title, "description": "initial description", "dependsOn": append([]string{}, dependencies...),
	})), http.StatusCreated)
}

func updateHTTPTask(t *testing.T, handler http.Handler, task api.Task, values map[string]any) api.Task {
	t.Helper()
	values["version"] = task.Version
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, values)), http.StatusOK)
}

func setHTTPTask(t *testing.T, handler http.Handler, task api.Task, status string) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodPut, taskPath(task)+"/status",
		jsonBody(t, api.TaskStatusUpdateRequest{Version: task.Version, Status: status})), http.StatusOK)
}

func readHTTPTask(t *testing.T, handler http.Handler, task api.Task) api.Task {
	t.Helper()
	return decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskPath(task), ""), http.StatusOK)
}

func TestTaskHTTPLifecycleDefaultsAndUpdateSemantics(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	collection := taskCollection(project.ID)
	empty := projectRequest(handler, http.MethodGet, collection, "")
	page := decodeResponse[api.TaskPage](t, empty, http.StatusOK)
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil || !strings.Contains(empty.Body.String(), `"items":[]`) || !strings.Contains(empty.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty task list: %s", empty.Body)
	}
	response := projectRequest(handler, http.MethodPost, collection, `{"title":"Default values"}`)
	task := decodeResponse[api.Task](t, response, http.StatusCreated)
	if task.ID == "" || task.ProjectID != project.ID || task.Title != "Default values" || task.Description != "" || task.Status != "todo" || task.Version != 1 || !task.Ready || task.DependsOn == nil || task.BlockedBy == nil || len(task.DependsOn) != 0 || len(task.BlockedBy) != 0 || task.CreatedAt.IsZero() || task.CreatedAt.Location() != time.UTC || task.CreatedAt != task.UpdatedAt {
		t.Fatalf("created task DTO: %+v", task)
	}
	if response.Header().Get("Location") != taskPath(task) {
		t.Fatalf("invalid task location: %s", response.Header().Get("Location"))
	}
	var fields map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 17 {
		t.Fatalf("task DTO fields: %s %v", response.Body, err)
	}
	for _, key := range []string{"id", "projectId", "title", "description", "status", "version", "createdAt", "updatedAt", "dependsOn", "externalDependsOn", "blockedBy", "ready", "properties", "allowAgents", "requiredPlatform"} {
		if _, exists := fields[key]; !exists {
			t.Fatalf("missing task DTO field %s", key)
		}
	}
	read := decodeResponse[api.Task](t, projectRequest(handler, http.MethodGet, taskCollection(strings.ToUpper(project.ID))+"/"+strings.ToUpper(task.ID), ""), http.StatusOK)
	if !reflect.DeepEqual(read, task) {
		t.Fatalf("persisted task differs: %+v %+v", task, read)
	}
	changed := updateHTTPTask(t, handler, task, map[string]any{"title": "Renamed", "description": "Filled"})
	if changed.Title != "Renamed" || changed.Description != "Filled" || changed.Status != "todo" || changed.Version != task.Version+1 || changed.CreatedAt != task.CreatedAt || !changed.UpdatedAt.After(task.UpdatedAt) {
		t.Fatalf("field update: %+v", changed)
	}
	noop := updateHTTPTask(t, handler, changed, map[string]any{"title": changed.Title, "description": changed.Description})
	if !reflect.DeepEqual(noop, changed) {
		t.Fatalf("semantic no-op changed task: %+v %+v", changed, noop)
	}
	cleared := updateHTTPTask(t, handler, noop, map[string]any{"description": "", "dependsOn": []string{}})
	if cleared.Description != "" || cleared.Title != noop.Title || len(cleared.DependsOn) != 0 || cleared.DependsOn == nil || cleared.Version != noop.Version+1 {
		t.Fatalf("clear and omission semantics: %+v", cleared)
	}
	started := setHTTPTask(t, handler, cleared, "in_progress")
	done := setHTTPTask(t, handler, started, "done")
	for _, pair := range [][2]api.Task{{cleared, started}, {started, done}} {
		before, after := pair[0], pair[1]
		if after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("status change did not advance metadata once: %+v %+v", before, after)
		}
		switch after.Status {
		case "in_progress":
			if after.StartedAt == nil || !after.StartedAt.Equal(after.UpdatedAt) || after.CompletedAt != nil {
				t.Fatal("start did not atomically record its start and clear completion")
			}
		case "done":
			if !reflect.DeepEqual(after.StartedAt, before.StartedAt) || after.CompletedAt == nil || !after.CompletedAt.Equal(after.UpdatedAt) ||
				after.StartedAt != nil && after.CompletedAt.Before(*after.StartedAt) {
				t.Fatal("completion did not preserve its start and atomically record its end")
			}
		}
		after.StartedAt, after.CompletedAt = before.StartedAt, before.CompletedAt
		after.Status, after.Version, after.UpdatedAt, after.Ready = before.Status, before.Version, before.UpdatedAt, before.Ready
		if !reflect.DeepEqual(after, before) {
			t.Fatalf("status change changed unrelated content: %+v %+v", before, after)
		}
	}
	if done.Status != "done" || done.Ready || done.Version != started.Version+1 {
		t.Fatalf("status update: %+v", done)
	}
	page = decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, collection, ""), http.StatusOK)
	if len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], done) || page.NextCursor != nil {
		t.Fatalf("persisted task list: %+v", page)
	}
	if !strings.Contains(logs.String(), `"project_id":"`+project.ID+`"`) || !strings.Contains(logs.String(), `"task_id":"`+task.ID+`"`) || !strings.Contains(logs.String(), `"route":"PATCH /api/v1/projects/{projectId}/tasks/{taskId}"`) || strings.Contains(logs.String(), "Filled") || strings.Contains(logs.String(), "Default values") {
		t.Fatalf("unsafe or missing task diagnostics: %s", &logs)
	}
}

func TestTaskHTTPStrictInputsDoNotMutate(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Original")
	for _, body := range []string{
		"", "null", "[]", `{`, `{"title":"x"]`, `{"title":"x"} {}`,
		`{"Title":"x"}`, `{"title":"x","title":"y"}`, `{"title":"x","ti\u0074le":"y"}`,
		`{}`, `{"title":null}`, `{"title": true}`, `{"title":[]}`, `{"title":" "}`, `{"title":"\u0000"}`,
		`{"title":"x","description": null }`, `{"title":"x","description":1}`, `{"title":"x","description":"\u0000"}`,
		`{"title":"x","dependsOn": null }`, `{"title":"x","dependsOn":{}}`, `{"title":"x","dependsOn":"id"}`,
		`{"title":"x","dependsOn":[null]}`, `{"title":"x","dependsOn":[1]}`, `{"title":"x","dependsOn":[{}]}`,
		`{"title":"x","dependsOn":["invalid"]}`, `{"title":"x","status":"todo"}`, `{"title":"x","version":1}`,
		`{"title":"x","projectId":"readonly"}`, `{"title":"x","unknown":"secret-body"}`,
		"{\"title\":\"" + string([]byte{0xff}) + "\"}", `{"title":"` + strings.Repeat("x", maxJSONBody) + `"}`,
	} {
		t.Run("create-"+body[:min(len(body), 70)], func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPost, taskCollection(project.ID), body), http.StatusBadRequest, "invalid_input")
		})
	}
	for _, body := range []string{
		"", "null", `[]`, `{"version":1,}`, `{"version":1,"title":"x"} false`,
		`{}`, `{"title":"x"}`, `{"version":1}`, `{"version":null,"title":"x"}`, `{"version":0,"title":"x"}`,
		`{"version":-1,"title":"x"}`, `{"version":"1","title":"x"}`, `{"version":true,"title":"x"}`,
		`{"version":1.0,"title":"x"}`, `{"version":1e0,"title":"x"}`, `{"version":9223372036854775808,"title":"x"}`,
		`{"version":1,"Title":"x"}`, `{"version":1,"version":1,"title":"x"}`, `{"version":1,"id":"readonly"}`,
		`{"version":1,"title": null }`, `{"version":1,"title":1}`, `{"version":1,"title":" "}`,
		`{"version":1,"description": null }`, `{"version":1,"description":false}`, `{"version":1,"description":"\u0000"}`,
		`{"version":1,"status": null }`, `{"version":1,"status":[]}`, `{"version":1,"status":"blocked"}`,
		`{"version":1,"status":"todo"}`, `{"version":1,"status":"done","title":"Changed"}`,
		`{"version":1,"dependsOn": null }`, `{"version":1,"dependsOn":true}`, `{"version":1,"dependsOn":[null]}`,
		`{"version":1,"dependsOn":["invalid"]}`, `{"version":1,"unknown":"private-body-secret"}`,
	} {
		t.Run("patch-"+body[:min(len(body), 70)], func(t *testing.T) {
			assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), body), http.StatusBadRequest, "invalid_input")
		})
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("rejected update changed persisted state")
	}
	page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID), ""), http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatal("invalid create persisted a task")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), `{"version":9223372036854775807,"title":"x"}`), http.StatusConflict, "version_conflict")
}

func TestTaskHTTPDependencyErrorsAndDerivedFields(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	first := createHTTPTask(t, handler, project.ID, "First")
	second := createHTTPTask(t, handler, project.ID, "Second")
	prerequisites := []string{second.ID, first.ID}
	sorted := slices.Clone(prerequisites)
	slices.Sort(sorted)
	target := createHTTPTask(t, handler, project.ID, "Target", prerequisites...)
	if target.Ready || !slices.Equal(target.DependsOn, sorted) || !slices.Equal(target.BlockedBy, sorted) {
		t.Fatalf("task derived fields are not sorted: %+v", target)
	}
	refuse := func(task api.Task, values map[string]any, code string, ids []string) {
		t.Helper()
		values["version"] = task.Version
		response := projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, values))
		assertProjectError(t, response, http.StatusConflict, code)
		fault := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
		if ids != nil && (fault.Error.Details == nil || !slices.Equal(fault.Error.Details.TaskIDs, ids)) {
			t.Fatalf("incorrect blocker details: %+v want %v", fault, ids)
		}
		if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
			t.Fatal("refused mutation changed task fields, edges, version or time")
		}
	}
	target = updateHTTPTask(t, handler, target, map[string]any{"description": "Additional work can be revised while blocked", "properties": api.TaskWritableProperties{PullRequests: []api.PullRequestProperty{{URL: "https://example.com/pr", Title: "Draft"}}}})
	if target.Status != "todo" || !slices.Equal(target.BlockedBy, sorted) {
		t.Fatalf("blocked todo metadata update: %+v", target)
	}
	response := projectRequest(handler, http.MethodPut, taskPath(target)+"/status", jsonBody(t, api.TaskStatusUpdateRequest{Version: target.Version, Status: "in_progress"}))
	assertProjectError(t, response, http.StatusConflict, "dependency_unsatisfied")
	fault := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
	if fault.Error.Details == nil || !slices.Equal(fault.Error.Details.TaskIDs, sorted) || !reflect.DeepEqual(readHTTPTask(t, handler, target), target) {
		t.Fatalf("refused start lost blockers or mutated task: %+v", fault)
	}
	refuse(first, map[string]any{"dependsOn": []string{target.ID}}, "dependency_cycle", []string{target.ID})
	noop := updateHTTPTask(t, handler, target, map[string]any{"dependsOn": sorted})
	if !reflect.DeepEqual(noop, target) {
		t.Fatal("dependency order changed a semantic no-op")
	}
	first = setHTTPTask(t, handler, first, "in_progress")
	first = setHTTPTask(t, handler, first, "done")
	second = setHTTPTask(t, handler, second, "in_progress")
	second = setHTTPTask(t, handler, second, "done")
	ready := readHTTPTask(t, handler, target)
	if !ready.Ready || len(ready.BlockedBy) != 0 || ready.Version != target.Version || ready.UpdatedAt != target.UpdatedAt {
		t.Fatalf("prerequisite changes altered downstream metadata: %+v", ready)
	}
	started := setHTTPTask(t, handler, ready, "in_progress")
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(started), jsonBody(t, map[string]any{"version": target.Version, "title": started.Title})), http.StatusConflict, "version_conflict")
	cleared := updateHTTPTask(t, handler, started, map[string]any{"dependsOn": []string{}})
	if cleared.DependsOn == nil || len(cleared.DependsOn) != 0 || len(cleared.BlockedBy) != 0 || cleared.Status != "in_progress" {
		t.Fatalf("dependency clearing: %+v", cleared)
	}
	for _, code := range []string{"dependency_unsatisfied", "dependency_cycle", "version_conflict"} {
		if !strings.Contains(logs.String(), `"cause":"`+code+`"`) || !strings.Contains(logs.String(), `"error_code":"`+code+`"`) {
			t.Fatalf("domain refusal is not classified: %s", &logs)
		}
	}
}

func TestTaskHTTPScopesIDsAndMethods(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project, other := taskProject(t, handler), taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "private-title-secret")
	foreign := createHTTPTask(t, handler, other.ID, "foreign-title-secret")
	missing := "00000000-0000-4000-8000-000000000099"
	for _, projectID := range []string{missing, other.ID} {
		for _, method := range []string{http.MethodGet, http.MethodPatch} {
			response := projectRequest(handler, method, taskCollection(projectID)+"/"+task.ID, `{"version":1,"title":"changed"}`)
			assertProjectError(t, response, http.StatusNotFound, "not_found")
			if strings.Contains(response.Body.String(), "secret") {
				t.Fatal("foreign task content exposed")
			}
		}
	}
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		assertProjectError(t, projectRequest(handler, method, taskCollection(missing), `{"title":"valid"}`), http.StatusNotFound, "not_found")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"/"+missing, ""), http.StatusNotFound, "not_found")
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		assertProjectError(t, projectRequest(handler, method, taskCollection("invalid-secret-id"), `{"title":"valid"}`), http.StatusBadRequest, "invalid_input")
	}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		assertProjectError(t, projectRequest(handler, method, taskCollection("invalid-secret-id")+"/"+task.ID, `{"version":1,"title":"valid"}`), http.StatusBadRequest, "invalid_input")
		assertProjectError(t, projectRequest(handler, method, taskCollection(project.ID)+"/invalid-secret-task", `{"version":1,"title":"valid"}`), http.StatusBadRequest, "invalid_input")
	}
	for _, refs := range [][]string{{task.ID, task.ID}, {foreign.ID, missing}} {
		response := projectRequest(handler, http.MethodPost, taskCollection(project.ID), jsonBody(t, map[string]any{"title": "Invalid references", "dependsOn": refs}))
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": task.Version, "dependsOn": []string{task.ID}})), http.StatusBadRequest, "invalid_input")
	for path, allowed := range map[string]string{taskCollection(project.ID): "GET, HEAD, POST", taskPath(task): "GET, HEAD, PATCH"} {
		response := projectRequest(handler, http.MethodDelete, path, "")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != allowed {
			t.Fatalf("wrong Allow header: %s", response.Header().Get("Allow"))
		}
		if response := projectRequest(handler, http.MethodHead, path, ""); response.Code != http.StatusOK {
			t.Fatalf("HEAD is not supported: %d", response.Code)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("raw path or content leaked: %s", &logs)
	}
}

func TestTaskHTTPListFiltersKeysetsAndCursorScopes(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	project, other := taskProject(t, handler), taskProject(t, handler)
	first := createHTTPTask(t, handler, project.ID, "Ready one")
	second := createHTTPTask(t, handler, project.ID, "Ready two")
	blocked := createHTTPTask(t, handler, project.ID, "Blocked", first.ID)
	extraReady := createHTTPTask(t, handler, project.ID, "Additional")
	extraBlocked := createHTTPTask(t, handler, project.ID, "Additional blocked", first.ID)
	active := createHTTPTask(t, handler, project.ID, "Active")
	active = setHTTPTask(t, handler, active, "in_progress")
	done := createHTTPTask(t, handler, project.ID, "Done")
	done = setHTTPTask(t, handler, done, "in_progress")
	done = setHTTPTask(t, handler, done, "done")
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET created_at='2026-01-01T00:00:00Z', updated_at='2026-01-01T00:00:00Z'"); err != nil {
		t.Fatal(err)
	}
	for query, ids := range map[string][]string{
		"status=todo&ready=true": {first.ID, second.ID, extraReady.ID}, "status=todo&ready=false": {blocked.ID, extraBlocked.ID},
		"status=in_progress&ready=false": {active.ID}, "status=done": {done.ID}, "status=done&ready=true": {},
	} {
		slices.Sort(ids)
		page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?"+query, ""), http.StatusOK)
		actual := make([]string, 0, len(page.Items))
		for _, task := range page.Items {
			actual = append(actual, task.ID)
		}
		if !slices.Equal(actual, ids) || page.NextCursor != nil {
			t.Fatalf("AND filter %s: %v want %v", query, actual, ids)
		}
	}
	expected := []string{first.ID, second.ID, extraReady.ID}
	slices.Sort(expected)
	path := taskCollection(project.ID) + "?status=todo&ready=true&limit=1"
	firstPage := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if len(firstPage.Items) != 1 || firstPage.Items[0].ID != expected[0] || firstPage.NextCursor == nil {
		t.Fatalf("first filtered keyset: %+v", firstPage)
	}
	cursor := url.QueryEscape(*firstPage.NextCursor)
	middle := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path+"&cursor="+cursor, ""), http.StatusOK)
	if len(middle.Items) != 1 || middle.Items[0].ID != expected[1] || middle.NextCursor == nil {
		t.Fatalf("middle filtered keyset: %+v", middle)
	}
	final := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path+"&cursor="+url.QueryEscape(*middle.NextCursor), ""), http.StatusOK)
	if len(final.Items) != 1 || final.Items[0].ID != expected[2] || final.NextCursor != nil {
		t.Fatalf("final keyset: %+v", final)
	}
	for _, path := range []string{
		taskCollection(other.ID) + "?status=todo&ready=true&cursor=" + cursor,
		taskCollection(project.ID) + "?status=todo&ready=false&cursor=" + cursor,
		taskCollection(project.ID) + "?status=done&ready=true&cursor=" + cursor,
		taskCollection(project.ID) + "?cursor=" + cursor,
		"/api/v1/projects?cursor=" + cursor,
	} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, path, ""), http.StatusBadRequest, "invalid_input")
	}
	projects := decodeResponse[api.ProjectPage](t, projectRequest(handler, http.MethodGet, "/api/v1/projects?limit=1", ""), http.StatusOK)
	if projects.NextCursor == nil {
		t.Fatal("project cursor was not produced")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?cursor="+url.QueryEscape(*projects.NextCursor), ""), http.StatusBadRequest, "invalid_input")
	for _, query := range []string{"limit=", "limit=0", "limit=101", "limit=x", "limit=1&limit=2", "cursor=", "cursor=invalid", "cursor=x&cursor=y", "status=", "status=blocked", "status=proposed", "status=todo&status=done", "ready=", "ready=1", "ready=TRUE", "ready=yes", "ready=true&ready=false", "unknown=x", "status=%xx", "ready=true;limit=1"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?"+query, ""), http.StatusBadRequest, "invalid_input")
	}
}

func TestTaskHTTPDatabaseFailuresAndCancellation(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "private-task-secret")
	if _, err := database.Pool.Exec(context.Background(), "ALTER TABLE tasks RENAME TO private_table_secret"); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct{ method, path, body string }{
		{http.MethodGet, taskCollection(project.ID), ""}, {http.MethodGet, taskPath(task), ""},
		{http.MethodPost, taskCollection(project.ID), `{"title":"private-body-secret"}`},
		{http.MethodPatch, taskPath(task), `{"version":1,"title":"private-body-secret"}`},
		{http.MethodPut, taskPath(task) + "/status", `{"version":1,"status":"done"}`},
	} {
		response := projectRequest(handler, request.method, request.path, request.body)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "SQL") || strings.Contains(response.Body.String(), "database") {
			t.Fatalf("database internals leaked: %s", response.Body)
		}
	}
	if strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"component":"task"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("unsafe or incorrect database diagnostic: %s", &logs)
	}
	if _, err := database.Pool.Exec(context.Background(), "ALTER TABLE private_table_secret RENAME TO tasks"); err != nil {
		t.Fatal(err)
	}
	transaction, err := database.Pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer transaction.Rollback(context.Background())
	if _, err := transaction.Exec(context.Background(), "SELECT id FROM projects WHERE id=$1 FOR UPDATE", project.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodPatch, taskPath(task), strings.NewReader(`{"version":1,"title":"canceled-update"}`)).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	response, finished := httptest.NewRecorder(), make(chan struct{})
	go func() { handler.ServeHTTP(response, request); close(finished) }()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE pid <> pg_backend_pid() AND application_name=current_setting('application_name')
			AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-finished:
			t.Fatal("task update finished before releasing project lock")
		case <-ctx.Done():
			t.Fatal("task update did not wait for project lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	await(t, finished)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled update wrote response or lost cause: %s %s", response.Body, &logs)
	}
	if !reflect.DeepEqual(readHTTPTask(t, handler, task), task) {
		t.Fatal("canceled lock wait mutated task")
	}
}

func TestTaskHTTPKnownFaultsPreserveOperationalPrecedence(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, err := range []error{
		&service.Fault{Code: "unknown", Message: "unknown-secret"},
		errors.Join(&service.Fault{Code: "not_found", Message: "domain-secret"}, &pgconn.PgError{Message: "driver-secret"}),
		errors.Join(&service.Fault{Code: "not_found", Message: "domain-secret"}, context.Canceled),
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			writeError(w, request, logger, "task", "get", err)
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodPost, "/", nil).WithContext(ctx)
	for _, handler := range []http.HandlerFunc{
		func(w http.ResponseWriter, request *http.Request) {
			writeCreated(w, request, logger, "/unwritten", api.Task{})
		},
		methodNotAllowed(logger, "GET, HEAD"),
	} {
		response := httptest.NewRecorder()
		handler(response, request)
		if len(response.Header()) != 0 || response.Body.Len() != 0 {
			t.Fatalf("canceled response changed headers or body: %+v %s", response.Header(), response.Body)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("unknown fault diagnostics leaked: %s", &logs)
	}
}
