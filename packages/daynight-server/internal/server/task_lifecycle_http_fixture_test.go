package server

import (
	"bytes"
	"context"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type stepHTTPFixture struct {
	*taskHTTPFixture
	files    *local.Storage
	role     model.ProjectRole
	server   *httptest.Server
	wireMu   sync.Mutex
	wireDone chan struct{}
}

func stepsHTTPFixture(t *testing.T, logs io.Writer) (*stepHTTPFixture, *resourceTestHandler, api.Task) {
	t.Helper()
	project, target, principal := taskHTTPMockModels()
	files := attachmentTestFiles(t)
	f := &stepHTTPFixture{taskHTTPFixture: &taskHTTPFixture{t: t, store: newHTTPTestStore(t), project: project, target: target, principal: principal, observed: target.UpdatedAt.Add(time.Minute)}, files: files, role: model.ProjectAdmin}
	f.handler = resourceTestServer(t, f.store, files, logs)
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

func (f *stepHTTPFixture) expectStepsRead(header model.TaskHeader, steps []model.TaskStep) {
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

func (f *stepHTTPFixture) expectMissingStep(header model.TaskHeader, id string) {
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

func (f *stepHTTPFixture) expectStepsWrite(expected stepHTTPWritePlan) {
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

func (f *stepHTTPFixture) expectStepAccessError(write bool) {
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

func (f *stepHTTPFixture) authenticatedRequest(actor model.Principal, method, path, body, origin string, status int, code string) *httptest.ResponseRecorder {
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
		f.store.WriteIdentityCall = newHTTPTestStoreForPrincipal(f.t, actor).WriteIdentityCall
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
	expected := store.AttachmentQuery{Limit: 1, MaxPathBytes: attachmentcore.MaxMetadataPageResponseJSONBytes, MaxFieldBytes: attachmentcore.MaxMetadataPageResponseJSONBytes}
	if project != d.item.ProjectID || task != d.item.TaskID || !reflect.DeepEqual(query, expected) || ctx.Err() != nil {
		unexpectedHTTPCall(d.t, "referenced attachment page")
	}
	return store.AttachmentPage{Items: []model.Attachment{d.item}}, nil
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

func (f *stepHTTPFixture) stepReadRole(projects *taskHTTPProjectReaderMock, plan *httpCallPlan) {
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
