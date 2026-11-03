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
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5/pgconn"
)

func graphPath(projectID, taskID string) string {
	return "/api/v1/projects/" + projectID + "/task-graph?taskId=" + taskID
}

func TestTaskGraphHTTPCompleteProjectionAndSafeLogs(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	root := createHTTPTask(t, handler, project.ID, "root-private-title")
	root = setHTTPTask(t, handler, root, "in_progress")
	root = setHTTPTask(t, handler, root, "done")
	active := createHTTPTask(t, handler, project.ID, "active-private-title", root.ID)
	active = setHTTPTask(t, handler, active, "in_progress")
	ready := createHTTPTask(t, handler, project.ID, strings.Repeat("🙂", 161), root.ID)
	blocked := createHTTPTask(t, handler, project.ID, "blocked-private-title", active.ID, root.ID)
	done := createHTTPTask(t, handler, project.ID, "done-private-title", root.ID)
	done = setHTTPTask(t, handler, done, "in_progress")
	done = setHTTPTask(t, handler, done, "done")
	other := taskProject(t, handler)
	createHTTPTask(t, handler, other.ID, "foreign-private-title")
	response := projectRequest(handler, http.MethodGet, graphPath(strings.ToUpper(project.ID), strings.ToUpper(root.ID)), "")
	graph := decodeResponse[api.TaskGraph](t, response, http.StatusOK)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "project-test" {
		t.Fatalf("unsafe caching or missing request identity: %+v", response.Header())
	}
	if graph.ObservedAt.IsZero() || graph.ObservedAt.Location() != time.UTC || graph.ObservedAt.Before(done.UpdatedAt) || graph.Project != project || graph.Summary != (api.TaskGraphSummary{Total: 5, Todo: 2, InProgress: 1, Done: 2, Ready: 1, Blocked: 1}) || len(graph.Tasks) != 5 {
		t.Fatalf("incorrect complete graph: %+v", graph)
	}
	want := []api.Task{root, active, ready, blocked, done}
	for index, task := range graph.Tasks {
		expected := want[index]
		if task.ID != expected.ID || task.Status != expected.Status || task.Ready != expected.Ready || task.AllowAgents != expected.AllowAgents || !reflect.DeepEqual(task.RequiredPlatform, expected.RequiredPlatform) ||
			!slices.Equal(task.DependsOn, expected.DependsOn) || !slices.Equal(task.ExternalDependsOn, expected.ExternalDependsOn) || !slices.Equal(task.BlockedBy, expected.BlockedBy) ||
			task.DependsOn == nil || task.BlockedBy == nil || task.CreatedAt != expected.CreatedAt || task.UpdatedAt != expected.UpdatedAt ||
			task.CreatedAt.Location() != time.UTC || task.UpdatedAt.Location() != time.UTC ||
			!reflect.DeepEqual(task.StartedAt, expected.StartedAt) || !reflect.DeepEqual(task.CompletedAt, expected.CompletedAt) {
			t.Fatalf("task projection %d differs: %+v want %+v", index, task, expected)
		}
		if task.ID == ready.ID {
			if task.TitlePreview != strings.Repeat("🙂", 160) || !task.TitleTruncated {
				t.Fatalf("Unicode title preview: %+v", task)
			}
		} else if task.TitlePreview != expected.Title || task.TitleTruncated {
			t.Fatalf("short title preview: %+v", task)
		}
	}
	var raw struct {
		Summary map[string]json.RawMessage   `json:"summary"`
		Tasks   []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.Summary) != 6 {
		t.Fatalf("summary must expose exactly six three-state counts: %+v", raw.Summary)
	}
	for _, task := range raw.Tasks {
		if len(task) != 15 {
			t.Fatalf("graph task exposes unexpected fields: %+v", task)
		}
		for _, field := range []string{"title", "description", "version", "projectId"} {
			if _, exists := task[field]; exists {
				t.Fatalf("graph exposes detail field %s", field)
			}
		}
	}
	for _, fragment := range []string{`"component":"task_graph"`, `"project_id":"` + project.ID + `"`, `"node_count":5`, `"edge_count":5`, `"duration":`, `"request_id":"project-test"`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("missing graph diagnostic %s: %s", fragment, &logs)
		}
	}
	for _, secret := range []string{"private-title", "initial description", "github.com", "🙂"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("unsafe graph diagnostic: %s", &logs)
		}
	}
}

func TestTaskGraphHTTPEmptyMissingQueryAndMethods(t *testing.T) {
	var logs bytes.Buffer
	handler := projectTestHandler(t, projectTestStore(t), &logs)
	project := taskProject(t, handler)
	task := createHTTPTask(t, handler, project.ID, "Isolated root")
	response := projectRequest(handler, http.MethodGet, "/api/v1/projects/"+project.ID+"/task-graph", "")
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, task.ID), ""), http.StatusOK)
	if graph.Project != project || graph.Summary != (api.TaskGraphSummary{Total: 1, Todo: 1, Ready: 1}) || len(graph.Tasks) != 1 || graph.Tasks[0].ID != task.ID {
		t.Fatalf("isolated task graph contract: %#v", graph)
	}
	for _, query := range []string{"limit=50", "cursor=token-secret", "status=todo", "ready=true", "unknown=secret", "limit=", "%xx", "x=%xx", ";", "=", "x=1&x=2", "taskId=", "taskId=invalid", "taskId=" + task.ID, "taskId=%xx"} {
		t.Run(query, func(t *testing.T) {
			response := projectRequest(handler, http.MethodGet, graphPath(project.ID, task.ID)+"&"+query, "")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("query error may be cached")
			}
		})
	}
	for _, projectID := range []string{"invalid-private-secret", "00000000-0000-4000-8000-00000000000z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, graphPath(projectID, task.ID), ""), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, graphPath("00000000-0000-4000-8000-000000000099", task.ID), ""), http.StatusNotFound, "not_found")
	for _, taskID := range []string{"invalid", "00000000-0000-4000-8000-00000000000z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, graphPath(project.ID, taskID), ""), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, graphPath(project.ID, "00000000-0000-4000-8000-000000000099"), ""), http.StatusNotFound, "not_found")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, graphPath(project.ID, task.ID), "private-body-secret")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("incorrect graph method headers: %+v", response.Header())
		}
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+graphPath(project.ID, task.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	head, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(head.Body)
	head.Body.Close()
	if readErr != nil || len(body) != 0 || head.StatusCode != http.StatusOK || head.Header.Get("Content-Type") != "application/json" || head.Header.Get("Cache-Control") != "no-store" || head.Header.Get("X-Request-ID") != "project-test" {
		t.Fatalf("HEAD graph response: %+v %s %v", head, body, readErr)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("graph input leaked: %s", &logs)
	}
}

func TestTaskGraphHTTPLimitDetailsAndDomainClassification(t *testing.T) {
	for _, edges := range []bool{false, true} {
		t.Run(map[bool]string{false: "nodes", true: "edges"}[edges], func(t *testing.T) {
			database := projectTestStore(t)
			var logs bytes.Buffer
			handler := projectTestHandler(t, database, &logs)
			project := taskProject(t, handler)
			count := 1001
			if edges {
				count = 102
			}
			if _, err := database.Pool.Exec(context.Background(), `INSERT INTO tasks(id, project_id, title)
				SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(i),12,'0'))::uuid, $1, 'private-limit-title'
				FROM generate_series(1,$2::int) i`, project.ID, count); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_dependencies(project_id, task_id, depends_on_task_id)
    SELECT $1, ('00000000-0000-4000-8000-' || lpad(to_hex(i),12,'0'))::uuid,
     ('00000000-0000-4000-8000-' || lpad(to_hex(i-1),12,'0'))::uuid
    FROM generate_series(2,$2::int) i`, project.ID, count); err != nil {
				t.Fatal(err)
			}
			edgeCount := int64(count - 1)
			if edges {
				if _, err := database.Pool.Exec(context.Background(), `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id)
					SELECT $1, task.id, predecessor.id FROM tasks task JOIN tasks predecessor ON predecessor.id < task.id
     WHERE NOT EXISTS (SELECT 1 FROM task_dependencies d WHERE d.project_id=$1 AND d.task_id=task.id AND d.depends_on_task_id=predecessor.id)
     ORDER BY task.id, predecessor.id LIMIT $2`, project.ID, 5001-(count-1)); err != nil {
					t.Fatal(err)
				}
				edgeCount = 5001
			}
			response := projectRequest(handler, http.MethodGet, graphPath(project.ID, "00000000-0000-4000-8000-000000000001"), "")
			assertProjectError(t, response, http.StatusConflict, "graph_limit_exceeded")
			value := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
			limits := value.Error.Details
			if limits == nil || limits.NodeCount == nil || *limits.NodeCount != int64(count) || limits.EdgeCount == nil || *limits.EdgeCount != edgeCount ||
				limits.MaxNodes == nil || *limits.MaxNodes != 1000 || limits.MaxEdges == nil || *limits.MaxEdges != 5000 ||
				strings.Contains(response.Body.String(), "taskIds") || strings.Contains(response.Body.String(), "private") || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("limit details must contain only exact numeric fields: %s", response.Body)
			}
			if !strings.Contains(logs.String(), `"cause":"graph_limit_exceeded"`) || !strings.Contains(logs.String(), `"error_code":"graph_limit_exceeded"`) ||
				!strings.Contains(logs.String(), `"node_count":`) || !strings.Contains(logs.String(), `"edge_count":`) || strings.Contains(logs.String(), "private") {
				t.Fatalf("limit fault classification or logs: %s", &logs)
			}
		})
	}
}

func TestTaskGraphHTTPDatabaseFailureAndCancellation(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	root := createHTTPTask(t, handler, project.ID, "Cancellation root")
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
	request := httptest.NewRequest(http.MethodGet, graphPath(project.ID, root.ID), nil).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	request.Header.Set("X-Request-ID", "project-test")
	response, finished := httptest.NewRecorder(), make(chan struct{})
	go func() { handler.ServeHTTP(response, request); close(finished) }()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE pid <> pg_backend_pid() AND application_name=current_setting('application_name')
			AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(transaction.Conn().PgConn().PID())).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-finished:
			t.Fatal("graph query completed before cancellation")
		case <-ctx.Done():
			t.Fatal("graph query did not wait for project lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	await(t, finished)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled graph query wrote response or lost cause: %s %s", response.Body, &logs)
	}
	if err := transaction.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(context.Background(), "ALTER TABLE tasks RENAME TO private_sql_secret"); err != nil {
		t.Fatal(err)
	}
	response = projectRequest(handler, http.MethodGet, graphPath(project.ID, root.ID), "")
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "SQL") ||
		strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"cause":"database"`) || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("database graph error leaked or lost cause: %s %s", response.Body, &logs)
	}
}

func TestTaskGraphHTTPErrorPrecedenceAndDTOUTC(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	for _, cause := range []error{&pgconn.PgError{Message: "driver-secret"}, context.Canceled, context.DeadlineExceeded} {
		err := errors.Join(&service.Fault{Code: "graph_limit_exceeded", Message: "domain-secret", GraphLimit: &service.GraphLimitDetails{NodeCount: 1001, MaxNodes: 1000, MaxEdges: 5000}}, cause)
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("X-Request-ID", "project-test")
		RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
			writeError(w, request, logger, "task_graph", "get", err)
		})).ServeHTTP(response, request)
		assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
		value := decodeResponse[api.ErrorResponse](t, response, http.StatusInternalServerError)
		if value.Error.Details != nil {
			t.Fatalf("operational failure exposed domain details: %+v", value)
		}
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("operational graph error leaked: %s", &logs)
	}
	instant := time.Date(2026, 10, 20, 16, 12, 0, 123456000, time.FixedZone("offset", 8*60*60))
	result := taskGraphResponse(core.TaskGraph{Project: core.Project{CreatedAt: instant, UpdatedAt: instant}, ObservedAt: instant,
		Tasks: []core.GraphTask{{ID: "task", CreatedAt: instant, UpdatedAt: instant, StartedAt: &instant, CompletedAt: &instant}}})
	if result.Project.CreatedAt.Location() != time.UTC || result.Project.UpdatedAt.Location() != time.UTC ||
		result.Tasks[0].CreatedAt.Location() != time.UTC || result.Tasks[0].UpdatedAt.Location() != time.UTC ||
		result.ObservedAt.Location() != time.UTC || result.Tasks[0].StartedAt.Location() != time.UTC || result.Tasks[0].CompletedAt.Location() != time.UTC ||
		!result.Tasks[0].CreatedAt.Equal(instant) || !reflect.DeepEqual(result.Tasks[0].DependsOn, []string{}) || !reflect.DeepEqual(result.Tasks[0].BlockedBy, []string{}) {
		t.Fatalf("graph DTO UTC and empty-array conversion: %+v", result)
	}
}

func TestTaskHTTPTodoReadContractWithoutGenericStatusWrites(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	pending := createHTTPTask(t, handler, project.ID, "Pending")
	done := createHTTPTask(t, handler, project.ID, "Done")
	done = setHTTPTask(t, handler, done, "in_progress")
	done = setHTTPTask(t, handler, done, "done")
	ready := createHTTPTask(t, handler, project.ID, "Ready", done.ID)
	ready = updateHTTPTask(t, handler, ready, map[string]any{"description": "Complete ready description"})
	blocked := createHTTPTask(t, handler, project.ID, "Ready with prerequisite", pending.ID)
	for _, original := range []api.Task{ready, blocked} {
		read := readHTTPTask(t, handler, api.Task{ProjectID: project.ID, ID: original.ID})
		if read.Status != "todo" || read.Ready != original.Ready || read.Description != original.Description || read.Version != original.Version ||
			!read.CreatedAt.Equal(original.CreatedAt) || !read.UpdatedAt.Equal(original.UpdatedAt) || !slices.Equal(read.BlockedBy, original.BlockedBy) {
			t.Fatalf("ready GET changed stored projection: %#v", read)
		}
	}
	var listed []string
	path := taskCollection(project.ID) + "?limit=1"
	for {
		page := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
		for _, task := range page.Items {
			listed = append(listed, task.ID)
		}
		if page.NextCursor == nil {
			break
		}
		path = taskCollection(project.ID) + "?limit=1&cursor=" + *page.NextCursor
	}
	if !slices.Equal(listed, []string{pending.ID, done.ID, ready.ID, blocked.ID}) {
		t.Fatalf("HTTP paginated list omitted ready: %#v", listed)
	}
	graph := decodeResponse[api.TaskGraph](t, projectRequest(handler, http.MethodGet, graphPath(project.ID, ready.ID), ""), http.StatusOK)
	if graph.Summary != (api.TaskGraphSummary{Total: 2, Todo: 1, Done: 1, Ready: 1}) ||
		len(graph.Tasks) != 2 || !graph.Tasks[1].Ready || len(graph.Tasks[1].BlockedBy) != 0 {
		t.Fatalf("HTTP ready graph: %#v", graph)
	}
	filtered := decodeResponse[api.TaskPage](t, projectRequest(handler, http.MethodGet, taskCollection(project.ID)+"?status=todo", ""), http.StatusOK)
	if len(filtered.Items) != 3 || filtered.Items[0].ID != pending.ID || filtered.Items[1].ID != ready.ID || filtered.Items[2].ID != blocked.ID {
		t.Fatalf("ready status filter: %+v", filtered)
	}
	assertProjectError(t, projectRequest(handler, http.MethodPatch, taskPath(pending), jsonBody(t, map[string]any{"version": pending.Version, "status": "todo"})), http.StatusBadRequest, "invalid_input")
	if read := readHTTPTask(t, handler, pending); !reflect.DeepEqual(read, pending) {
		t.Fatalf("rejected ready write changed existing task: %#v", read)
	}
}
