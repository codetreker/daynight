package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func TestTaskSyncHTTPProjectionWindowAndSafeLogs(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	a := createHTTPTask(t, handler, project.ID, "private-root-title")
	a = setHTTPTask(t, handler, a, "in_progress")
	a = setHTTPTask(t, handler, a, "done")
	b := createHTTPTask(t, handler, project.ID, strings.Repeat("😀", 161), a.ID)
	b = updateHTTPTask(t, handler, b, map[string]any{"description": "private-description-secret", "requiredPlatform": "linux", "allowAgents": true, "externalDependsOn": []string{a.ID}})
	other := taskProject(t, handler)
	createHTTPTask(t, handler, other.ID, "private-foreign-title")
	if _, err := database.Pool.Exec(context.Background(), "UPDATE tasks SET version=9007199254740993 WHERE id=$1", b.ID); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, syncPath(strings.ToUpper(project.ID)), "")
	result := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	if result.Mode != "snapshot" || result.Epoch == "" || result.Project != project || result.ObservedAt.IsZero() || len(result.Tasks) != 2 || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "project-test" {
		t.Fatalf("sync envelope: %#v headers %#v", result, response.Header())
	}
	for index, original := range []api.Task{a, b} {
		got := result.Tasks[index]
		version := strconv.FormatInt(original.Version, 10)
		if index == 1 {
			version = "9007199254740993"
		}
		if got.ID != original.ID || got.Status != original.Status || got.Version != version || got.CreatedAt != original.CreatedAt || got.UpdatedAt != original.UpdatedAt ||
			!reflect.DeepEqual(got.StartedAt, original.StartedAt) || !reflect.DeepEqual(got.CompletedAt, original.CompletedAt) || !reflect.DeepEqual(got.RequiredPlatform, original.RequiredPlatform) || got.AllowAgents != original.AllowAgents ||
			!slices.Equal(got.DependsOn, original.DependsOn) || !slices.Equal(got.ExternalDependsOn, original.ExternalDependsOn) || got.DependsOn == nil || got.ExternalDependsOn == nil || got.Properties == nil || !reflect.DeepEqual(got.Properties, original.Properties) {
			t.Fatalf("intrinsic task %d: %#v want %#v", index, got, original)
		}
	}
	if result.Tasks[0].RequiredPlatform != nil || result.Tasks[1].TitlePreview != strings.Repeat("😀", 160) || !result.Tasks[1].TitleTruncated {
		t.Fatalf("nullable platform/preview: %#v", result.Tasks)
	}
	var raw struct {
		Tasks []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, task := range raw.Tasks {
		if len(task) != 14 {
			t.Fatalf("unexpected summary fields: %#v", task)
		}
		for _, field := range []string{"description", "blockedBy", "ready"} {
			if _, exists := task[field]; exists {
				t.Fatalf("summary exposes %s", field)
			}
		}
	}
	for _, input := range []string{"?epoch=" + result.Epoch, "?epoch=00000000-0000-4000-8000-000000000099&since=9999-12-31T23:59:59.999999999Z"} {
		got := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID)+input, ""), http.StatusOK)
		if len(got.Tasks) != 2 {
			t.Fatalf("baseline incomplete: %#v", got)
		}
	}
	query := "?epoch=" + result.Epoch + "&since=" + url.QueryEscape(b.UpdatedAt.Add(11*time.Second).Format(time.RFC3339Nano))
	delta := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID)+query, ""), http.StatusOK)
	if delta.Mode != "delta" || delta.Tasks == nil || len(delta.Tasks) != 0 {
		t.Fatalf("window ignored: %#v", delta)
	}
	if strings.Contains(logs.String(), "private-") || strings.Contains(logs.String(), "secret") || !strings.Contains(logs.String(), `"component":"task_sync"`) || !strings.Contains(logs.String(), `"phase":"get"`) || !strings.Contains(logs.String(), `"returned_tasks":2`) || !strings.Contains(logs.String(), `"window":10000000000`) || !strings.Contains(logs.String(), `"since":`) {
		t.Fatalf("sync logs unsafe or incomplete: %s", &logs)
	}
}

func TestTaskSyncHTTPValidationMethodsAndIdentity(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	base := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	if base.Tasks == nil || len(base.Tasks) != 0 {
		t.Fatalf("empty tasks: %#v", base)
	}
	for _, query := range []string{
		"epoch=", "since=", "since=2026-10-24T00:00:00Z", "epoch=invalid-private-secret", "epoch=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
		"epoch=" + base.Epoch + "&epoch=" + base.Epoch, "epoch=" + base.Epoch + "&since=2026-10-24T00:00:00Z&since=2026-10-24T00:00:00Z",
		"status=todo", "limit=50", "cursor=secret", "overlap=1s", "unknown=secret", "%xx", "x=%xx", ";", "=",
	} {
		t.Run(query, func(t *testing.T) {
			response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?"+query, "")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("validation cacheable")
			}
		})
	}
	for _, stamp := range []string{"2026-10-24", "2026-10-24T00:00:00+00:00", "2026-10-24t00:00:00Z", "2026-10-24T00:00:00z", "2026-10-24T0:00:00Z", "2026-10-24T00:00:00.Z", "2026-10-24T00:00:00,1Z", "2026-10-24T00:00:00.1234567890Z", "2026-02-30T00:00:00Z", "2026-10-24T24:00:00Z", "2026-10-24T00:00:60Z"} {
		response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+base.Epoch+"&since="+url.QueryEscape(stamp), "")
		assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	for _, stamp := range []string{"2026-10-24T00:00:00Z", "2026-10-24T00:00:00.1Z", "2026-10-24T00:00:00.123456789Z"} {
		decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+base.Epoch+"&since="+stamp, ""), http.StatusOK)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath("invalid"), ""), http.StatusBadRequest, "invalid_input")
	assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath("00000000-0000-4000-8000-000000000099"), ""), http.StatusNotFound, "not_found")
	request := httptest.NewRequest(http.MethodGet, syncPath(project.ID), nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, syncPath(project.ID), "private-body-secret")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("allow: %#v", response.Header())
		}
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	request, err := http.NewRequest(http.MethodHead, server.URL+syncPath(project.ID), nil)
	if err != nil {
		t.Fatal(err)
	}
	authorizeResourceRequest(handler, request)
	head, err := server.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(head.Body)
	head.Body.Close()
	if readErr != nil || len(body) != 0 || head.StatusCode != http.StatusOK || head.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("HEAD: %#v %s %v", head, body, readErr)
	}
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("validation input logged: %s", &logs)
	}
}

func TestTaskSyncHTTPFullLimitAndDatabaseError(t *testing.T) {
	database := projectTestStore(t)
	var logs bytes.Buffer
	handler := projectTestHandler(t, database, &logs)
	project := taskProject(t, handler)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusOK)
	if _, err := database.Pool.Exec(context.Background(), `INSERT INTO tasks(id,project_id,title) SELECT md5($1::text || ':' || n)::uuid,$1::uuid,'private-limit-title' FROM generate_series(1,1001) n`, project.ID); err != nil {
		t.Fatal(err)
	}
	response := projectRequest(handler, http.MethodGet, syncPath(project.ID)+"?epoch="+baseline.Epoch+"&since=9999-12-31T23:59:59Z", "")
	value := decodeResponse[api.ErrorResponse](t, response, http.StatusConflict)
	if value.Error.Code != "graph_limit_exceeded" || value.Error.Details == nil || value.Error.Details.NodeCount == nil || *value.Error.Details.NodeCount != 1001 {
		t.Fatalf("capacity: %s", response.Body)
	}
	if _, err := database.Pool.Exec(context.Background(), "DROP TABLE tasks"); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath(project.ID), ""), http.StatusInternalServerError, "internal_error")
	if strings.Contains(logs.String(), "private") {
		t.Fatalf("database diagnostics leaked: %s", &logs)
	}
}

func TestTaskSyncDTOUTCAndExactVersion(t *testing.T) {
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456789, time.FixedZone("offset", 8*60*60))
	got := taskSyncResponse(core.TaskSync{ObservedAt: stamp, Project: core.Project{CreatedAt: stamp, UpdatedAt: stamp}, Tasks: []core.TaskViewRecord{{Version: 9223372036854775807, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp}}})
	if got.Tasks[0].Version != "9223372036854775807" || got.ObservedAt.Location() != time.UTC || got.Project.CreatedAt.Location() != time.UTC || got.Tasks[0].CreatedAt.Location() != time.UTC || got.Tasks[0].UpdatedAt.Location() != time.UTC || got.Tasks[0].StartedAt.Location() != time.UTC || got.Tasks[0].CompletedAt.Location() != time.UTC || got.Tasks[0].DependsOn == nil || got.Tasks[0].ExternalDependsOn == nil || got.Tasks[0].Properties == nil || len(got.Tasks[0].Properties) != 0 {
		t.Fatalf("DTO conversion: %#v", got)
	}
}

func TestTaskSyncHTTPAuthenticationAndProjectMembership(t *testing.T) {
	h := membershipTestHarness(t)
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	logger := testLogger()
	taskSyncRoutes(mux, service.NewTaskSync(h.database, 10*time.Second), h.auth, logger, 10*time.Second)
	h.handler = RequestLogging(logger, mux)
	path := syncPath(h.project.ID)
	assertProjectError(t, h.call(http.MethodGet, path, "", nil), http.StatusUnauthorized, "unauthenticated")
	assertProjectError(t, h.call(http.MethodGet, path, "", h.outsider), http.StatusNotFound, "not_found")
	result := decodeResponse[api.TaskSync](t, h.call(http.MethodGet, path, "", h.admin), http.StatusOK)
	if result.Project.ID != h.project.ID || result.Tasks == nil {
		t.Fatalf("authorized project snapshot: %#v", result)
	}
}
