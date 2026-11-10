package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type stepHTTPFixture struct {
	*taskHTTPFixture
	files       *local.Storage
	attachments *stepHTTPAttachments
	server      *httptest.Server
	wireMu      sync.Mutex
	wireDone    chan struct{}
}

func stepsHTTPFixture(t *testing.T, logs io.Writer) (*stepHTTPFixture, *resourceTestHandler, api.Task) {
	t.Helper()
	project, target, principal := taskHTTPMockModels()
	files := attachmentTestFiles(t)
	f := &stepHTTPFixture{taskHTTPFixture: &taskHTTPFixture{t: t, tasks: &taskHTTPOperations{t: t}, steps: &taskHTTPStepOperations{t: t}, project: project, target: target, principal: principal, observed: target.UpdatedAt.Add(time.Minute)}, files: files, attachments: &stepHTTPAttachments{t: t}}
	f.handler = newOperationHTTPServer(t, func(deps *httpDependencies) {
		deps.Tasks, deps.TaskSteps, deps.Attachments = f.tasks, f.steps, f.attachments
	}, logs, principal)
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
	var requiredPlatform *string
	if target.RequiredPlatform != nil {
		value := string(*target.RequiredPlatform)
		requiredPlatform = &value
	}
	task := api.Task{ID: target.ID, ProjectID: target.ProjectID, Title: target.Title, Description: target.Description, Properties: api.TaskProperties(copyTaskHTTPProperties(target.Properties)), Status: string(target.Status), Version: target.Version, CreatedAt: target.CreatedAt, UpdatedAt: target.UpdatedAt, StartedAt: copyTaskHTTPPointer(target.StartedAt), CompletedAt: copyTaskHTTPPointer(target.CompletedAt), CancelledAt: copyTaskHTTPPointer(target.CancelledAt), DependsOn: copyTaskHTTPSlice(target.DependsOn), ExternalDependsOn: copyTaskHTTPSlice(target.ExternalDependsOn), BlockedBy: copyTaskHTTPSlice(target.BlockedBy), RequiredPlatform: requiredPlatform, AssignedTo: copyTaskHTTPPointer(target.AssignedTo), AllowAgents: target.AllowAgents, Ready: target.Ready}
	return f, f.handler, task
}

func stepHTTPDocument(t *testing.T, header model.TaskHeader, rows []model.TaskStep) taskservice.StepsDocument {
	t.Helper()
	resource := taskcodec.StepsResource{ProjectID: header.ProjectID, TaskID: header.ID, Version: header.Version, Steps: make([]taskcodec.Step, len(rows))}
	for i, row := range rows {
		resource.Steps[i] = taskcodec.Step{ID: row.ID, Title: row.Title, Description: row.Description, Status: row.Status, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	}
	data, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	return taskservice.StepsDocument{Resource: resource, JSON: append(data, '\n')}
}

func copyStepHTTPDocument(doc taskservice.StepsDocument) taskservice.StepsDocument {
	doc.Resource.Steps = copyTaskHTTPSlice(doc.Resource.Steps)
	doc.JSON = bytes.Clone(doc.JSON)
	return doc
}

func (f *stepHTTPFixture) requireStepOperation(ctx context.Context, actor model.Principal, project, task string) {
	f.t.Helper()
	requireOperationHTTPContext(f.t, ctx)
	if ctx.Err() != nil || actor != f.principal || project != f.project.ID || task != f.target.ID {
		unexpectedHTTPCall(f.t, "Step operation context, actor or address")
	}
}

func (f *stepHTTPFixture) clearSteps() { *f.steps = taskHTTPStepOperations{t: f.t} }

func (f *stepHTTPFixture) expectStepsRead(header model.TaskHeader, rows []model.TaskStep) {
	f.clearSteps()
	document := stepHTTPDocument(f.t, header, copyTaskHTTPSlice(rows))
	plan := newHTTPCallPlan(f.t, map[string]int{"list": 1})
	f.steps.ListCall = func(ctx context.Context, actor model.Principal, project, task string) (taskservice.StepsDocument, error) {
		f.requireStepOperation(ctx, actor, project, task)
		plan.Called("list")
		return copyStepHTTPDocument(document), nil
	}
}

func (f *stepHTTPFixture) expectMissingStep(header model.TaskHeader, id string) {
	f.clearSteps()
	plan := newHTTPCallPlan(f.t, map[string]int{"get": 1})
	f.steps.GetCall = func(ctx context.Context, actor model.Principal, project, task, step string) (taskservice.StepDocument, error) {
		f.requireStepOperation(ctx, actor, project, task)
		plan.Called("get")
		if step != id {
			unexpectedHTTPCall(f.t, "missing Step identity")
		}
		return taskservice.StepDocument{}, &tasksteps.StepAbsence{Version: header.Version, Cause: &model.Fault{Code: "not_found", Message: "Step not found."}}
	}
}

type stepHTTPWritePlan struct {
	ID           string
	Add          *taskservice.AddTaskStep
	Update       *taskservice.UpdateTaskStep
	Status       *taskservice.SetTaskStepStatus
	Delete       *taskservice.DeleteTaskStep
	Move         *taskservice.MoveTaskStep
	ResultHeader model.TaskHeader
	ResultSteps  []model.TaskStep
	Refused      bool
	Stale        bool
}

func (f *stepHTTPFixture) expectStepsWrite(expected stepHTTPWritePlan) {
	f.t.Helper()
	f.clearSteps()
	expected.ResultSteps = copyTaskHTTPSlice(expected.ResultSteps)
	document := stepHTTPDocument(f.t, expected.ResultHeader, expected.ResultSteps)
	plan := newHTTPCallPlan(f.t, map[string]int{"write": 1})
	check := func(ctx context.Context, actor model.Principal, project, task, id string, input, want any) (taskservice.StepsWriteResult, error) {
		f.requireStepOperation(ctx, actor, project, task)
		plan.Called("write")
		if id != expected.ID || !reflect.DeepEqual(input, want) {
			f.t.Errorf("Step direct arguments: id=%q input=%#v, want id=%q input=%#v", id, input, expected.ID, want)
			panic("Step direct arguments changed")
		}
		if expected.Stale {
			return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: "version_conflict", Message: "Task version changed."}
		}
		if expected.Refused {
			return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: "not_found", Message: "Step not found."}
		}
		return taskservice.StepsWriteResult{StepsDocument: copyStepHTTPDocument(document), Changed: true, Phase: "persist", TransactionOutcome: store.TransactionCommitted}, nil
	}
	switch {
	case expected.Add != nil:
		want := *expected.Add
		want.Status = copyTaskHTTPPointer(want.Status)
		want.Before = copyTaskHTTPPointer(want.Before)
		want.After = copyTaskHTTPPointer(want.After)
		f.steps.AddCall = func(ctx context.Context, actor model.Principal, project, task string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
			return check(ctx, actor, project, task, "", input, want)
		}
	case expected.Update != nil:
		want := *expected.Update
		want.Title = copyTaskHTTPPointer(want.Title)
		want.Description = copyTaskHTTPPointer(want.Description)
		f.steps.UpdateCall = func(ctx context.Context, actor model.Principal, project, task, id string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
			return check(ctx, actor, project, task, id, input, want)
		}
	case expected.Status != nil:
		want := *expected.Status
		f.steps.SetStatusCall = func(ctx context.Context, actor model.Principal, project, task, id string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
			return check(ctx, actor, project, task, id, input, want)
		}
	case expected.Delete != nil:
		want := *expected.Delete
		f.steps.DeleteCall = func(ctx context.Context, actor model.Principal, project, task, id string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
			return check(ctx, actor, project, task, id, input, want)
		}
	case expected.Move != nil:
		want := *expected.Move
		want.Before = copyTaskHTTPPointer(want.Before)
		want.After = copyTaskHTTPPointer(want.After)
		want.Position = copyTaskHTTPPointer(want.Position)
		f.steps.MoveCall = func(ctx context.Context, actor model.Principal, project, task, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
			return check(ctx, actor, project, task, id, input, want)
		}
	default:
		f.t.Fatal("Step write requires one explicit direct input")
	}
}

func (f *stepHTTPFixture) expectStepAccessError(write bool) {
	f.clearSteps()
	plan := newHTTPCallPlan(f.t, map[string]int{"operation": 1})
	reject := func(ctx context.Context, actor model.Principal, project, task string) error {
		f.requireStepOperation(ctx, actor, project, task)
		plan.Called("operation")
		return &model.Fault{Code: "not_found", Message: "Step not found."}
	}
	refusal := taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
	if write {
		f.steps.AddCall = func(ctx context.Context, a model.Principal, p, t string, _ taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
			return refusal, reject(ctx, a, p, t)
		}
		f.steps.UpdateCall = func(ctx context.Context, a model.Principal, p, t, _ string, _ taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
			return refusal, reject(ctx, a, p, t)
		}
		f.steps.SetStatusCall = func(ctx context.Context, a model.Principal, p, t, _ string, _ taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
			return refusal, reject(ctx, a, p, t)
		}
		f.steps.DeleteCall = func(ctx context.Context, a model.Principal, p, t, _ string, _ taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
			return refusal, reject(ctx, a, p, t)
		}
		f.steps.MoveCall = func(ctx context.Context, a model.Principal, p, t, _ string, _ taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
			return refusal, reject(ctx, a, p, t)
		}
	} else {
		f.steps.ListCall = func(ctx context.Context, a model.Principal, p, t string) (taskservice.StepsDocument, error) {
			return taskservice.StepsDocument{}, reject(ctx, a, p, t)
		}
		f.steps.GetCall = func(ctx context.Context, a model.Principal, p, t, _ string) (taskservice.StepDocument, error) {
			return taskservice.StepDocument{}, reject(ctx, a, p, t)
		}
	}
}

func (f *stepHTTPFixture) authenticatedRequest(actor model.Principal, method, path, body, origin string, status int, code string) *httptest.ResponseRecorder {
	f.t.Helper()
	f.principal = actor
	f.handler.principal = actor
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

type stepHTTPAttachments struct {
	t               *testing.T
	ListCall        func(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	PutRetainedCall func(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error)
	DeleteCall      func(context.Context, model.Principal, string, string, string) error
	OpenCall        func(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error)
}

func (s *stepHTTPAttachments) List(c context.Context, a model.Principal, p, t string, q model.PageRequest) (attachmentcore.Page, error) {
	if s.ListCall == nil {
		unexpectedHTTPCall(s.t, "Attachments.List")
	}
	return s.ListCall(c, a, p, t, q)
}
func (s *stepHTTPAttachments) PutRetained(c context.Context, a model.Principal, p, t, path, mime string, r io.Reader) (model.Attachment, bool, io.Closer, error) {
	if s.PutRetainedCall == nil {
		unexpectedHTTPCall(s.t, "Attachments.PutRetained")
	}
	return s.PutRetainedCall(c, a, p, t, path, mime, r)
}
func (s *stepHTTPAttachments) Delete(c context.Context, a model.Principal, p, t, path string) error {
	if s.DeleteCall == nil {
		unexpectedHTTPCall(s.t, "Attachments.Delete")
	}
	return s.DeleteCall(c, a, p, t, path)
}
func (s *stepHTTPAttachments) Open(c context.Context, a model.Principal, p, t, path string) (model.Attachment, filestorage.Object, error) {
	if s.OpenCall == nil {
		unexpectedHTTPCall(s.t, "Attachments.Open")
	}
	return s.OpenCall(c, a, p, t, path)
}

func (f *stepHTTPFixture) referencedAttachment(path, contentType string, content []byte) model.Attachment {
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
func (f *stepHTTPFixture) expectAttachmentRead(item model.Attachment) {
	plan := newHTTPCallPlan(f.t, map[string]int{"attachment": 1})
	require := func(ctx context.Context, actor model.Principal, project, task string) {
		f.requireStepOperation(ctx, actor, project, task)
		plan.Called("attachment")
	}
	f.attachments.ListCall = func(ctx context.Context, actor model.Principal, project, task string, input model.PageRequest) (attachmentcore.Page, error) {
		require(ctx, actor, project, task)
		if !reflect.DeepEqual(input, model.PageRequest{Limit: 50}) {
			unexpectedHTTPCall(f.t, "Attachment list input")
		}
		return attachmentcore.Page{Items: []model.Attachment{item}}, nil
	}
	f.attachments.OpenCall = func(ctx context.Context, actor model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
		require(ctx, actor, project, task)
		if path != item.Path {
			unexpectedHTTPCall(f.t, "Attachment path")
		}
		address, err := attachmentcore.NewAddress(project, task, path)
		if err != nil {
			return model.Attachment{}, filestorage.Object{}, err
		}
		object, err := f.files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
		return item, object, err
	}
}
