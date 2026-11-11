package task_test

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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func syncModel() model.TaskSync {
	stamp := testTime.Add(time.Hour)
	return model.TaskSync{Mode: "snapshot", Epoch: testEpoch, Project: testProject(), ActorAccess: model.ProjectAccess{Role: model.ProjectAdmin}, ObservedAt: stamp,
		Tasks: []model.TaskViewRecord{}, AssigneeVersions: []model.TaskAssigneeVersion{}, Sessions: map[string]model.SessionListState{}}
}

func TestTaskSyncHTTPProjectionWindowAndSafeLogs(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	stamp := testTime.Add(time.Hour)
	platform := model.TaskPlatform("linux")
	parent := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	result := syncModel()
	result.Tasks = []model.TaskViewRecord{
		{ID: testTaskID, Type: model.TaskTypeTask, ParentID: &parent, TitlePreview: "private-root-title", Status: model.TaskDone, Version: 3, Properties: model.TaskProperties{}, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp},
		{ID: "55555555-5555-4555-8555-555555555555", Type: model.TaskTypeTask, TitlePreview: strings.Repeat("😀", 160), TitleTruncated: true, Status: model.TaskTodo, Version: 9007199254740993, Properties: model.TaskProperties{}, DependsOn: []string{testTaskID}, ExternalDependsOn: []string{testTaskID}, RequiredPlatform: &platform, AllowAgents: true, CreatedAt: stamp, UpdatedAt: stamp},
	}
	calls := 0
	handler.ExpectCalls("Sync", 4)
	expected := taskservice.TaskSyncRequest{}
	handler.Sync = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
		calls++
		if principal != handler.principal || projectID != testProjectID || !reflect.DeepEqual(input, expected) || ctx.Err() != nil {
			t.Fatalf("sync arguments: principal=%+v project=%q input=%+v", principal, projectID, input)
		}
		return result, nil
	}
	response := projectRequest(handler, http.MethodGet, syncPath(strings.ToUpper(testProjectID)), "")
	got := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	if got.Mode != result.Mode || got.Epoch != result.Epoch || got.ObservedAt != result.ObservedAt || got.Project.ID != result.Project.ID || got.Project.Name != result.Project.Name || got.Project.RepoURL != result.Project.RepoURL || got.Project.CreatedAt != result.Project.CreatedAt || got.Project.UpdatedAt != result.Project.UpdatedAt || len(got.Tasks) != len(result.Tasks) || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("X-Request-ID") != "project-test" {
		t.Fatalf("sync response=%+v headers=%+v", got, response.Header())
	}
	for i, value := range result.Tasks {
		item := got.Tasks[i]
		if item.ID != value.ID || item.Type != value.Type || !reflect.DeepEqual(item.ParentID, value.ParentID) || item.Status != string(value.Status) || item.Version != strconv.FormatInt(value.Version, 10) || item.TitlePreview != value.TitlePreview || item.TitleTruncated != value.TitleTruncated || item.AllowAgents != value.AllowAgents || item.CreatedAt != value.CreatedAt || item.UpdatedAt != value.UpdatedAt || !reflect.DeepEqual(item.StartedAt, value.StartedAt) || !reflect.DeepEqual(item.CompletedAt, value.CompletedAt) || !reflect.DeepEqual(item.CancelledAt, value.CancelledAt) || !slices.Equal(item.DependsOn, value.DependsOn) || !slices.Equal(item.ExternalDependsOn, value.ExternalDependsOn) || item.DependsOn == nil || item.ExternalDependsOn == nil || !reflect.DeepEqual(item.Properties, api.TaskProperties(value.Properties)) {
			t.Fatalf("intrinsic projection %d=%+v want=%+v", i, item, value)
		}
	}
	if got.Tasks[1].Version != "9007199254740993" || got.Tasks[1].TitlePreview != strings.Repeat("😀", 160) || !got.Tasks[1].TitleTruncated || got.Tasks[0].RequiredPlatform != nil {
		t.Fatalf("exact projection: %+v", got.Tasks)
	}
	var raw struct {
		Tasks []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	for _, item := range raw.Tasks {
		if len(item) != 18 {
			t.Fatalf("unexpected summary fields: %+v", item)
		}
		for _, field := range []string{"description", "blockedBy", "ready"} {
			if _, exists := item[field]; exists {
				t.Fatalf("summary exposes %s", field)
			}
		}
	}
	if string(raw.Tasks[0]["type"]) != `"task"` || string(raw.Tasks[0]["parentId"]) != `"`+parent+`"` || string(raw.Tasks[1]["parentId"]) != "null" {
		t.Fatalf("typed sync fields: %+v %+v", raw.Tasks[0], raw.Tasks[1])
	}
	expected = taskservice.TaskSyncRequest{Epoch: result.Epoch}
	decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?epoch="+result.Epoch, ""), http.StatusOK)
	future := time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	expected = taskservice.TaskSyncRequest{Epoch: "00000000-0000-4000-8000-000000000099", Since: &future}
	baseline := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?epoch="+expected.Epoch+"&since="+url.QueryEscape(future.Format(time.RFC3339Nano)), ""), http.StatusOK)
	if baseline.Mode != "snapshot" || len(baseline.Tasks) != 2 {
		t.Fatalf("unknown-epoch baseline projection=%+v", baseline)
	}
	since := stamp.Add(11 * time.Second)
	expected = taskservice.TaskSyncRequest{Epoch: testEpoch, Since: &since}
	result.Mode, result.Tasks = "delta", []model.TaskViewRecord{}
	delta := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?epoch="+testEpoch+"&since="+url.QueryEscape(since.Format(time.RFC3339Nano)), ""), http.StatusOK)
	if delta.Mode != "delta" || delta.Tasks == nil || len(delta.Tasks) != 0 || calls != 4 {
		t.Fatalf("delta=%+v calls=%d", delta, calls)
	}
	for _, fragment := range []string{`"component":"task_sync"`, `"phase":"get"`, `"returned_tasks":2`, `"window":10000000000`, `"since":`} {
		if !strings.Contains(logs.String(), fragment) {
			t.Fatalf("missing %s: %s", fragment, &logs)
		}
	}
	if strings.Contains(logs.String(), "private-") || strings.Contains(logs.String(), "😀") {
		t.Fatalf("sync values leaked: %s", &logs)
	}
}

func TestTaskSyncHTTPValidationMethodsAndIdentity(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	for _, query := range []string{
		"epoch=", "since=", "since=2026-10-24T00:00:00Z", "epoch=invalid-private-secret", "epoch=AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
		"epoch=" + testEpoch + "&epoch=" + testEpoch, "epoch=" + testEpoch + "&since=2026-10-24T00:00:00Z&since=2026-10-24T00:00:00Z",
		"status=todo", "limit=50", "cursor=secret", "overlap=1s", "unknown=secret", "%xx", "x=%xx", ";", "=",
	} {
		t.Run(query, func(t *testing.T) {
			response := projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?"+query, "")
			assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("validation cacheable")
			}
		})
	}
	for _, stamp := range []string{"2026-10-24", "2026-10-24T00:00:00+00:00", "2026-10-24t00:00:00Z", "2026-10-24T00:00:00z", "2026-10-24T0:00:00Z", "2026-10-24T00:00:00.Z", "2026-10-24T00:00:00,1Z", "2026-10-24T00:00:00.1234567890Z", "2026-02-30T00:00:00Z", "2026-10-24T24:00:00Z", "2026-10-24T00:00:60Z"} {
		assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?epoch="+testEpoch+"&since="+url.QueryEscape(stamp), ""), http.StatusBadRequest, "invalid_input")
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath("invalid"), ""), http.StatusBadRequest, "invalid_input")
	request := httptest.NewRequest(http.MethodGet, syncPath(testProjectID), nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		response := projectRequest(handler, method, syncPath(testProjectID), "private-body-secret")
		assertProjectError(t, response, http.StatusMethodNotAllowed, "method_not_allowed")
		if response.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("allow=%v", response.Header())
		}
	}
	if handler.TotalCalls() != 0 {
		t.Fatalf("protocol rejection reached sync: %d calls", handler.TotalCalls())
	}
	calls := 0
	handler.ExpectCalls("Sync", 6)
	handler.Sync = func(ctx context.Context, principal model.Principal, projectID string, input taskservice.TaskSyncRequest) (model.TaskSync, error) {
		calls++
		if principal != handler.principal || projectID != testProjectID {
			t.Fatalf("sync identity=%+v project=%s", principal, projectID)
		}
		return syncModel(), nil
	}
	empty := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID), ""), http.StatusOK)
	if empty.Tasks == nil || len(empty.Tasks) != 0 || empty.Sessions == nil || len(empty.Sessions) != 0 {
		t.Fatalf("empty=%+v", empty)
	}
	for _, stamp := range []string{"2026-10-24T00:00:00Z", "2026-10-24T00:00:00.1Z", "2026-10-24T00:00:00.123456789Z"} {
		decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, syncPath(testProjectID)+"?epoch="+testEpoch+"&since="+stamp, ""), http.StatusOK)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	request, err := http.NewRequest(http.MethodHead, server.URL+syncPath(testProjectID), nil)
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
	if readErr != nil || len(body) != 0 || head.StatusCode != http.StatusOK || head.Header.Get("Cache-Control") != "no-store" || calls != 5 {
		t.Fatalf("HEAD=%+v body=%q err=%v calls=%d", head, body, readErr, calls)
	}
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return model.TaskSync{}, &model.Fault{Code: "not_found", Message: "Project not found."}
	}
	assertProjectError(t, projectRequest(handler, http.MethodGet, syncPath("00000000-0000-4000-8000-000000000099"), ""), http.StatusNotFound, "not_found")
	if strings.Contains(logs.String(), "secret") {
		t.Fatalf("validation input leaked: %s", &logs)
	}
}

func TestTaskSyncHTTPDatabaseFailureDoesNotSendPartialTasks(t *testing.T) {
	handler := newHTTPFixture(t, io.Discard)
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return model.TaskSync{}, &store.Error{Phase: "query", DatabaseFailure: true, Cause: io.ErrUnexpectedEOF}
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if strings.Contains(response.Body.String(), `"tasks"`) {
		t.Fatalf("partial tasks=%s", response.Body)
	}
}

func TestTaskSyncDTOUTCAndExactVersion(t *testing.T) {
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456789, time.FixedZone("offset", 8*60*60))
	got := taskhttp.TaskSyncResponse(model.TaskSync{ObservedAt: stamp, Project: model.Project{CreatedAt: stamp, UpdatedAt: stamp}, ActorAccess: model.ProjectAccess{Role: model.ProjectAdmin, DirectGrant: &model.ProjectGrant{Version: 9223372036854775807, CreatedAt: stamp, UpdatedAt: stamp}}, Tasks: []model.TaskViewRecord{{Version: 9223372036854775807, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp}}})
	if got.Tasks[0].Version != "9223372036854775807" || got.ObservedAt.Location() != time.UTC || got.Project.CreatedAt.Location() != time.UTC || got.Tasks[0].CreatedAt.Location() != time.UTC || got.Tasks[0].UpdatedAt.Location() != time.UTC || got.Tasks[0].StartedAt.Location() != time.UTC || got.Tasks[0].CompletedAt.Location() != time.UTC || got.Tasks[0].DependsOn == nil || got.Tasks[0].ExternalDependsOn == nil || got.Tasks[0].Properties == nil || len(got.Tasks[0].Properties) != 0 {
		t.Fatalf("DTO conversion: %#v", got)
	}
	if got.ActorAccess.EffectiveRole != "admin" || got.ActorAccess.DirectGrant == nil || got.ActorAccess.DirectGrant.Version != 9223372036854775807 || got.ActorAccess.DirectGrant.CreatedAt.Location() != time.UTC || got.ActorAccess.DirectGrant.UpdatedAt.Location() != time.UTC {
		t.Fatalf("actor grant DTO conversion: %#v", got.ActorAccess)
	}
}
