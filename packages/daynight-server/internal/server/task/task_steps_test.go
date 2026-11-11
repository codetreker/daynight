package task_test

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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func stepHTTPPath() string {
	return "/api/v1/projects/" + testProjectID + "/tasks/" + testTaskID + "/steps"
}

func stepHTTPRows() []api.TaskStep {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	return []api.TaskStep{
		{ID: "abcdef01", Title: "  <同名&> 😀 \x1b[31m\n", Description: "# 完整 Markdown\n<>& \"\\\r\n\u2028\u2029", Status: model.TaskStepDone, CreatedAt: stamp, UpdatedAt: stamp.Add(time.Hour)},
		{ID: "00000000", Title: "\uFEFF", Description: "", Status: model.TaskStepTodo, CreatedAt: stamp.Add(time.Microsecond), UpdatedAt: stamp.Add(time.Microsecond)},
		{ID: "fedcba98", Title: "same", Description: "third", Status: model.TaskStepSkipped, CreatedAt: stamp.Add(time.Second), UpdatedAt: stamp.Add(time.Second)},
		{ID: "11111111", Title: "same", Description: "fourth", Status: model.TaskStepInProgress, CreatedAt: stamp.Add(2 * time.Second), UpdatedAt: stamp.Add(2 * time.Second)},
	}
}

func stepHTTPDocument(t *testing.T, version int64, rows []api.TaskStep) taskservice.StepsDocument {
	t.Helper()
	resource := api.StepsResource{ProjectID: testProjectID, TaskID: testTaskID, Version: version, Steps: rows}
	data, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.StepsDocument{Resource: resource, JSON: append(data, '\n')}
}

func stepHTTPItem(t *testing.T, version int64, row api.TaskStep) taskservice.StepDocument {
	t.Helper()
	resource := api.StepResource{ProjectID: testProjectID, TaskID: testTaskID, Version: version, Step: row}
	data, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.StepDocument{Resource: resource, JSON: append(data, '\n')}
}

func stepHTTPWrite(t *testing.T, version int64, rows []api.TaskStep, changed bool) taskservice.StepsWriteResult {
	t.Helper()
	return taskservice.StepsWriteResult{StepsDocument: stepHTTPDocument(t, version, rows), Changed: changed, Phase: "commit", TransactionOutcome: store.TransactionCommitted}
}

func checkStepHTTPCall(t *testing.T, h *resourceTestHandler, ctx context.Context, principal model.Principal, projectID, taskID string) {
	t.Helper()
	if principal != h.principal || projectID != testProjectID || taskID != testTaskID || ctx == nil || ctx.Err() != nil || httpx.RequestID(ctx) == "" {
		t.Fatalf("Step request arguments changed: principal=%+v project=%s task=%s context=%v", principal, projectID, taskID, ctx)
	}
}

func TestStepsHTTPReadResourcesAndRefusals(t *testing.T) {
	t.Run("empty collection", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		document := stepHTTPDocument(t, 1, []api.TaskStep{})
		h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
			checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
			return document, nil
		}
		response := projectRequest(h, "GET", stepHTTPPath(), "")
		result := decodeResponse[api.StepsResource](t, response, 200)
		assertStepsWireFields(t, response.Body.Bytes(), false, 0)
		if result.Steps == nil || result.Version != 1 || !bytes.Equal(response.Body.Bytes(), document.JSON) {
			t.Fatal("empty collection bytes changed")
		}
	})
	t.Run("protocol refusals", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		for _, suffix := range []string{"?", "?limit=1", "?x=1&x=2", "?bad=%xx"} {
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath()+suffix, ""), 400, "invalid_input")
		}
		for _, id := range []string{"abc", "000000000", "0000000g", testTaskID} {
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath()+"/"+id, ""), 400, "invalid_input")
		}
		for _, method := range []string{"PUT", "OPTIONS"} {
			for _, endpoint := range []string{stepHTTPPath(), stepHTTPPath() + "/abcdef01"} {
				refusal := projectRequest(h, method, endpoint, "")
				assertProjectError(t, refusal, 405, "method_not_allowed")
				allow := "GET, HEAD, PATCH, DELETE"
				if endpoint == stepHTTPPath() {
					allow = "GET, HEAD, POST"
				}
				if refusal.Header().Get("Allow") != allow || refusal.Header().Get("Cache-Control") != "no-store" {
					t.Fatal("unsupported method metadata is invalid")
				}
			}
		}
		if h.Steps.TotalCalls() != 0 {
			t.Fatal("protocol refusal invoked Step service")
		}
	})
	for _, tc := range []struct {
		name, code string
		status     int
	}{{"missing", "not_found", 404}, {"deleted parent", "task_deleted", 410}} {
		t.Run(tc.name, func(t *testing.T) {
			for _, item := range []bool{false, true} {
				h := newHTTPFixture(t, io.Discard)
				fault := &model.Fault{Code: tc.code, Message: "Resource is unavailable."}
				if item {
					h.Steps.GetFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string) (taskservice.StepDocument, error) {
						checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
						if id != "abcdef01" {
							t.Fatal("Step ID was not canonicalized")
						}
						if tc.code == "not_found" {
							return taskservice.StepDocument{}, &tasksteps.StepAbsence{Version: 2, Cause: fault}
						}
						return taskservice.StepDocument{}, fault
					}
				} else {
					h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
						checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
						return taskservice.StepsDocument{}, fault
					}
				}
				path := stepHTTPPath()
				if item {
					path += "/ABCDEF01"
				}
				assertProjectError(t, projectRequest(h, "GET", path, ""), tc.status, tc.code)
			}
		})
	}
}

func TestStepsHTTPRejectsCorruptStorage(t *testing.T) {
	for _, cause := range []string{"stored positions are not dense", "invalid stored title", "invalid stored timestamp"} {
		t.Run(cause, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				return taskservice.StepsDocument{}, errors.New(cause + " body-sentinel-must-not-log SELECT private")
			}
			assertProjectError(t, projectRequest(h, "GET", stepHTTPPath(), ""), 500, "internal_error")
			for _, sentinel := range []string{cause, "body-sentinel-must-not-log", "SELECT private"} {
				if strings.Contains(logs.String(), sentinel) {
					t.Fatalf("storage error leaked %q", sentinel)
				}
			}
		})
	}
}

func TestStepsHTTPReadPreservesEveryStateAndTimestamp(t *testing.T) {
	var logs bytes.Buffer
	h := newHTTPFixture(t, &logs)
	const version int64 = 9007199254740993
	rows := stepHTTPRows()
	document := stepHTTPDocument(t, version, rows)
	h.Steps.ListFunc = func(ctx context.Context, p model.Principal, projectID, taskID string) (taskservice.StepsDocument, error) {
		checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
		return document, nil
	}
	h.Steps.GetFunc = func(ctx context.Context, p model.Principal, projectID, taskID, stepID string) (taskservice.StepDocument, error) {
		checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
		if stepID != "abcdef01" {
			t.Fatal("Step ID was not canonicalized")
		}
		return stepHTTPItem(t, version, rows[0]), nil
	}
	path := "/api/v1/projects/" + strings.ToUpper(testProjectID) + "/tasks/" + strings.ToUpper(testTaskID) + "/steps"
	response := projectRequest(h, "GET", path, "")
	resource := decodeResponse[api.StepsResource](t, response, 200)
	assertStepsWireFields(t, response.Body.Bytes(), false, len(rows))
	if resource.ProjectID != testProjectID || resource.TaskID != testTaskID || resource.Version != version || !reflect.DeepEqual(resource.Steps, rows) || !bytes.Equal(response.Body.Bytes(), document.JSON) || !bytes.Contains(response.Body.Bytes(), []byte(`"version":9007199254740993`)) {
		t.Fatal("complete service document changed on the wire")
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID || response.Body.Bytes()[response.Body.Len()-1] != '\n' {
		t.Fatal("read metadata or newline changed")
	}
	itemResponse := projectRequest(h, "GET", path+"/ABCDEF01", "")
	item := decodeResponse[api.StepResource](t, itemResponse, 200)
	assertStepsWireFields(t, itemResponse.Body.Bytes(), true, 1)
	if item.ProjectID != testProjectID || item.TaskID != testTaskID || item.Version != version || item.Step != rows[0] {
		t.Fatal("scoped Step item changed")
	}
	for _, sentinel := range []string{"完整 Markdown", "<同名", "third", "fourth"} {
		if strings.Contains(logs.String(), sentinel) {
			t.Fatalf("Step content leaked %q", sentinel)
		}
	}
}

func assertStepsWireFields(t *testing.T, data []byte, item bool, count int) {
	t.Helper()
	assertObject := func(fields map[string]json.RawMessage, names ...string) {
		t.Helper()
		if len(fields) != len(names) {
			t.Fatalf("unexpected resource field count: got %d want %d", len(fields), len(names))
		}
		for _, name := range names {
			value, exists := fields[name]
			if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				t.Fatalf("missing or null resource field %q", name)
			}
		}
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal("resource is not valid JSON")
	}
	key := "steps"
	if item {
		key = "step"
	}
	assertObject(fields, "projectId", "taskId", "version", key)
	var rows []map[string]json.RawMessage
	if item {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(fields[key], &row); err != nil {
			t.Fatal("Step is not a JSON object")
		}
		rows = []map[string]json.RawMessage{row}
	} else if err := json.Unmarshal(fields[key], &rows); err != nil || rows == nil {
		t.Fatal("Steps is not a JSON array")
	}
	if len(rows) != count {
		t.Fatalf("unexpected Step count: got %d want %d", len(rows), count)
	}
	for _, row := range rows {
		assertObject(row, "id", "title", "description", "status", "createdAt", "updatedAt")
	}
}

type stepMaterialFixture struct {
	*taskHTTPFixture
	files    *local.Storage
	role     model.ProjectRole
	server   *httptest.Server
	wireMu   sync.Mutex
	wireDone chan struct{}
}

func stepsMaterialFixture(t *testing.T, logs io.Writer) (*stepMaterialFixture, *resourceTestHandler, api.Task) {
	t.Helper()
	project, target, principal := taskHTTPMockModels()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f := &stepMaterialFixture{taskHTTPFixture: &taskHTTPFixture{t: t, store: newHTTPTestStore(t), project: project, target: target, principal: principal, observed: target.UpdatedAt.Add(time.Minute)}, files: files, role: model.ProjectAdmin}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	handler := &resourceTestHandler{token: defaultHTTPToken(), principal: principal}
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != f.principal.Kind || token != httpTestToken(kind) {
			return model.Principal{}, authhttp.Failure()
		}
		return f.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.TaskStepsRoutes(mux, taskservice.NewTaskSteps(f.store), auth, logger)
	attachmenthttp.RegisterRoutes(mux, attachmentservice.NewAttachments(f.store, nil, files), &authhttp.Authentication{RequestAuthentication: auth}, logger)
	handler.Handler = httpx.RequestLogging(logger, mux)
	f.handler = handler
	f.server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		f.wireMu.Lock()
		done := f.wireDone
		f.wireMu.Unlock()
		if done == nil {
			unexpectedHTTPCall(t, "unplanned Step HTTP request")
		}
		defer close(done)
		f.handler.ServeHTTP(w, request)
	}))
	t.Cleanup(f.server.Close)
	t.Cleanup(f.server.Client().CloseIdleConnections)
	task, err := taskprotocol.RESTTask(target, false)
	if err != nil {
		t.Fatal(err)
	}
	return f, f.handler, task
}

func (f *stepMaterialFixture) expectStepsRead(header model.TaskHeader, steps []model.TaskStep) {
	header.DeletedAt = copyTaskHTTPPointer(header.DeletedAt)
	steps = copyTaskHTTPSlice(steps)
	f.expectSnapshot(map[string]int{"header": 1, "steps": 1}, func(reader *taskHTTPReaderMock, projects *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		f.stepReadRole(projects, plan)
		reader.TaskHeaderFn = func(ctx context.Context, project, task string) (model.TaskHeader, error) {
			f.require(ctx, project)
			plan.Called("header")
			if task != header.ID {
				unexpectedHTTPCall(f.t, "Step parent")
			}
			header.DeletedAt = copyTaskHTTPPointer(header.DeletedAt)
			return header, nil
		}
		reader.TaskStepsFn = func(ctx context.Context, task string) ([]model.TaskStep, error) {
			f.require(ctx, header.ProjectID)
			plan.Called("steps")
			if task != header.ID {
				unexpectedHTTPCall(f.t, "Step collection parent")
			}
			return copyTaskHTTPSlice(steps), nil
		}
	})
}

func (f *stepMaterialFixture) expectMissingStep(header model.TaskHeader, id string) {
	header.DeletedAt = copyTaskHTTPPointer(header.DeletedAt)
	f.expectSnapshot(map[string]int{"header": 1, "step": 1}, func(reader *taskHTTPReaderMock, projects *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		f.stepReadRole(projects, plan)
		reader.TaskHeaderFn = func(ctx context.Context, project, task string) (model.TaskHeader, error) {
			f.require(ctx, project)
			plan.Called("header")
			if task != header.ID {
				unexpectedHTTPCall(f.t, "missing Step parent")
			}
			header.DeletedAt = copyTaskHTTPPointer(header.DeletedAt)
			return header, nil
		}
		reader.TaskStepFn = func(ctx context.Context, task, step string) (model.TaskStep, error) {
			f.require(ctx, header.ProjectID)
			plan.Called("step")
			if task != header.ID || step != id {
				unexpectedHTTPCall(f.t, "missing Step identity")
			}
			return model.TaskStep{}, model.ErrNotFound
		}
	})
}

type stepHTTPWritePlan struct {
	Header    model.TaskHeader
	Steps     []model.TaskStep
	Operation string
	ID        string
	From      int64
	To        int64
	Candidate model.TaskStep
	Observed  time.Time
	Refused   bool
	Stale     bool
}

func (f *stepMaterialFixture) expectStepsWrite(expected stepHTTPWritePlan) {
	expected.Steps = copyTaskHTTPSlice(expected.Steps)
	expected.Header.DeletedAt = copyTaskHTTPPointer(expected.Header.DeletedAt)
	f.t.Helper()
	want := map[string]int{"write": 1, "access": 1, "header": 1}
	if !expected.Stale {
		want["steps"] = 1
	}
	if !expected.Refused && !expected.Stale {
		want["header"], want["observed"], want["touch"], want["capture"] = 2, 1, 1, 1
		want[expected.Operation] = 1
	}
	plan := newHTTPCallPlan(f.t, want)
	base := newTaskHTTPMockBase(f.t, "Step HTTP write")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	project.ProjectAccessFn = func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
		f.require(ctx, expected.Header.ProjectID)
		plan.Called("access")
		if actor != f.principal {
			unexpectedHTTPCall(f.t, "Step actor")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = f.role
		return access, nil
	}
	writer := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("steps")}
	headers := 0
	writer.TaskHeaderFn = func(ctx context.Context, task string) (model.TaskHeader, error) {
		f.require(ctx, expected.Header.ProjectID)
		plan.Called("header")
		if task != expected.Header.ID {
			unexpectedHTTPCall(f.t, "Step write parent")
		}
		headers++
		header := expected.Header
		if headers == 2 {
			header.Version++
		}
		header.DeletedAt = copyTaskHTTPPointer(header.DeletedAt)
		return header, nil
	}
	writer.TaskStepsFn = func(ctx context.Context, task string) ([]model.TaskStep, error) {
		f.require(ctx, expected.Header.ProjectID)
		plan.Called("steps")
		if task != expected.Header.ID {
			unexpectedHTTPCall(f.t, "Step write collection")
		}
		return copyTaskHTTPSlice(expected.Steps), nil
	}
	writer.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
		f.require(ctx, expected.Header.ProjectID)
		plan.Called("observed")
		return expected.Observed, nil
	}
	writer.TouchTaskFn = func(ctx context.Context, task string, at time.Time) error {
		f.require(ctx, expected.Header.ProjectID)
		plan.Called("touch")
		if task != expected.Header.ID || at != expected.Observed {
			unexpectedHTTPCall(f.t, "Step touch")
		}
		return nil
	}
	if expected.Operation == "delete" {
		writer.DeleteTaskStepFn = func(ctx context.Context, task, id string, from, remaining int64) error {
			f.require(ctx, expected.Header.ProjectID)
			plan.Called("delete")
			if task != expected.Header.ID || id != expected.ID || from != expected.From || remaining != expected.To {
				f.t.Errorf("Step deletion arguments: %s %s %d %d", task, id, from, remaining)
				panic("Step deletion arguments changed")
			}
			return nil
		}
	}
	if expected.Operation == "add" || expected.Operation == "change" {
		write := func(ctx context.Context, task string, step model.TaskStep) error {
			f.require(ctx, expected.Header.ProjectID)
			plan.Called(expected.Operation)
			if task != expected.Header.ID || step != expected.Candidate {
				f.t.Errorf("Step candidate: %#v want %#v", step, expected.Candidate)
				panic("Step candidate changed")
			}
			return nil
		}
		if expected.Operation == "add" {
			writer.InsertTaskStepFn = write
		} else {
			writer.UpdateTaskStepFn = write
		}
	}
	if expected.Operation == "move" {
		writer.MoveTaskStepFn = func(ctx context.Context, task, id string, from, to int64) error {
			f.require(ctx, expected.Header.ProjectID)
			plan.Called("move")
			if task != expected.Header.ID || id != expected.ID || from != expected.From || to != expected.To {
				unexpectedHTTPCall(f.t, "Step move")
			}
			return nil
		}
	}
	capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
	capture.FreezeAudienceFn = func(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
		f.require(ctx, project)
		plan.Called("capture")
		if !reflect.DeepEqual(types, []string{protocol.StepUpdated}) {
			unexpectedHTTPCall(f.t, "Step capture event")
		}
		return []store.WebhookAudience{}, nil
	}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return writer }, CaptureDAOFn: func() store.WebhookCaptureDAO { return capture }}
	f.store.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
		plan.Called("write")
		if project != expected.Header.ProjectID || f.active || run == nil {
			unexpectedHTTPCall(f.t, "Step write callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		err := run(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

func (f *stepMaterialFixture) expectStepAccessError(write bool) {
	base := newTaskHTTPMockBase(f.t, "Step denied access")
	plan := newHTTPCallPlan(f.t, map[string]int{"scope": 1, "access": 1})
	access := func(ctx context.Context, actor model.Principal, project string) (model.ProjectAccess, error) {
		plan.Called("access")
		if actor != f.principal || project != f.project.ID || ctx.Err() != nil {
			unexpectedHTTPCall(f.t, "denied Step authorization")
		}
		return model.ProjectAccess{}, model.ErrNotFound
	}
	if write {
		dao := &taskHTTPProjectWriterMock{taskHTTPMockBase: base, ProjectAccessFn: func(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
			return access(ctx, actor, f.project.ID)
		}}
		scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectWriteDAO { return dao }}
		f.store.WriteProjectCall = func(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
			plan.Called("scope")
			if project != f.project.ID {
				unexpectedHTTPCall(f.t, "denied Project scope")
			}
			err := run(scope)
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
	} else {
		dao := &taskHTTPProjectReaderMock{taskHTTPMockBase: base, ProjectAccessFn: access}
		scope := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base, ProjectDAOFn: func() store.ProjectReader { return dao }}
		f.store.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
			plan.Called("scope")
			return run(scope)
		}
	}
}

func (f *stepMaterialFixture) authenticatedRequest(actor model.Principal, method, path, body, origin string, status int, code string) *httptest.ResponseRecorder {
	f.t.Helper()
	f.principal = actor
	ctx, cancel := context.WithTimeout(f.t.Context(), 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	if actor.UserID != "" {
		if actor.Kind == model.SessionCredential {
			request.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: httpTestToken(actor.Kind)})
		} else {
			request.Header.Set("Authorization", "Bearer "+httpTestToken(actor.Kind))
		}
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	done := make(chan struct{})
	f.wireMu.Lock()
	f.wireDone = done
	f.wireMu.Unlock()
	wire, err := f.server.Client().Do(request)
	if err != nil {
		f.t.Fatal(err)
	}
	data, readErr := io.ReadAll(wire.Body)
	closeErr := wire.Body.Close()
	if readErr != nil || closeErr != nil {
		f.t.Fatalf("HTTP response body: read=%v close=%v", readErr, closeErr)
	}
	select {
	case <-done:
	case <-ctx.Done():
		f.t.Fatal("Step HTTP handler did not finish")
	}
	f.wireMu.Lock()
	f.wireDone = nil
	f.wireMu.Unlock()
	response := httptest.NewRecorder()
	response.Code = wire.StatusCode
	response.HeaderMap = wire.Header.Clone()
	response.Body = bytes.NewBuffer(data)
	if response.Code != status || response.Header().Get("Cache-Control") != "no-store" {
		f.t.Fatalf("Step response %s %s: %d %s", method, path, response.Code, response.Body)
	}
	if code != "" {
		assertProjectError(f.t, response, status, code)
	}
	return response
}

type stepHTTPAttachmentReader struct {
	store.AttachmentReader
	t    *testing.T
	plan *httpCallPlan
	item model.Attachment
}

func (d *stepHTTPAttachmentReader) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	d.plan.Called("metadata")
	if project != d.item.ProjectID || task != d.item.TaskID || path != d.item.Path || ctx.Err() != nil {
		unexpectedHTTPCall(d.t, "referenced attachment identity")
	}
	return d.item, nil
}

func (d *stepHTTPAttachmentReader) Attachments(ctx context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	d.plan.Called("metadata")
	expected := store.AttachmentQuery{Limit: 50}
	if project != d.item.ProjectID || task != d.item.TaskID || !reflect.DeepEqual(query, expected) || ctx.Err() != nil {
		unexpectedHTTPCall(d.t, "referenced attachment page")
	}
	return store.AttachmentPage{Items: []model.Attachment{d.item}}, nil
}

func (f *stepMaterialFixture) referencedAttachment(path, contentType string, content []byte) model.Attachment {
	f.t.Helper()
	address, err := attachmentcore.NewAddress(f.project.ID, f.target.ID, path)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := f.files.Put(f.t.Context(), attachmentcore.Bucket, address.StoragePath, bytes.NewReader(content)); err != nil {
		f.t.Fatal(err)
	}
	return model.Attachment{ProjectID: f.project.ID, TaskID: f.target.ID, Path: path, ContentType: contentType, SizeBytes: int64(len(content)), CreatedAt: f.target.CreatedAt, UpdatedAt: f.target.CreatedAt}
}

func (f *stepMaterialFixture) expectAttachmentRead(item model.Attachment) {
	f.expectSnapshot(map[string]int{"presence": 1, "metadata": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, scope *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		reader.TaskPresenceFn = func(ctx context.Context, project, task string) (store.TaskPresence, error) {
			f.require(ctx, project)
			plan.Called("presence")
			if task != item.TaskID {
				unexpectedHTTPCall(f.t, "attachment parent")
			}
			return store.TaskPresence{Found: true}, nil
		}
		scope.AttachmentDAOFn = func() store.AttachmentReader { return &stepHTTPAttachmentReader{t: f.t, plan: plan, item: item} }
	})
}

func (f *stepMaterialFixture) stepReadRole(projects *taskHTTPProjectReaderMock, plan *httpCallPlan) {
	projects.ProjectAccessFn = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		f.require(ctx, id)
		plan.Called("access")
		if actor != f.principal {
			unexpectedHTTPCall(f.t, "Step read principal")
		}
		access := taskHTTPMockAccess(f.project, actor)
		access.Role = f.role
		return access, nil
	}
}

func TestStepsHTTPAuthenticatedMemberAndHEAD(t *testing.T) {
	f, _, task := stepsMaterialFixture(t, io.Discard)
	admin := defaultHTTPPrincipal()
	admin.Kind = model.SessionCredential
	member := model.Principal{UserID: "b6666666-6666-4666-8666-666666666666", CredentialID: "c7777777-7777-4777-8777-777777777777", Kind: model.SessionCredential}
	outsider := model.Principal{UserID: "d8888888-8888-4888-8888-888888888888", CredentialID: "e9999999-9999-4999-8999-999999999999", Kind: model.SessionCredential}
	anonymous := model.Principal{}
	origin := "https://daynight.example"
	path := taskPath(task) + "/steps"
	header := model.TaskHeader{ProjectID: task.ProjectID, ID: task.ID, Version: 1}
	current := []model.TaskStep{}
	for index, actor := range []model.Principal{admin, member} {
		f.principal = actor
		f.role = []model.ProjectRole{model.ProjectAdmin, model.ProjectMemberRole}[index]
		f.expectStepsRead(header, current)
		response := f.authenticatedRequest(actor, "GET", path, "", "", 200, "")
		resource := decodeResponse[api.StepsResource](t, response, 200)
		if resource.Steps == nil || len(resource.Steps) != 0 {
			t.Fatal("admin/member read failed")
		}
	}
	for _, suffix := range []string{"", "/00000000"} {
		for _, method := range []string{"GET", "HEAD", "POST"} {
			f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
			response := f.authenticatedRequest(anonymous, method, path+suffix, "", "", 401, "")
			if method == "HEAD" && response.Body.Len() != 0 {
				t.Fatal("anonymous HEAD returned body")
			}
		}
		f.expectStepAccessError(false)
		f.authenticatedRequest(outsider, "GET", path+suffix, "", origin, 404, "not_found")
	}
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsRead(header, current)
	response := f.authenticatedRequest(member, "HEAD", path, "", "", 200, "")
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Daynight-User-ID") != member.UserID {
		t.Fatal("HEAD lost identity/type or returned body")
	}
	deny := func(method, suffix, body string, anonymousCheck bool) {
		f.store.ReadSnapshotCall, f.store.WriteProjectCall = nil, nil
		if anonymousCheck {
			f.authenticatedRequest(anonymous, method, path+suffix, body, "", 401, "unauthenticated")
		}
		f.authenticatedRequest(member, method, path+suffix, body, "", 403, "forbidden")
		f.authenticatedRequest(member, method, path+suffix, body, "https://unrelated.invalid", 403, "forbidden")
		f.expectStepAccessError(true)
		f.authenticatedRequest(outsider, method, path+suffix, body, origin, 404, "not_found")
	}
	body := `{"version":1,"id":"00000000","title":"Member add"}`
	deny("POST", "", body, false)
	at := f.observed
	candidate := model.TaskStep{ID: "00000000", Position: 0, Title: "Member add", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = member
	f.role = model.ProjectMemberRole
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "add", Candidate: candidate, Observed: at})
	response = f.authenticatedRequest(member, "POST", path, body, origin, 201, "")
	added := decodeResponse[api.StepsResource](t, response, 201)
	if added.Version != 2 || len(added.Steps) != 1 || response.Header().Get("Location") != path+"/00000000" {
		t.Fatal("member could not add")
	}
	current = []model.TaskStep{candidate}
	header.Version = 2
	at = at.Add(time.Minute)
	candidate = model.TaskStep{ID: "abcdef01", Position: 1, Title: "Admin add", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f.principal = admin
	f.role = model.ProjectAdmin
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "add", Candidate: candidate, Observed: at})
	if decodeResponse[api.StepsResource](t, f.authenticatedRequest(admin, "POST", path, `{"version":2,"id":"abcdef01","title":"Admin add"}`, origin, 201, ""), 201).Version != 3 {
		t.Fatal("admin could not add")
	}
	current = append(current, candidate)
	header.Version = 3
	for _, change := range []struct{ method, suffix, body string }{{"PATCH", "/00000000", `{"version":3,"description":"edited"}`}, {"PUT", "/00000000/status", `{"version":4,"status":"in_progress"}`}} {
		deny(change.method, change.suffix, change.body, true)
		at = at.Add(time.Minute)
		candidate = current[0]
		candidate.UpdatedAt = at
		if change.method == "PATCH" {
			candidate.Description = "edited"
		} else {
			candidate.Status = model.TaskStepInProgress
		}
		f.principal = member
		f.role = model.ProjectMemberRole
		f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "change", Candidate: candidate, Observed: at})
		changed := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, change.method, path+change.suffix, change.body, origin, 200, ""), 200)
		if len(changed.Steps) != 2 {
			t.Fatal("member change lost collection")
		}
		current[0] = candidate
		header.Version++
	}
	moveBody := `{"version":5,"after":"ABCDEF01"}`
	deny("PUT", "/00000000/position", moveBody, true)
	f.principal = member
	f.role = model.ProjectMemberRole
	at = at.Add(time.Minute)
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "move", ID: "00000000", From: 0, To: 1, Observed: at})
	moved := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "PUT", path+"/00000000/position", moveBody, origin, 200, ""), 200)
	if moved.Version != 6 || moved.Steps[1].ID != "00000000" {
		t.Fatal("member could not move")
	}
	current = []model.TaskStep{current[1], current[0]}
	current[0].Position = 0
	current[1].Position = 1
	header.Version = 6
	deleteBody := `{"version":6}`
	deny("DELETE", "/ABCDEF01", deleteBody, true)
	f.principal = member
	f.role = model.ProjectMemberRole
	at = at.Add(time.Minute)
	f.expectStepsWrite(stepHTTPWritePlan{Header: header, Steps: current, Operation: "delete", ID: "abcdef01", From: 0, To: 1, Observed: at})
	deleted := decodeResponse[api.StepsResource](t, f.authenticatedRequest(member, "DELETE", path+"/ABCDEF01", deleteBody, origin, 200, ""), 200)
	if deleted.Version != 7 || len(deleted.Steps) != 1 || deleted.Steps[0].ID != "00000000" {
		t.Fatal("member could not delete")
	}
	current = []model.TaskStep{current[1]}
	current[0].Position = 0
	header.Version = 7
	member.Kind = model.PATCredential
	f.principal = member
	f.expectStepsRead(header, current)
	f.authenticatedRequest(member, http.MethodGet, path, "", "", 200, "")
}
