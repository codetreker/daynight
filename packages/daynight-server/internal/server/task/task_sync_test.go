package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
		{ID: testTaskID, Type: model.TaskTypeTask, ParentID: &parent, TitlePreview: "private-root-title", Status: model.TaskDone, Version: 3, Properties: model.TaskProperties{}, Tags: []model.TagReference{{ID: "tag-id", Name: "<&标签"}}, CreatedAt: stamp, UpdatedAt: stamp, StartedAt: &stamp, CompletedAt: &stamp},
		{ID: "55555555-5555-4555-8555-555555555555", Type: model.TaskTypeTask, TitlePreview: strings.Repeat("😀", 160), TitleTruncated: true, Status: model.TaskTodo, Version: 9007199254740993, Properties: model.TaskProperties{}, DependsOn: []string{testTaskID}, ExternalDependsOn: []string{testTaskID}, RequiredPlatform: &platform, AllowAgents: true, CreatedAt: stamp, UpdatedAt: stamp},
	}
	result.DependencyStates = map[string]model.TaskDependencyState{
		testTaskID:         {TaskVersion: 3, BlockedBy: nil, Ready: false},
		result.Tasks[1].ID: {TaskVersion: 9007199254740993, BlockedBy: []string{testTaskID}, Ready: false},
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
	if got.DependencyStates[testTaskID].BlockedBy == nil || got.DependencyStates[result.Tasks[1].ID].TaskVersion != "9007199254740993" || !slices.Equal(got.DependencyStates[result.Tasks[1].ID].BlockedBy, []string{testTaskID}) {
		t.Fatalf("dependency projection=%+v", got.DependencyStates)
	}
	var raw struct {
		Tasks            []map[string]json.RawMessage          `json:"tasks"`
		DependencyStates map[string]map[string]json.RawMessage `json:"dependencyStates"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw.DependencyStates) != 2 {
		t.Fatalf("dependency states: %+v", raw.DependencyStates)
	}
	for _, state := range raw.DependencyStates {
		if len(state) != 3 || state["taskVersion"] == nil || state["blockedBy"] == nil || state["ready"] == nil {
			t.Fatalf("unexpected dependency fields: %+v", state)
		}
	}
	for _, item := range raw.Tasks {
		if len(item) != 19 {
			t.Fatalf("unexpected summary fields: %+v", item)
		}
		for _, field := range []string{"description", "blockedBy", "ready"} {
			if _, exists := item[field]; exists {
				t.Fatalf("summary exposes %s", field)
			}
		}
	}
	if string(raw.Tasks[0]["tags"]) != `[{"id":"tag-id","name":"\u003c\u0026标签"}]` || string(raw.Tasks[1]["tags"]) != `[]` {
		t.Fatalf("sync tags: %s %s", raw.Tasks[0]["tags"], raw.Tasks[1]["tags"])
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

func TestTaskSyncHTTPDependencyStateResponseSize(t *testing.T) {
	handler := newHTTPFixture(t, io.Discard)
	result := syncModel()
	handler.ExpectCalls("Sync", 2)
	handler.Sync = func(context.Context, model.Principal, string, taskservice.TaskSyncRequest) (model.TaskSync, error) {
		return result, nil
	}
	empty := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	result.DependencyStates = make(map[string]model.TaskDependencyState)
	for i := 0; i < 128; i++ {
		id := fmt.Sprintf("%08x-0000-4000-8000-000000000000", i)
		result.DependencyStates[id] = model.TaskDependencyState{TaskVersion: 9007199254740993, BlockedBy: []string{testTaskID}}
	}
	response := projectRequest(handler, http.MethodGet, syncPath(testProjectID), "")
	got := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	encoded, err := json.Marshal(got.DependencyStates)
	if err != nil || len(got.DependencyStates) != 128 || response.Body.Len()-empty.Body.Len() != len(encoded)-2 {
		t.Fatalf("size or completeness: response=%d empty=%d states=%d encoded=%d err=%v", response.Body.Len(), empty.Body.Len(), len(got.DependencyStates), len(encoded), err)
	}
	t.Logf("128 dependency states add %d bytes to the HTTP response", len(encoded)-2)
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
	if empty.Tasks == nil || len(empty.Tasks) != 0 || empty.DependencyStates == nil || len(empty.DependencyStates) != 0 || empty.Sessions == nil || len(empty.Sessions) != 0 {
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

func TestTaskSyncHTTPCancellationPropagates(t *testing.T) {
	var logs bytes.Buffer
	handler := newHTTPFixture(t, &logs)
	started, finished, served := make(chan struct{}), make(chan struct{}), make(chan struct{})
	handler.ExpectCalls("Sync", 1)
	handler.Sync = func(ctx context.Context, _ model.Principal, _ string, _ taskservice.TaskSyncRequest) (model.TaskSync, error) {
		close(started)
		<-ctx.Done()
		close(finished)
		return model.TaskSync{}, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, syncPath(testProjectID), nil).WithContext(ctx)
	authorizeResourceRequest(handler, request)
	response := httptest.NewRecorder()
	go func() { handler.ServeHTTP(response, request); close(served) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("sync did not start")
	}
	cancel()
	await(t, finished)
	await(t, served)
	if response.Body.Len() != 0 || !strings.Contains(logs.String(), `"cause":"canceled"`) {
		t.Fatalf("canceled response=%s logs=%s", response.Body, &logs)
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

func TestTaskSyncHTTPAuthenticationAndProjectMembership(t *testing.T) {
	project, _, admin := taskHTTPMockModels()
	path := syncPath(project.ID)
	unauthenticatedStore := newHTTPTestStore(t)
	unauthenticated := taskComponentHandler(t, unauthenticatedStore, io.Discard, admin)
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	unauthenticated.ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")

	outsider := admin
	outsider.UserID = "aaaaaa77-7777-4777-8777-777777777777"
	outsider.CredentialID = "bbbbbb88-8888-4888-8888-888888888888"
	outsiderStore := newHTTPTestStoreForPrincipal(t, outsider)
	outsiderPlan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1})
	outsiderReader := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "outside project")}
	outsiderReader.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		outsiderPlan.Called("access")
		if actor != outsider || id != project.ID {
			t.Fatalf("outsider access: %#v %s", actor, id)
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	outsiderSnapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "outside snapshot"), ProjectDAOFn: func() store.ProjectReader { return outsiderReader }}
	outsiderStore.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		outsiderPlan.Called("snapshot")
		return read(outsiderSnapshot)
	}
	outsideHandler := taskComponentHandler(t, outsiderStore, io.Discard, outsider)
	assertProjectError(t, projectRequest(outsideHandler, http.MethodGet, path, ""), http.StatusNotFound, "not_found")

	database := newHTTPTestStore(t)
	plan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1, "project": 1, "epoch": 1, "tasks": 1, "dependencies": 1, "assignees": 1, "observed": 1, "sessions": 1})
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync project")}
	projects.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		plan.Called("access")
		if actor != admin || id != project.ID {
			t.Fatalf("admin access: %#v %s", actor, id)
		}
		return taskHTTPMockAccess(project, admin), nil
	}
	projects.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
		plan.Called("project")
		if id != project.ID {
			t.Fatalf("project ID = %s", id)
		}
		return project, nil
	}
	tasks := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync task")}
	requireProject := func(id string) {
		t.Helper()
		if id != project.ID {
			t.Fatalf("sync project ID = %s", id)
		}
	}
	tasks.TaskCacheEpochFn = func(ctx context.Context, id string) (string, error) {
		plan.Called("epoch")
		requireProject(id)
		return "cccccc99-9999-4999-8999-999999999999", nil
	}
	tasks.TaskSyncTasksFn = func(ctx context.Context, id string, lower *time.Time, preview int) ([]model.TaskViewRecord, error) {
		plan.Called("tasks")
		requireProject(id)
		if lower != nil || preview != 160 {
			t.Fatalf("snapshot query = %#v/%d", lower, preview)
		}
		return []model.TaskViewRecord{}, nil
	}
	tasks.TaskSyncDependencyStatesFn = func(ctx context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
		plan.Called("dependencies")
		requireProject(id)
		if lower != nil {
			t.Fatalf("snapshot dependency lower = %#v", lower)
		}
		return map[string]model.TaskDependencyState{}, nil
	}
	tasks.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
		plan.Called("assignees")
		requireProject(id)
		return []model.TaskAssigneeFact{}, nil
	}
	sessions := &taskHTTPSessionReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync sessions")}
	sessions.CurrentTaskSessionSourcesFn = func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
		plan.Called("sessions")
		requireProject(id)
		return []store.TaskSessionSource{}, nil
	}
	snapshot := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "sync snapshot"),
		ProjectDAOFn: func() store.ProjectReader { return projects }, TaskDAOFn: func() store.TaskReader { return tasks }, SessionDAOFn: func() store.SessionReader { return sessions },
		ObservedAtFn: func(context.Context) (time.Time, error) { plan.Called("observed"); return project.UpdatedAt, nil },
	}
	database.ReadSnapshotCall = func(ctx context.Context, read func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		return read(snapshot)
	}
	handler := taskComponentHandler(t, database, io.Discard, admin)
	result := decodeResponse[api.TaskSync](t, projectRequest(handler, http.MethodGet, path, ""), http.StatusOK)
	if result.Project.ID != project.ID || result.Tasks == nil {
		t.Fatalf("authorized project snapshot: %#v", result)
	}
}

func TestTaskSyncHTTPAssigneeManifestContainsOnlyVersionsAndAccess(t *testing.T) {
	f := newTaskHTTPFixture(t)
	member := "c6666666-6666-4666-8666-666666666666"
	name := "Private profile name"
	avatar := "data:image/svg+xml;base64," + strings.Repeat("a", 235_600)
	facts := []model.TaskAssigneeFact{
		{UserID: f.principal.UserID, ProfileID: &f.principal.UserID, HasProjectAccess: true, Qualified: true},
		{UserID: member, ProfileID: &member, Name: &name, AvatarURL: &avatar, HasProjectAccess: true, Qualified: true},
	}
	f.expectSync([]model.TaskViewRecord{}, map[string]model.TaskDependencyState{}, facts, nil)
	response := projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), "")
	snapshot := decodeResponse[api.TaskSync](t, response, http.StatusOK)
	if snapshot.AssigneeVersions == nil || len(snapshot.AssigneeVersions) != 2 || snapshot.Tasks == nil || len(snapshot.Tasks) != 0 {
		t.Fatalf("manifest excluded members without Tasks: %#v", snapshot)
	}
	if strings.Contains(response.Body.String(), avatar) || strings.Contains(response.Body.String(), name) {
		t.Fatal("TaskSync transferred profile content")
	}
	var wire struct {
		AssigneeVersions []map[string]json.RawMessage `json:"assigneeVersions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	f.expectSnapshot(map[string]int{"people": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, p *httpCallPlan) {
		declared := copyTaskHTTPAssigneeFacts(facts)
		reader.TaskAssigneesFn = func(ctx context.Context, project string) ([]model.TaskAssigneeFact, error) {
			f.require(ctx, project)
			p.Called("people")
			return copyTaskHTTPAssigneeFacts(declared), nil
		}
	})
	people := decodeAssigneeHTTPResult(t, projectRequest(f.handler, http.MethodGet, taskAssigneesPath(f.project.ID), ""), f.principal.UserID)
	for index, entry := range wire.AssigneeVersions {
		if len(entry) != 3 || entry["userId"] == nil || entry["version"] == nil || entry["hasProjectAccess"] == nil {
			t.Fatalf("manifest fields: %#v", entry)
		}
		person := people.Items[index]
		if snapshot.AssigneeVersions[index] != (api.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess}) {
			t.Fatalf("manifest/current people differ: %#v %#v", snapshot.AssigneeVersions[index], person)
		}
	}
	since := time.Date(9999, time.December, 31, 23, 59, 59, 0, time.UTC)
	lower := since.Add(-10 * time.Second)
	f.expectSync([]model.TaskViewRecord{}, map[string]model.TaskDependencyState{}, facts, &lower)
	delta := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+"?epoch="+snapshot.Epoch+"&since=9999-12-31T23:59:59Z", ""), http.StatusOK)
	if delta.Mode != "delta" || len(delta.Tasks) != 0 || !reflect.DeepEqual(delta.AssigneeVersions, snapshot.AssigneeVersions) {
		t.Fatalf("empty delta manifest: %#v", delta)
	}
}

func workerHTTPSummary(task model.Task) model.TaskViewRecord {
	return model.TaskViewRecord{ID: task.ID, TitlePreview: task.Title, Status: task.Status, Version: task.Version,
		Properties: task.Properties, DependsOn: task.DependsOn, ExternalDependsOn: task.ExternalDependsOn,
		RequiredPlatform: task.RequiredPlatform, AssignedTo: task.AssignedTo, AllowAgents: task.AllowAgents,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt}
}

func TestWorkerHTTPChangesAppearInTaskSync(t *testing.T) {
	f := newTaskHTTPFixture(t)
	current := componentWorkerHTTPTask(t)
	path := taskCollection(current.ProjectID) + "/" + current.ID
	f.expectSync([]model.TaskViewRecord{workerHTTPSummary(current)}, map[string]model.TaskDependencyState{}, []model.TaskAssigneeFact{}, nil)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), ""), http.StatusOK)
	epoch, observed := baseline.Epoch, baseline.ObservedAt
	if epoch != taskHTTPEpoch || !observed.Equal(f.observed) {
		t.Fatal("baseline summary changed its declared observation")
	}
	assertSummary := func(full api.Task, expected model.Task) {
		t.Helper()
		expected = copyTaskHTTPTask(expected)
		f.expectSnapshot(map[string]int{"task": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
			reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
				f.require(ctx, projectID)
				plan.Called("task")
				if id != expected.ID {
					t.Fatal("property read changed Task identity")
				}
				return copyTaskHTTPTask(expected), nil
			}
		})
		properties := propertyResource(t, f.handler, http.MethodGet, path+"/properties", nil)
		if properties.Version != full.Version || !reflect.DeepEqual(properties.Properties, map[string]json.RawMessage(expected.Properties)) {
			t.Fatal("worker property resource advanced or changed canonical values")
		}
		query := "?epoch=" + epoch + "&since=" + url.QueryEscape(observed.Format(time.RFC3339Nano))
		lower := observed.Add(-10 * time.Second)
		f.observed = f.observed.Add(time.Second)
		f.expectSync([]model.TaskViewRecord{workerHTTPSummary(expected)}, map[string]model.TaskDependencyState{}, []model.TaskAssigneeFact{}, &lower)
		response := projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+query, "")
		window := decodeResponse[api.TaskSync](t, response, http.StatusOK)
		if window.Mode != "delta" || window.Epoch != epoch || !window.ObservedAt.Equal(f.observed) {
			t.Fatal("worker mutation changed summary epoch or observation window")
		}
		found := false
		for _, summary := range window.Tasks {
			if summary.ID != full.ID {
				continue
			}
			found = true
			if summary.AllowAgents != full.AllowAgents || summary.Status != full.Status || summary.Version != strconv.FormatInt(full.Version, 10) || !summary.UpdatedAt.Equal(full.UpdatedAt) || !reflect.DeepEqual(summary.StartedAt, full.StartedAt) || !reflect.DeepEqual(summary.CompletedAt, full.CompletedAt) || summary.Properties == nil || !reflect.DeepEqual(summary.Properties, properties.Properties) {
				t.Fatalf("worker summary disagrees with full task: summary=%+v task=%+v", summary, full)
			}
		}
		if !found {
			t.Fatal("summary overlap omitted recently changed Worker task")
		}
		observed = window.ObservedAt
	}
	body := workerCredentialClaimBody(current.Version)
	claimedAt := current.UpdatedAt.Add(time.Second)
	worker := model.WorkerClaim{ClaimID: body["claimId"].(string), WorkerID: body["workerId"].(string), UserID: f.principal.UserID,
		Machine:  model.WorkerMachine{ID: body["machine"].(map[string]any)["id"].(string), Name: "Worker machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr,
		WorktreeID: body["worktreeId"].(string), State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: claimedAt}
	claimed := current
	claimed.Status, claimed.Version, claimed.Ready = model.TaskInProgress, current.Version+1, false
	claimed.StartedAt, claimed.UpdatedAt = &claimedAt, claimedAt
	claimed.Properties = workerHTTPProperties(t, current.Properties, &worker)
	values := workerHTTPWriteValues(claimed)
	plan := expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, claimed, &claimedAt, store.TransactionCommitted)
	full := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim", jsonBody(t, body)), http.StatusOK)
	plan.check()
	assertSummary(full, claimed)
	current = claimed
	native := "private-native-session"
	worker.Phase, worker.Herdr, worker.NativeSessionID = model.WorkerExecuting, &model.WorkerHerdr{Session: "w", WorkspaceID: "workspace", PaneID: "private-pane"}, &native
	executing := current
	executing.Version, executing.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	executing.Properties = workerHTTPProperties(t, current.Properties, &worker)
	update := map[string]any{"version": current.Version, "claimId": worker.ClaimID, "phase": "executing", "herdr": map[string]any{"session": "w", "workspaceId": "workspace", "paneId": "private-pane"}, "nativeSessionId": native}
	values = workerHTTPWriteValues(executing)
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, executing, nil, store.TransactionCommitted)
	full = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPatch, path+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	plan.check()
	assertSummary(full, executing)
	current = executing
	update["version"] = current.Version
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, nil, model.Task{}, nil, store.TransactionCommitted)
	noop := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPatch, path+"/worker-claim", jsonBody(t, update)), http.StatusOK)
	plan.check()
	if !reflect.DeepEqual(noop, full) {
		t.Fatal("same-value Worker update changed version, timing or summary fields")
	}
	assertSummary(noop, current)
	released := current
	released.Status, released.Version, released.Ready = model.TaskTodo, current.Version+1, true
	released.StartedAt, released.CompletedAt, released.UpdatedAt = nil, nil, current.UpdatedAt.Add(time.Second)
	released.Properties = workerHTTPProperties(t, current.Properties, nil)
	values = workerHTTPWriteValues(released)
	plan = expectWorkerHTTPWrite(t, f.store, current, f.principal, model.ProjectAdmin, &values, released, nil, store.TransactionCommitted)
	full = decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodPost, path+"/worker-claim/release", jsonBody(t, map[string]any{"version": current.Version, "claimId": worker.ClaimID, "stoppedConfirmed": true})), http.StatusOK)
	plan.check()
	assertSummary(full, released)
	if full.Status != "todo" || full.StartedAt != nil || full.CompletedAt != nil {
		t.Fatal("release lost status timing contract")
	}
	f.expectRead(released)
	if read := readHTTPTask(t, f.handler, full); !reflect.DeepEqual(read, full) || apiWorker(t, read.Properties) != nil {
		t.Fatal("released Task projection retained execution")
	}
}

func TestTaskHTTPAssignmentSyncProjections(t *testing.T) {
	f := newTaskHTTPFixture(t)
	unassigned := f.target
	unassigned.Title, unassigned.AssignedTo = "Unassigned prerequisite", nil
	unassigned, _ = assignmentHTTPCreate(f, unassigned, jsonBody(t, map[string]any{"status": "todo", "title": unassigned.Title}), nil)
	assigned := f.target
	assigned.Title = "Assigned successor"
	assigned.DependsOn, assigned.BlockedBy = []string{unassigned.ID}, []string{unassigned.ID}
	assigned.Ready = false
	assigned, _ = assignmentHTTPCreate(f, assigned, jsonBody(t, map[string]any{"status": "todo", "title": assigned.Title, "assignedTo": f.principal.UserID, "dependsOn": []string{unassigned.ID}}), []model.Task{unassigned})
	rows := []model.Task{unassigned, assigned}
	facts := []model.TaskAssigneeFact{{UserID: f.principal.UserID, ProfileID: &f.principal.UserID, HasProjectAccess: true, Qualified: true}}
	check := func(expected map[string]*string, delta string) {
		f.expectList([]store.TaskQuery{{Page: store.Page{Limit: 50}}}, []store.TaskPage{{Items: rows}})
		response := projectRequest(f.handler, http.MethodGet, taskCollection(f.project.ID), "")
		decodeResponse[api.TaskPage](t, response, http.StatusOK)
		assertHTTPAssignmentResources(t, response.Body.Bytes(), "items", expected)
		f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(rows[0]), assignmentHTTPSyncRow(rows[1])}, map[string]model.TaskDependencyState{}, facts, nil)
		response = projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), "")
		decodeResponse[api.TaskSync](t, response, http.StatusOK)
		assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		for _, row := range rows {
			f.expectRead(row)
			response = projectRequest(f.handler, http.MethodGet, taskPath(assignmentHTTPAPI(t, row)), "")
			decodeResponse[api.Task](t, response, http.StatusOK)
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "", map[string]*string{row.ID: expected[row.ID]})
		}
		if delta != "" {
			lower := f.observed.Add(-10 * time.Second)
			f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(rows[0]), assignmentHTTPSyncRow(rows[1])}, map[string]model.TaskDependencyState{}, facts, &lower)
			response = projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID)+delta, "")
			result := decodeResponse[api.TaskSync](t, response, http.StatusOK)
			if result.Mode != "delta" {
				t.Fatalf("delta mode: %q", result.Mode)
			}
			assertHTTPAssignmentResources(t, response.Body.Bytes(), "tasks", expected)
		}
	}
	check(map[string]*string{unassigned.ID: nil, assigned.ID: &f.principal.UserID}, "")
	f.expectSync([]model.TaskViewRecord{assignmentHTTPSyncRow(unassigned), assignmentHTTPSyncRow(assigned)}, map[string]model.TaskDependencyState{}, facts, nil)
	baseline := decodeResponse[api.TaskSync](t, projectRequest(f.handler, http.MethodGet, syncPath(f.project.ID), ""), http.StatusOK)
	after := platformHTTPResult(unassigned, unassigned)
	after.AssignedTo = &f.principal.UserID
	unassigned = assignmentHTTPUpdate(f, unassigned, after, map[string]any{"assignedTo": f.principal.UserID}, nil, true)
	after = platformHTTPResult(assigned, assigned)
	after.AssignedTo = nil
	assigned = assignmentHTTPUpdate(f, assigned, after, map[string]any{"assignedTo": nil}, []model.Task{unassigned}, true)
	rows = []model.Task{unassigned, assigned}
	query := "?epoch=" + baseline.Epoch + "&since=" + url.QueryEscape(baseline.ObservedAt.Format(time.RFC3339Nano))
	check(map[string]*string{unassigned.ID: &f.principal.UserID, assigned.ID: nil}, query)
}
