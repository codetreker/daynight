package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/google/uuid"
)

func attachmentTestFiles(t *testing.T) *local.Storage {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return files
}

func attachmentRequest(handler http.Handler, method, target, contentType string, content []byte) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, bytes.NewReader(content))
	authorizeResourceRequest(handler, request)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func attachmentFilePath(task api.Task, file string) string {
	segments := strings.Split(file, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return taskPath(task) + "/attachments/files/" + strings.Join(segments, "/")
}

type attachmentFailingBody struct {
	data     []byte
	readErr  error
	closeErr error
	closed   bool
	cancel   context.CancelFunc
}

func (r *attachmentFailingBody) Read(buffer []byte) (int, error) {
	if r.cancel != nil {
		r.cancel()
	}
	count := copy(buffer, r.data)
	r.data = r.data[count:]
	if len(r.data) == 0 {
		if r.readErr != nil {
			return count, r.readErr
		}
		return count, io.EOF
	}
	return count, nil
}

func (r *attachmentFailingBody) Close() error {
	r.closed = true
	return r.closeErr
}

func taskCollection(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }

func taskPath(task api.Task) string { return taskCollection(task.ProjectID) + "/" + task.ID }

func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }

const taskHTTPEpoch = "88888888-8888-4888-8888-888888888888"

func copyTaskHTTPPointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func copyTaskHTTPSlice[T any](values []T) []T {
	if values == nil {
		return nil
	}
	result := make([]T, len(values))
	copy(result, values)
	return result
}

func copyTaskHTTPProperties(values model.TaskProperties) model.TaskProperties {
	if values == nil {
		return nil
	}
	result := make(model.TaskProperties, len(values))
	for name, raw := range values {
		result[name] = copyTaskHTTPSlice(raw)
	}
	return result
}

func copyTaskHTTPTask(row model.Task) model.Task {
	row.Properties = copyTaskHTTPProperties(row.Properties)
	row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
	row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
	row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
	row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
	row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
	row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
	row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
	row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	return row
}

func copyTaskHTTPRows(rows []model.Task) []model.Task {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		result[index] = copyTaskHTTPTask(rows[index])
	}
	return result
}

func copyTaskHTTPGraphRows(rows []model.GraphTask) []model.GraphTask {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.BlockedBy = copyTaskHTTPSlice(row.BlockedBy)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

type taskHTTPFixture struct {
	t         *testing.T
	store     *httpTestStore
	handler   *resourceTestHandler
	project   model.Project
	target    model.Task
	principal model.Principal
	observed  time.Time
	ctx       context.Context
	active    bool
}

func newTaskHTTPFixture(t *testing.T) *taskHTTPFixture {
	return newTaskHTTPFixtureForPrincipal(t, defaultHTTPPrincipal())
}

func newTaskHTTPFixtureForPrincipal(t *testing.T, principal model.Principal) *taskHTTPFixture {
	t.Helper()
	project, target, _ := taskHTTPMockModels()
	f := &taskHTTPFixture{t: t, store: newHTTPTestStoreForPrincipal(t, principal), project: project, target: target, principal: principal, observed: project.UpdatedAt.Add(time.Minute)}
	f.handler = resourceTestServerForPrincipal(t, f.store, attachmentTestFiles(t), io.Discard, principal)
	return f
}

func (f *taskHTTPFixture) require(ctx context.Context, projectID string) {
	f.t.Helper()
	if !f.active || ctx != f.ctx || projectID != f.project.ID {
		f.t.Errorf("DAO context, scope or Project changed: active=%t, project=%q", f.active, projectID)
		panic("invalid Task HTTP DAO scope")
	}
}

func (f *taskHTTPFixture) expectSnapshot(want map[string]int, configure func(*taskHTTPReaderMock, *taskHTTPProjectReaderMock, *taskHTTPSessionReaderMock, *taskHTTPSnapshotScopeMock, *httpCallPlan)) {
	f.t.Helper()
	counts := make(map[string]int, len(want)+2)
	for name, count := range want {
		counts[name] = count
	}
	counts["snapshot"], counts["access"] = 1, 1
	plan := newHTTPCallPlan(f.t, counts)
	base := newTaskHTTPMockBase(f.t, "Task HTTP snapshot")
	reader := &taskHTTPReaderMock{taskHTTPMockBase: base.withLabel("tasks")}
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: base.withLabel("projects")}
	sessions := &taskHTTPSessionReaderMock{taskHTTPMockBase: base.withLabel("sessions")}
	scope := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base.withLabel("scope")}
	projects.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		f.require(ctx, id)
		plan.Called("access")
		if principal != f.principal {
			unexpectedHTTPCall(f.t, "ProjectAccess principal")
		}
		return taskHTTPMockAccess(f.project, principal), nil
	}
	if counts["project"] != 0 {
		projects.ProjectFn = func(ctx context.Context, id string) (model.Project, error) {
			f.require(ctx, id)
			plan.Called("project")
			return f.project, nil
		}
	}
	if counts["observed"] != 0 {
		scope.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			f.require(ctx, f.project.ID)
			plan.Called("observed")
			return f.observed, nil
		}
	}
	scope.ProjectDAOFn = func() store.ProjectReader { return projects }
	scope.TaskDAOFn = func() store.TaskReader { return reader }
	scope.SessionDAOFn = func() store.SessionReader { return sessions }
	configure(reader, projects, sessions, scope, plan)
	f.store.ReadSnapshotCall = func(ctx context.Context, run func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		if run == nil || f.active {
			unexpectedHTTPCall(f.t, "snapshot callback")
		}
		f.ctx, f.active = ctx, true
		defer func() { f.active = false }()
		return run(scope)
	}
}

func (f *taskHTTPFixture) expectRead(target model.Task) {
	f.t.Helper()
	target = copyTaskHTTPTask(target)
	f.expectSnapshot(map[string]int{"task": 1, "epoch": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		reader.TaskFn = func(ctx context.Context, projectID, id string) (model.Task, error) {
			f.require(ctx, projectID)
			plan.Called("task")
			if id != target.ID {
				unexpectedHTTPCall(f.t, "Task identity")
			}
			return copyTaskHTTPTask(target), nil
		}
		reader.TaskCacheEpochFn = func(ctx context.Context, projectID string) (string, error) {
			f.require(ctx, projectID)
			plan.Called("epoch")
			return taskHTTPEpoch, nil
		}
	})
}

func (f *taskHTTPFixture) expectList(want []store.TaskQuery, pages []store.TaskPage) {
	f.t.Helper()
	if len(want) != len(pages) || len(want) == 0 {
		f.t.Fatal("a Task HTTP page requires an explicit query and result for every DAO read")
	}
	want = copyTaskHTTPSlice(want)
	pages = copyTaskHTTPSlice(pages)
	for index := range want {
		query := &want[index]
		query.TagFilter.TagIDs = append([]string{}, query.TagFilter.TagIDs...)
		if query.TagFilter.TagMatch == "" {
			query.TagFilter.TagMatch = "all"
		}
		query.Page.After = copyTaskHTTPPointer(query.Page.After)
		query.Status = copyTaskHTTPPointer(query.Status)
		query.Ready = copyTaskHTTPPointer(query.Ready)
		query.AllowAgents = copyTaskHTTPPointer(query.AllowAgents)
		query.CompatiblePlatform = copyTaskHTTPPointer(query.CompatiblePlatform)
		query.Worker = copyTaskHTTPPointer(query.Worker)
		pages[index].Items = copyTaskHTTPRows(pages[index].Items)
	}
	f.expectSnapshot(map[string]int{"tasks": len(want)}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		index := 0
		reader.TasksFn = func(ctx context.Context, projectID string, query store.TaskQuery) (store.TaskPage, error) {
			f.require(ctx, projectID)
			plan.Called("tasks")
			if index >= len(want) || !reflect.DeepEqual(query, want[index]) {
				f.t.Errorf("Task query %d: got %#v, want %#v", index, query, want)
				panic("unexpected Task HTTP page query")
			}
			result := pages[index]
			result.Items = copyTaskHTTPRows(result.Items)
			index++
			return result, nil
		}
	})
}

func (f *taskHTTPFixture) expectGraph(root string, rows []model.GraphTask) {
	f.t.Helper()
	rows = copyTaskHTTPGraphRows(rows)
	f.expectSnapshot(map[string]int{"project": 1, "presence": 1, "graph": 1, "observed": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, _ *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
		reader.TaskPresenceFn = func(ctx context.Context, projectID, id string) (store.TaskPresence, error) {
			f.require(ctx, projectID)
			plan.Called("presence")
			if id != root {
				unexpectedHTTPCall(f.t, "Graph root identity")
			}
			return store.TaskPresence{Found: true}, nil
		}
		reader.TaskGraphTasksFn = func(ctx context.Context, projectID, id string, got store.TaskGraphSelection, preview int) ([]model.GraphTask, error) {
			f.require(ctx, projectID)
			plan.Called("graph")
			if id != root || got != selection || preview != projection.TitlePreviewCharacters {
				unexpectedHTTPCall(f.t, "Graph projection arguments")
			}
			return copyTaskHTTPGraphRows(rows), nil
		}
	})
}

func graphPath(projectID, taskID string) string {
	return "/api/v1/projects/" + projectID + "/task-graph?taskId=" + taskID
}

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func rawProperty(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func apiWorker(t *testing.T, properties api.TaskProperties) *api.WorkerClaim {
	t.Helper()
	raw, exists := properties["worker"]
	if !exists {
		return nil
	}
	var value *api.WorkerClaim
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		t.Fatalf("invalid worker property: %s: %v", raw, err)
	}
	return value
}

func extendedWorkerTestHandler(handler *resourceTestHandler) {
	original := handler.Handler
	handler.Handler = http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		request.Header.Set("Daynight-Worker-Protocol", "2")
		original.ServeHTTP(w, request)
	})
}

type taskHTTPMockTrace struct {
	mu    sync.Mutex
	calls []string
}

func (trace *taskHTTPMockTrace) add(call string) {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	trace.calls = append(trace.calls, call)
}

func (trace *taskHTTPMockTrace) snapshot() []string {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	return append([]string(nil), trace.calls...)
}

type taskHTTPMockBase struct {
	t     *testing.T
	trace *taskHTTPMockTrace
	label string
}

func newTaskHTTPMockBase(t *testing.T, label string) taskHTTPMockBase {
	t.Helper()
	return taskHTTPMockBase{t: t, trace: &taskHTTPMockTrace{}, label: label}
}

func (base taskHTTPMockBase) withLabel(label string) taskHTTPMockBase {
	base.label = label
	return base
}

func (base taskHTTPMockBase) need(method string, configured bool) {
	base.t.Helper()
	name := base.label + "." + method
	base.trace.add(name)
	if !configured {
		base.t.Errorf("unexpected DAO call %s", name)
		panic(fmt.Sprintf("unexpected DAO call %s", name))
	}
}

type taskHTTPSnapshotScopeMock struct {
	taskHTTPMockBase
	CredentialDAOFn func() store.CredentialReader
	TeamDAOFn       func() store.TeamReader
	ProjectDAOFn    func() store.ProjectReader
	TaskDAOFn       func() store.TaskReader
	WorkerDAOFn     func() store.WorkerReader
	SessionDAOFn    func() store.SessionReader
	BotDAOFn        func() store.BotReader
	AttachmentDAOFn func() store.AttachmentReader
	ObservedAtFn    func(context.Context) (time.Time, error)
}

func (mock *taskHTTPSnapshotScopeMock) CredentialDAO() store.CredentialReader {
	mock.need("CredentialDAO", mock.CredentialDAOFn != nil)
	return mock.CredentialDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) TeamDAO() store.TeamReader {
	mock.need("TeamDAO", mock.TeamDAOFn != nil)
	return mock.TeamDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) ProjectDAO() store.ProjectReader {
	mock.need("ProjectDAO", mock.ProjectDAOFn != nil)
	return mock.ProjectDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) TaskDAO() store.TaskReader {
	mock.need("TaskDAO", mock.TaskDAOFn != nil)
	return mock.TaskDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) WorkerDAO() store.WorkerReader {
	mock.need("WorkerDAO", mock.WorkerDAOFn != nil)
	return mock.WorkerDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) SessionDAO() store.SessionReader {
	mock.need("SessionDAO", mock.SessionDAOFn != nil)
	return mock.SessionDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) BotDAO() store.BotReader {
	mock.need("BotDAO", mock.BotDAOFn != nil)
	return mock.BotDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) AttachmentDAO() store.AttachmentReader {
	mock.need("AttachmentDAO", mock.AttachmentDAOFn != nil)
	return mock.AttachmentDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) ObservedAt(p0 context.Context) (time.Time, error) {
	mock.need("ObservedAt", mock.ObservedAtFn != nil)
	return mock.ObservedAtFn(p0)
}

var _ store.SnapshotScope = (*taskHTTPSnapshotScopeMock)(nil)

type taskHTTPProjectScopeMock struct {
	taskHTTPMockBase
	EligibilityDAOFn func() store.WebhookEligibilityDAO
	CaptureDAOFn     func() store.WebhookCaptureDAO
	ProjectDAOFn     func() store.ProjectWriteDAO
	TaskDAOFn        func() store.TaskWriteDAO
	SessionDAOFn     func() store.ProjectSessionDAO
}

func (mock *taskHTTPProjectScopeMock) EligibilityDAO() store.WebhookEligibilityDAO {
	mock.need("EligibilityDAO", mock.EligibilityDAOFn != nil)
	return mock.EligibilityDAOFn()
}

func (mock *taskHTTPProjectScopeMock) CaptureDAO() store.WebhookCaptureDAO {
	mock.need("CaptureDAO", mock.CaptureDAOFn != nil)
	return mock.CaptureDAOFn()
}

func (mock *taskHTTPProjectScopeMock) ProjectDAO() store.ProjectWriteDAO {
	mock.need("ProjectDAO", mock.ProjectDAOFn != nil)
	return mock.ProjectDAOFn()
}

func (mock *taskHTTPProjectScopeMock) TaskDAO() store.TaskWriteDAO {
	mock.need("TaskDAO", mock.TaskDAOFn != nil)
	return mock.TaskDAOFn()
}

func (mock *taskHTTPProjectScopeMock) SessionDAO() store.ProjectSessionDAO {
	mock.need("SessionDAO", mock.SessionDAOFn != nil)
	return mock.SessionDAOFn()
}

var _ store.ProjectWriteScope = (*taskHTTPProjectScopeMock)(nil)

type taskHTTPReaderMock struct {
	taskHTTPMockBase
	TaskFn                     func(context.Context, string, string) (model.Task, error)
	TaskBodiesFn               func(context.Context, string, []string) ([]model.Task, error)
	GoalProgressesFn           func(context.Context, string, []string) (map[string]model.GoalProgress, error)
	TasksFn                    func(context.Context, string, store.TaskQuery) (store.TaskPage, error)
	TaskListFenceFn            func(context.Context, string) (store.TaskListFence, error)
	TaskPriorityListFn         func(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error)
	TaskPresenceFn             func(context.Context, string, string) (store.TaskPresence, error)
	TaskHeaderFn               func(context.Context, string, string) (model.TaskHeader, error)
	TaskStepFn                 func(context.Context, string, string) (model.TaskStep, error)
	TaskStepsFn                func(context.Context, string) ([]model.TaskStep, error)
	TaskStepPageFn             func(context.Context, string, int64, int, bool) ([]store.TaskStepProjection, error)
	TaskStepSummaryFn          func(context.Context, string, string) (store.TaskStepProjection, error)
	ThreadMessageFn            func(context.Context, string, string) (model.ThreadMessage, error)
	ThreadCandidatesFn         func(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSidesFn              func(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
	TaskAssigneesFn            func(context.Context, string) ([]model.TaskAssigneeFact, error)
	ResolveTaskAssigneesFn     func(context.Context, string, []string) ([]model.TaskAssigneeFact, error)
	TaskGraphTasksFn           func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
	TaskCacheEpochFn           func(context.Context, string) (string, error)
	TaskSyncTasksFn            func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	TaskSyncDependencyStatesFn func(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
}

func (mock *taskHTTPReaderMock) TaskBodies(ctx context.Context, project string, ids []string) ([]model.Task, error) {
	mock.need("TaskBodies", mock.TaskBodiesFn != nil)
	return mock.TaskBodiesFn(ctx, project, ids)
}
func (mock *taskHTTPReaderMock) GoalProgresses(ctx context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
	mock.need("GoalProgresses", mock.GoalProgressesFn != nil)
	return mock.GoalProgressesFn(ctx, project, ids)
}
func (mock *taskHTTPReaderMock) Task(p0 context.Context, p1 string, p2 string) (model.Task, error) {
	mock.need("Task", mock.TaskFn != nil)
	return mock.TaskFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) Tasks(p0 context.Context, p1 string, p2 store.TaskQuery) (store.TaskPage, error) {
	mock.need("Tasks", mock.TasksFn != nil)
	return mock.TasksFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskListFence(p0 context.Context, p1 string) (store.TaskListFence, error) {
	mock.need("TaskListFence", mock.TaskListFenceFn != nil)
	return mock.TaskListFenceFn(p0, p1)
}

func (mock *taskHTTPReaderMock) TaskPriorityList(p0 context.Context, p1 string, p2 store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	mock.need("TaskPriorityList", mock.TaskPriorityListFn != nil)
	return mock.TaskPriorityListFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskPresence(p0 context.Context, p1 string, p2 string) (store.TaskPresence, error) {
	mock.need("TaskPresence", mock.TaskPresenceFn != nil)
	return mock.TaskPresenceFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskHeader(p0 context.Context, p1 string, p2 string) (model.TaskHeader, error) {
	mock.need("TaskHeader", mock.TaskHeaderFn != nil)
	return mock.TaskHeaderFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskStep(p0 context.Context, p1 string, p2 string) (model.TaskStep, error) {
	mock.need("TaskStep", mock.TaskStepFn != nil)
	return mock.TaskStepFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskSteps(p0 context.Context, p1 string) ([]model.TaskStep, error) {
	mock.need("TaskSteps", mock.TaskStepsFn != nil)
	return mock.TaskStepsFn(p0, p1)
}

func (mock *taskHTTPReaderMock) TaskStepPage(p0 context.Context, p1 string, p2 int64, p3 int, p4 bool) ([]store.TaskStepProjection, error) {
	mock.need("TaskStepPage", mock.TaskStepPageFn != nil)
	return mock.TaskStepPageFn(p0, p1, p2, p3, p4)
}

func (mock *taskHTTPReaderMock) TaskStepSummary(p0 context.Context, p1 string, p2 string) (store.TaskStepProjection, error) {
	mock.need("TaskStepSummary", mock.TaskStepSummaryFn != nil)
	return mock.TaskStepSummaryFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) ThreadMessage(p0 context.Context, p1 string, p2 string) (model.ThreadMessage, error) {
	mock.need("ThreadMessage", mock.ThreadMessageFn != nil)
	return mock.ThreadMessageFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) ThreadCandidates(p0 context.Context, p1 string, p2 *model.ThreadPosition, p3 bool, p4 int) ([]model.ThreadMessage, error) {
	mock.need("ThreadCandidates", mock.ThreadCandidatesFn != nil)
	return mock.ThreadCandidatesFn(p0, p1, p2, p3, p4)
}

func (mock *taskHTTPReaderMock) ThreadSides(p0 context.Context, p1 string, p2 model.ThreadPosition, p3 model.ThreadPosition) (bool, bool, error) {
	mock.need("ThreadSides", mock.ThreadSidesFn != nil)
	return mock.ThreadSidesFn(p0, p1, p2, p3)
}

func (mock *taskHTTPReaderMock) TaskAssignees(p0 context.Context, p1 string) ([]model.TaskAssigneeFact, error) {
	mock.need("TaskAssignees", mock.TaskAssigneesFn != nil)
	return mock.TaskAssigneesFn(p0, p1)
}

func (mock *taskHTTPReaderMock) ResolveTaskAssignees(p0 context.Context, p1 string, p2 []string) ([]model.TaskAssigneeFact, error) {
	mock.need("ResolveTaskAssignees", mock.ResolveTaskAssigneesFn != nil)
	return mock.ResolveTaskAssigneesFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskGraphTasks(p0 context.Context, p1 string, p2 string, p3 store.TaskGraphSelection, p4 int) ([]model.GraphTask, error) {
	mock.need("TaskGraphTasks", mock.TaskGraphTasksFn != nil)
	return mock.TaskGraphTasksFn(p0, p1, p2, p3, p4)
}

func (mock *taskHTTPReaderMock) TaskCacheEpoch(p0 context.Context, p1 string) (string, error) {
	mock.need("TaskCacheEpoch", mock.TaskCacheEpochFn != nil)
	return mock.TaskCacheEpochFn(p0, p1)
}

func (mock *taskHTTPReaderMock) TaskSyncTasks(p0 context.Context, p1 string, p2 *time.Time, p3 int) ([]model.TaskViewRecord, error) {
	mock.need("TaskSyncTasks", mock.TaskSyncTasksFn != nil)
	return mock.TaskSyncTasksFn(p0, p1, p2, p3)
}

func (mock *taskHTTPReaderMock) TaskSyncDependencyStates(ctx context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
	mock.need("TaskSyncDependencyStates", mock.TaskSyncDependencyStatesFn != nil)
	return mock.TaskSyncDependencyStatesFn(ctx, id, lower)
}

var _ store.TaskReader = (*taskHTTPReaderMock)(nil)

type taskHTTPWriterMock struct {
	ParentTaskFn     func(context.Context, string) (model.Task, error)
	GoalProgressesFn func(context.Context, string, []string) (map[string]model.GoalProgress, error)
	taskHTTPMockBase
	TaskFn               func(context.Context, string) (model.Task, error)
	TasksByIDFn          func(context.Context, []string) ([]model.Task, error)
	VisibleTaskIDsFn     func(context.Context, []string) ([]string, error)
	ActiveDependentIDsFn func(context.Context, string) ([]string, error)
	ReachableFn          func(context.Context, string, string, store.DependencyReplacement) (bool, error)
	CreateTaskFn         func(context.Context, string, store.TaskWrite) (model.Task, error)
	UpdateTaskFn         func(context.Context, string, store.TaskWrite) (model.Task, error)
	ObservedAtFn         func(context.Context) (time.Time, error)
	DependentIDsFn       func(context.Context, string) ([]string, error)
	DeleteTaskFn         func(context.Context, string, bool) (model.TaskTombstone, error)
	TaskHeaderFn         func(context.Context, string) (model.TaskHeader, error)
	TaskStepsFn          func(context.Context, string) ([]model.TaskStep, error)
	InsertTaskStepFn     func(context.Context, string, model.TaskStep) error
	TouchTaskFn          func(context.Context, string, time.Time) error
	UpdateTaskStepFn     func(context.Context, string, model.TaskStep) error
	MoveTaskStepFn       func(context.Context, string, string, int64, int64) error
	DeleteTaskStepFn     func(context.Context, string, string, int64, int64) error
}

func (mock *taskHTTPWriterMock) GoalProgresses(ctx context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
	mock.need("GoalProgresses", mock.GoalProgressesFn != nil)
	return mock.GoalProgressesFn(ctx, project, ids)
}

func (mock *taskHTTPWriterMock) ParentTask(ctx context.Context, id string) (model.Task, error) {
	mock.need("ParentTask", mock.ParentTaskFn != nil)
	return mock.ParentTaskFn(ctx, id)
}

func (mock *taskHTTPWriterMock) Task(p0 context.Context, p1 string) (model.Task, error) {
	mock.need("Task", mock.TaskFn != nil)
	return mock.TaskFn(p0, p1)
}

func (mock *taskHTTPWriterMock) TasksByID(p0 context.Context, p1 []string) ([]model.Task, error) {
	mock.need("TasksByID", mock.TasksByIDFn != nil)
	return mock.TasksByIDFn(p0, p1)
}

func (mock *taskHTTPWriterMock) VisibleTaskIDs(ctx context.Context, ids []string) ([]string, error) {
	mock.need("VisibleTaskIDs", mock.VisibleTaskIDsFn != nil)
	return mock.VisibleTaskIDsFn(ctx, ids)
}

func (mock *taskHTTPWriterMock) ActiveDependentIDs(p0 context.Context, p1 string) ([]string, error) {
	mock.need("ActiveDependentIDs", mock.ActiveDependentIDsFn != nil)
	return mock.ActiveDependentIDsFn(p0, p1)
}

func (mock *taskHTTPWriterMock) Reachable(p0 context.Context, p1 string, p2 string, p3 store.DependencyReplacement) (bool, error) {
	mock.need("Reachable", mock.ReachableFn != nil)
	return mock.ReachableFn(p0, p1, p2, p3)
}

func (mock *taskHTTPWriterMock) CreateTask(p0 context.Context, p1 string, p2 store.TaskWrite) (model.Task, error) {
	mock.need("CreateTask", mock.CreateTaskFn != nil)
	return mock.CreateTaskFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) UpdateTask(p0 context.Context, p1 string, p2 store.TaskWrite) (model.Task, error) {
	mock.need("UpdateTask", mock.UpdateTaskFn != nil)
	return mock.UpdateTaskFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) ObservedAt(p0 context.Context) (time.Time, error) {
	mock.need("ObservedAt", mock.ObservedAtFn != nil)
	return mock.ObservedAtFn(p0)
}

func (mock *taskHTTPWriterMock) DependentIDs(p0 context.Context, p1 string) ([]string, error) {
	mock.need("DependentIDs", mock.DependentIDsFn != nil)
	return mock.DependentIDsFn(p0, p1)
}

func (mock *taskHTTPWriterMock) DeleteTask(p0 context.Context, p1 string, p2 bool) (model.TaskTombstone, error) {
	mock.need("DeleteTask", mock.DeleteTaskFn != nil)
	return mock.DeleteTaskFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) TaskHeader(p0 context.Context, p1 string) (model.TaskHeader, error) {
	mock.need("TaskHeader", mock.TaskHeaderFn != nil)
	return mock.TaskHeaderFn(p0, p1)
}

func (mock *taskHTTPWriterMock) TaskSteps(p0 context.Context, p1 string) ([]model.TaskStep, error) {
	mock.need("TaskSteps", mock.TaskStepsFn != nil)
	return mock.TaskStepsFn(p0, p1)
}

func (mock *taskHTTPWriterMock) InsertTaskStep(p0 context.Context, p1 string, p2 model.TaskStep) error {
	mock.need("InsertTaskStep", mock.InsertTaskStepFn != nil)
	return mock.InsertTaskStepFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) TouchTask(p0 context.Context, p1 string, p2 time.Time) error {
	mock.need("TouchTask", mock.TouchTaskFn != nil)
	return mock.TouchTaskFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) UpdateTaskStep(p0 context.Context, p1 string, p2 model.TaskStep) error {
	mock.need("UpdateTaskStep", mock.UpdateTaskStepFn != nil)
	return mock.UpdateTaskStepFn(p0, p1, p2)
}

func (mock *taskHTTPWriterMock) MoveTaskStep(p0 context.Context, p1 string, p2 string, p3 int64, p4 int64) error {
	mock.need("MoveTaskStep", mock.MoveTaskStepFn != nil)
	return mock.MoveTaskStepFn(p0, p1, p2, p3, p4)
}

func (mock *taskHTTPWriterMock) DeleteTaskStep(p0 context.Context, p1 string, p2 string, p3 int64, p4 int64) error {
	mock.need("DeleteTaskStep", mock.DeleteTaskStepFn != nil)
	return mock.DeleteTaskStepFn(p0, p1, p2, p3, p4)
}

var _ store.TaskWriteDAO = (*taskHTTPWriterMock)(nil)

type taskHTTPProjectReaderMock struct {
	taskHTTPMockBase
	ProjectFn             func(context.Context, string) (model.Project, error)
	ProjectsFn            func(context.Context, store.Page) (store.ProjectPage, error)
	DirectProjectMemberFn func(context.Context, string, string) (model.ProjectMember, error)
	ProjectParticipantsFn func(context.Context, string) ([]model.ProjectParticipant, error)
	InvitationFn          func(context.Context, []byte) (model.ProjectInvitation, error)
	InvitationsFn         func(context.Context, string, time.Time) ([]model.ProjectInvitation, error)
	ProjectAccessFn       func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	AccessibleProjectsFn  func(context.Context, model.Principal, store.Page) (store.ProjectPage, error)
	ScopedProjectsFn      func(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error)
	TransferTeamFn        func(context.Context, string) (store.TransferTeam, error)
	TransferRoleFn        func(context.Context, string, string, string) (*model.ProjectRole, error)
}

func (mock *taskHTTPProjectReaderMock) Project(p0 context.Context, p1 string) (model.Project, error) {
	mock.need("Project", mock.ProjectFn != nil)
	return mock.ProjectFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) Projects(p0 context.Context, p1 store.Page) (store.ProjectPage, error) {
	mock.need("Projects", mock.ProjectsFn != nil)
	return mock.ProjectsFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) DirectProjectMember(p0 context.Context, p1 string, p2 string) (model.ProjectMember, error) {
	mock.need("DirectProjectMember", mock.DirectProjectMemberFn != nil)
	return mock.DirectProjectMemberFn(p0, p1, p2)
}

func (mock *taskHTTPProjectReaderMock) ProjectParticipants(p0 context.Context, p1 string) ([]model.ProjectParticipant, error) {
	mock.need("ProjectParticipants", mock.ProjectParticipantsFn != nil)
	return mock.ProjectParticipantsFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) Invitation(p0 context.Context, p1 []byte) (model.ProjectInvitation, error) {
	mock.need("Invitation", mock.InvitationFn != nil)
	return mock.InvitationFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) Invitations(p0 context.Context, p1 string, p2 time.Time) ([]model.ProjectInvitation, error) {
	mock.need("Invitations", mock.InvitationsFn != nil)
	return mock.InvitationsFn(p0, p1, p2)
}

func (mock *taskHTTPProjectReaderMock) ProjectAccess(p0 context.Context, p1 model.Principal, p2 string) (model.ProjectAccess, error) {
	mock.need("ProjectAccess", mock.ProjectAccessFn != nil)
	return mock.ProjectAccessFn(p0, p1, p2)
}

func (mock *taskHTTPProjectReaderMock) AccessibleProjects(p0 context.Context, p1 model.Principal, p2 store.Page) (store.ProjectPage, error) {
	mock.need("AccessibleProjects", mock.AccessibleProjectsFn != nil)
	return mock.AccessibleProjectsFn(p0, p1, p2)
}

func (mock *taskHTTPProjectReaderMock) ScopedProjects(p0 context.Context, p1 model.Principal, p2 store.ProjectScope, p3 store.Page) (store.ProjectPage, error) {
	mock.need("ScopedProjects", mock.ScopedProjectsFn != nil)
	return mock.ScopedProjectsFn(p0, p1, p2, p3)
}

func (mock *taskHTTPProjectReaderMock) TransferTeam(p0 context.Context, p1 string) (store.TransferTeam, error) {
	mock.need("TransferTeam", mock.TransferTeamFn != nil)
	return mock.TransferTeamFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) TransferRole(p0 context.Context, p1 string, p2 string, p3 string) (*model.ProjectRole, error) {
	mock.need("TransferRole", mock.TransferRoleFn != nil)
	return mock.TransferRoleFn(p0, p1, p2, p3)
}

var _ store.ProjectReader = (*taskHTTPProjectReaderMock)(nil)

type taskHTTPProjectWriterMock struct {
	taskHTTPMockBase
	InvalidateTaskCacheFn   func(context.Context) error
	ProjectFn               func(context.Context) (model.Project, error)
	ProjectAccessFn         func(context.Context, model.Principal) (model.ProjectAccess, error)
	UpdateProjectSettingsFn func(context.Context, int32) (model.Project, error)
	DirectProjectMemberFn   func(context.Context, string) (model.ProjectMember, error)
	SetMemberRoleFn         func(context.Context, string, model.ProjectRole) (model.ProjectMember, error)
	RemoveMemberFn          func(context.Context, string) error
	AddInvitedMemberFn      func(context.Context, string) (model.ProjectMember, error)
	LockInvitationFn        func(context.Context, []byte) (model.ProjectInvitation, error)
	CreateInvitationFn      func(context.Context, model.ProjectInvitation) error
	RevokeInvitationFn      func(context.Context, string, time.Time) error
	ConsumeInvitationFn     func(context.Context, string, string, time.Time) error
	DirectGrantFn           func(context.Context, string) (model.ProjectGrant, error)
	CreateGrantFn           func(context.Context, string, model.ProjectRole) (model.ProjectGrant, error)
	LockTransferOwnershipFn func(context.Context) (model.ProjectOwnership, error)
	LockTransferTeamsFn     func(context.Context, string, string) (store.TransferTeam, store.TransferTeam, error)
	MoveOwnershipFn         func(context.Context, string) (model.ProjectOwnership, error)
}

func (mock *taskHTTPProjectWriterMock) InvalidateTaskCache(p0 context.Context) error {
	mock.need("InvalidateTaskCache", mock.InvalidateTaskCacheFn != nil)
	return mock.InvalidateTaskCacheFn(p0)
}

func (mock *taskHTTPProjectWriterMock) Project(p0 context.Context) (model.Project, error) {
	mock.need("Project", mock.ProjectFn != nil)
	return mock.ProjectFn(p0)
}

func (mock *taskHTTPProjectWriterMock) ProjectAccess(p0 context.Context, p1 model.Principal) (model.ProjectAccess, error) {
	mock.need("ProjectAccess", mock.ProjectAccessFn != nil)
	return mock.ProjectAccessFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) UpdateProjectSettings(p0 context.Context, p1 int32) (model.Project, error) {
	mock.need("UpdateProjectSettings", mock.UpdateProjectSettingsFn != nil)
	return mock.UpdateProjectSettingsFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) DirectProjectMember(p0 context.Context, p1 string) (model.ProjectMember, error) {
	mock.need("DirectProjectMember", mock.DirectProjectMemberFn != nil)
	return mock.DirectProjectMemberFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) SetMemberRole(p0 context.Context, p1 string, p2 model.ProjectRole) (model.ProjectMember, error) {
	mock.need("SetMemberRole", mock.SetMemberRoleFn != nil)
	return mock.SetMemberRoleFn(p0, p1, p2)
}

func (mock *taskHTTPProjectWriterMock) RemoveMember(p0 context.Context, p1 string) error {
	mock.need("RemoveMember", mock.RemoveMemberFn != nil)
	return mock.RemoveMemberFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) AddInvitedMember(p0 context.Context, p1 string) (model.ProjectMember, error) {
	mock.need("AddInvitedMember", mock.AddInvitedMemberFn != nil)
	return mock.AddInvitedMemberFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) LockInvitation(p0 context.Context, p1 []byte) (model.ProjectInvitation, error) {
	mock.need("LockInvitation", mock.LockInvitationFn != nil)
	return mock.LockInvitationFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) CreateInvitation(p0 context.Context, p1 model.ProjectInvitation) error {
	mock.need("CreateInvitation", mock.CreateInvitationFn != nil)
	return mock.CreateInvitationFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) RevokeInvitation(p0 context.Context, p1 string, p2 time.Time) error {
	mock.need("RevokeInvitation", mock.RevokeInvitationFn != nil)
	return mock.RevokeInvitationFn(p0, p1, p2)
}

func (mock *taskHTTPProjectWriterMock) ConsumeInvitation(p0 context.Context, p1 string, p2 string, p3 time.Time) error {
	mock.need("ConsumeInvitation", mock.ConsumeInvitationFn != nil)
	return mock.ConsumeInvitationFn(p0, p1, p2, p3)
}

func (mock *taskHTTPProjectWriterMock) DirectGrant(p0 context.Context, p1 string) (model.ProjectGrant, error) {
	mock.need("DirectGrant", mock.DirectGrantFn != nil)
	return mock.DirectGrantFn(p0, p1)
}

func (mock *taskHTTPProjectWriterMock) CreateGrant(p0 context.Context, p1 string, p2 model.ProjectRole) (model.ProjectGrant, error) {
	mock.need("CreateGrant", mock.CreateGrantFn != nil)
	return mock.CreateGrantFn(p0, p1, p2)
}

func (mock *taskHTTPProjectWriterMock) LockTransferOwnership(p0 context.Context) (model.ProjectOwnership, error) {
	mock.need("LockTransferOwnership", mock.LockTransferOwnershipFn != nil)
	return mock.LockTransferOwnershipFn(p0)
}

func (mock *taskHTTPProjectWriterMock) LockTransferTeams(p0 context.Context, p1 string, p2 string) (store.TransferTeam, store.TransferTeam, error) {
	mock.need("LockTransferTeams", mock.LockTransferTeamsFn != nil)
	return mock.LockTransferTeamsFn(p0, p1, p2)
}

func (mock *taskHTTPProjectWriterMock) MoveOwnership(p0 context.Context, p1 string) (model.ProjectOwnership, error) {
	mock.need("MoveOwnership", mock.MoveOwnershipFn != nil)
	return mock.MoveOwnershipFn(p0, p1)
}

var _ store.ProjectWriteDAO = (*taskHTTPProjectWriterMock)(nil)

type taskHTTPCredentialReaderMock struct {
	taskHTTPMockBase
	CredentialFn func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (mock *taskHTTPCredentialReaderMock) Credential(p0 context.Context, p1 model.Principal) (store.ThreadCredential, error) {
	mock.need("Credential", mock.CredentialFn != nil)
	return mock.CredentialFn(p0, p1)
}

var _ store.CredentialReader = (*taskHTTPCredentialReaderMock)(nil)

type taskHTTPSessionReaderMock struct {
	taskHTTPMockBase
	CurrentTaskSessionSourcesFn func(context.Context, string) ([]store.TaskSessionSource, error)
	TaskSessionSourcesFn        func(context.Context, string, []string) ([]store.TaskSessionSource, error)
}

func (mock *taskHTTPSessionReaderMock) CurrentTaskSessionSources(p0 context.Context, p1 string) ([]store.TaskSessionSource, error) {
	mock.need("CurrentTaskSessionSources", mock.CurrentTaskSessionSourcesFn != nil)
	return mock.CurrentTaskSessionSourcesFn(p0, p1)
}

var _ store.SessionReader = (*taskHTTPSessionReaderMock)(nil)

type taskHTTPProjectSessionMock struct {
	taskHTTPMockBase
	DrainTaskSessionsFn             func(context.Context, string, store.TaskSessionDrain) error
	TransitionTaskSessionReceiptsFn func(context.Context, string, store.TaskSessionReceiptTransition) error
	MatchSessionStartupFn           func(context.Context, string, *model.WorkerClaim, sp.StartupReport) (bool, error)
}

func (mock *taskHTTPProjectSessionMock) DrainTaskSessions(p0 context.Context, p1 string, p2 store.TaskSessionDrain) error {
	mock.need("DrainTaskSessions", mock.DrainTaskSessionsFn != nil)
	return mock.DrainTaskSessionsFn(p0, p1, p2)
}

func (mock *taskHTTPProjectSessionMock) TransitionTaskSessionReceipts(p0 context.Context, p1 string, p2 store.TaskSessionReceiptTransition) error {
	mock.need("TransitionTaskSessionReceipts", mock.TransitionTaskSessionReceiptsFn != nil)
	return mock.TransitionTaskSessionReceiptsFn(p0, p1, p2)
}

func (mock *taskHTTPProjectSessionMock) MatchSessionStartup(p0 context.Context, p1 string, p2 *model.WorkerClaim, p3 sp.StartupReport) (bool, error) {
	mock.need("MatchSessionStartup", mock.MatchSessionStartupFn != nil)
	return mock.MatchSessionStartupFn(p0, p1, p2, p3)
}

var _ store.TaskSessionFreezeDAO = (*taskHTTPProjectSessionMock)(nil)

var _ store.ProjectSessionDAO = (*taskHTTPProjectSessionMock)(nil)

type taskHTTPCaptureDAOMock struct {
	taskHTTPMockBase
	FreezeAudienceFn func(context.Context, string, []string) ([]store.WebhookAudience, error)
	RecordedAtFn     func(context.Context) (time.Time, error)
	PolicyFn         func(context.Context, int64) (webhook.Policy, error)
	SaveCaptureFn    func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error
}

func (mock *taskHTTPCaptureDAOMock) FreezeAudience(p0 context.Context, p1 string, p2 []string) ([]store.WebhookAudience, error) {
	mock.need("FreezeAudience", mock.FreezeAudienceFn != nil)
	return mock.FreezeAudienceFn(p0, p1, p2)
}

func (mock *taskHTTPCaptureDAOMock) RecordedAt(p0 context.Context) (time.Time, error) {
	mock.need("RecordedAt", mock.RecordedAtFn != nil)
	return mock.RecordedAtFn(p0)
}

func (mock *taskHTTPCaptureDAOMock) Policy(p0 context.Context, p1 int64) (webhook.Policy, error) {
	mock.need("Policy", mock.PolicyFn != nil)
	return mock.PolicyFn(p0, p1)
}

func (mock *taskHTTPCaptureDAOMock) SaveCapture(p0 context.Context, p1 store.WebhookCapturedEvent, p2 []store.WebhookCapturedDelivery) error {
	mock.need("SaveCapture", mock.SaveCaptureFn != nil)
	return mock.SaveCaptureFn(p0, p1, p2)
}

var _ store.WebhookCaptureDAO = (*taskHTTPCaptureDAOMock)(nil)

func taskHTTPMockModels() (model.Project, model.Task, model.Principal) {
	observed := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	principal := defaultHTTPPrincipal()
	project := model.Project{ID: "33333333-3333-4333-8333-333333333333", Name: "Project", RepoURL: "https://github.com/example/repository", CreatedAt: observed, UpdatedAt: observed, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}, Ownership: model.ProjectOwnership{TeamID: "44444444-4444-4444-8444-444444444444", Version: 1, UpdatedAt: observed}}
	task := model.Task{ID: "55555555-5555-4555-8555-555555555555", Type: model.TaskTypeTask, ProjectID: project.ID, Title: "Task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: observed, UpdatedAt: observed, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &principal.UserID, Ready: true}
	return project, task, principal
}

func taskHTTPMockAccess(project model.Project, principal model.Principal) model.ProjectAccess {
	return model.ProjectAccess{ProjectID: project.ID, UserID: principal.UserID, Role: model.ProjectAdmin, OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"}, Ownership: project.Ownership}
}

func (mock *taskHTTPReaderMock) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	mock.need("TaskWorkGroups", false)
	panic("unreachable")
}
func (mock *taskHTTPReaderMock) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	mock.need("TaskWorkTargets", false)
	panic("unreachable")
}
func (mock *taskHTTPSessionReaderMock) TaskSessionSources(ctx context.Context, project string, ids []string) ([]store.TaskSessionSource, error) {
	mock.need("TaskSessionSources", mock.TaskSessionSourcesFn != nil)
	return mock.TaskSessionSourcesFn(ctx, project, ids)
}
func (mock *taskHTTPSessionReaderMock) TaskSessionInspectionSource(context.Context, string, string, string) (store.TaskSessionSource, error) {
	mock.need("TaskSessionInspectionSource", false)
	panic("unreachable")
}

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
	expected := store.AttachmentQuery{Limit: 50}
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

type sessionHTTPFixture struct {
	store              *sessionHTTPStore
	mu                 sync.Mutex
	record             store.SessionRecord
	sessionTask        store.SessionTask
	connectionCaptured chan struct{}
	connectionCommit   chan struct{}
	writes             sessionHTTPWrites
	calls              map[string]int
	credentialRevoked  bool
	mediaRecoveryRead  func(context.Context) ([]store.SessionResourceLease, error)
	handler            *resourceTestHandler
	server             *httptest.Server
	application        *sessionApplication
	task               api.Task
	base               string
	registration       sp.Registration
	snapshot           sp.Snapshot
	grant              sessioncore.GrantResult
}

func sessionHTTPSetup(t *testing.T) *sessionHTTPFixture {
	t.Helper()
	return sessionHTTPSetupMode(t, model.AgentControlModeWeb, true)
}

func sessionHTTPSetupMode(t *testing.T, mode model.WorkerAgentControlMode, prepare bool) *sessionHTTPFixture {
	t.Helper()
	f := &sessionHTTPFixture{calls: map[string]int{}}
	f.store = &sessionHTTPStore{httpTestStore: newHTTPTestStore(t), fixture: f}
	f.store.WriteSessionCall = f.store.run
	principal := defaultHTTPPrincipal()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	worker := model.WorkerClaim{ClaimID: uuid.NewString(), State: model.WorkerActive, UserID: principal.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Session test"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: mode, WorktreeID: uuid.NewString(), Phase: model.WorkerExecuting, ClaimedAt: now}
	f.task = api.Task{ID: uuid.NewString(), ProjectID: uuid.NewString(), Title: "Web session", Description: "", Status: "in_progress", AllowAgents: true, CreatedAt: now, UpdatedAt: now, Version: 1, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Properties: map[string]json.RawMessage{}, AssignedTo: &principal.UserID}
	f.task.Properties["worker"] = json.RawMessage(jsonBody(t, api.WorkerClaim{ClaimID: worker.ClaimID, State: "active", UserID: worker.UserID, WorkerID: worker.WorkerID, Machine: api.WorkerMachine{ID: worker.Machine.ID, Name: worker.Machine.Name}, Platform: "linux", Agent: "codex", AgentControlMode: string(mode), WorktreeID: worker.WorktreeID, Phase: "executing", ClaimedAt: now}))
	f.sessionTask = store.SessionTask{Worker: &worker, Status: "in_progress"}
	f.base = taskPath(f.task) + "/sessions"
	f.registration = sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: worker.ClaimID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	f.snapshot = sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{ProjectID: f.task.ProjectID, TaskID: f.task.ID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, AgentControlMode: "web", Provider: "codex"}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: "not_submitted", Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
	f.record = store.SessionRecord{Snapshot: f.snapshot, Owner: principal.UserID, Registration: []byte(jsonBody(t, f.registration))}
	application, err := newTestHandler(Dependencies{Store: f.store, Files: attachmentTestFiles(t)}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	f.application = application.(*sessionApplication)
	f.handler = &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), application), token: defaultHTTPToken(), principal: principal}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := f.application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	extendedWorkerTestHandler(f.handler)
	f.server = httptest.NewServer(httpx.RequestLogging(testLogger(), f.application))
	t.Cleanup(f.server.Close)
	if prepare {
		registered := decodeResponse[struct {
			Session sp.Snapshot `json:"session"`
		}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
		if registered.Session.SessionID != f.snapshot.SessionID || registered.Session.ClaimID != worker.ClaimID {
			t.Fatal("registered Session changed declared identity")
		}
		f.grant = f.mint(t, "bootstrap")
	}

	return f
}
func (f *sessionHTTPFixture) mint(t *testing.T, kind string) sessioncore.GrantResult {
	t.Helper()
	return f.mintGrant(t, sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: f.snapshot.ExecutionGeneration, Kind: kind})
}
func (f *sessionHTTPFixture) mintGrant(t *testing.T, g sp.Grant) sessioncore.GrantResult {
	t.Helper()
	out := decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", jsonBody(t, g)), http.StatusOK)
	f.mu.Lock()
	defer f.mu.Unlock()
	h := sha256.Sum256([]byte(out.Token))
	if f.writes.grant == nil || !bytes.Equal(f.writes.grant.Hash, h[:]) || f.writes.grant.Kind != g.Kind || out.SessionID != f.snapshot.SessionID || out.ExecutionGeneration != g.ExecutionGeneration {
		t.Fatal("grant write changed declared intent")
	}
	f.record.GrantHash = h[:]
	f.record.GrantExpiry = &out.ExpiresAt
	f.record.GrantKind = g.Kind
	f.record.Parent = f.handler.principal.CredentialID
	return out
}
func sessionDial(t *testing.T, serverURL, path, token string, extra http.Header) *websocket.Conn {
	t.Helper()
	return sessionDialOptions(t, serverURL, path, token, extra, websocket.DialOptions{})
}
func sessionDialOptions(t *testing.T, serverURL, path, token string, extra http.Header, options websocket.DialOptions) *websocket.Conn {
	t.Helper()
	header := extra.Clone()
	if header == nil {
		header = make(http.Header)
	}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	options.HTTPHeader = header
	conn, response, err := websocket.Dial(ctx, strings.Replace(serverURL, "http://", "ws://", 1)+path, &options)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("WebSocket upgrade %d: %v", status, err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}
func sessionWSWrite(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(jsonBody(t, value))); err != nil {
		t.Fatal(err)
	}
}
func sessionWSRead(t *testing.T, conn *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if json.Unmarshal(data, &result) != nil {
		t.Fatalf("invalid frame %s", data)
	}
	return result
}
func sessionWSKind(t *testing.T, conn *websocket.Conn, kind string) map[string]json.RawMessage {
	t.Helper()
	for range 30 {
		frame := sessionWSRead(t, conn)
		var actual string
		_ = json.Unmarshal(frame["type"], &actual)
		if actual == kind {
			return frame
		}
	}
	t.Fatalf("missing frame %s", kind)
	return nil
}
func (f *sessionHTTPFixture) controller(t *testing.T, epoch string) (*websocket.Conn, sp.Snapshot) {
	t.Helper()
	conn := sessionDial(t, f.server.URL, "/api/v1/controller-channel", f.grant.Token, nil)
	f.mu.Lock()
	expectedEpoch, _ := strconv.ParseInt(f.record.Snapshot.ConnectionEpoch, 10, 64)
	captured, commit := make(chan struct{}), make(chan struct{})
	f.connectionCaptured, f.connectionCommit = captured, commit
	f.mu.Unlock()
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(commit) }) })
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: f.snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	select {
	case <-captured:
	case <-time.After(5 * time.Second):
		t.Fatal("controller did not reach connection DAO")
	}
	f.mu.Lock()
	if f.writes.instance == "" || f.writes.seen == nil {
		f.mu.Unlock()
		t.Fatal("connection DAO did not capture relay identity")
	}
	f.record.Snapshot.ConnectionEpoch = strconv.FormatInt(expectedEpoch+1, 10)
	f.record.ServerInstance = new(f.writes.instance)
	f.record.ConnectionExpiry = f.record.GrantExpiry
	f.record.LastSeen = new(*f.writes.seen)
	f.record.ConnectionParent = f.handler.principal.CredentialID
	f.record.Consumed = true
	f.record.SourceEpoch = new(epoch)
	f.record.SourceEpochs = []string{epoch}
	f.mu.Unlock()
	release.Do(func() { close(commit) })
	frame := sessionWSKind(t, conn, "welcome")
	snapshot, err := sp.DecodeSnapshot(frame["session"])
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ConnectionEpoch != strconv.FormatInt(expectedEpoch+1, 10) || snapshot.Identity.WorkerID != f.registration.WorkerID || snapshot.Identity.ControllerInstanceID != f.registration.ControllerInstanceID {
		t.Fatal("welcome changed declared connection fence or owner")
	}
	f.mu.Lock()
	f.record.Snapshot.HistoryEpoch = snapshot.HistoryEpoch
	f.mu.Unlock()
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing"}
	sessionWSWrite(t, conn, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, conn, "sync_ack")
	return conn, snapshot
}

type sessionHTTPStore struct {
	*httpTestStore
	fixture *sessionHTTPFixture
}

type sessionHTTPScope struct {
	t   *testing.T
	dao store.SessionDAO
}

func (s sessionHTTPScope) SessionDAO() store.SessionDAO { return s.dao }
func (s sessionHTTPScope) BotDAO() store.BotWriteDAO    { return sessionHTTPRejectedBotDAO{t: s.t} }

type sessionHTTPWrites struct {
	session          *store.SessionRecord
	grant            *store.SessionGrant
	instance         string
	seen             *time.Time
	connectionExpiry *time.Time
	disconnected     int
}

type sessionHTTPDAO struct {
	ctx context.Context
	sessionHTTPRejectedDAO
	t      *testing.T
	f      *sessionHTTPFixture
	record store.SessionRecord
	task   store.SessionTask
	calls  map[string]int
	first  string
}

func sessionHTTPCopy[T any](v T) T {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (s *sessionHTTPStore) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	f := s.fixture
	f.mu.Lock()
	d := &sessionHTTPDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: s.t}, t: s.t, ctx: ctx, f: f, record: sessionHTTPCopy(f.record), task: sessionHTTPCopy(f.sessionTask), calls: map[string]int{}}
	f.mu.Unlock()
	err := fn(sessionHTTPScope{t: s.t, dao: d})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	d.verify()
	if d.calls["ConnectSession"] == 1 {
		f.mu.Lock()
		commit := f.connectionCommit
		f.mu.Unlock()
		if commit == nil {
			d.fail("connection commit has no test barrier")
		}
		select {
		case <-commit:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (d *sessionHTTPDAO) called(ctx context.Context, name string) {
	if ctx != d.ctx {
		d.fail("Session DAO %s escaped transaction context", name)
	}
	if d.first == "" {
		d.first = name
	}
	d.calls[name]++
	d.f.mu.Lock()
	d.f.calls[name]++
	d.f.mu.Unlock()
}
func (d *sessionHTTPDAO) fail(format string, args ...any) {
	d.t.Helper()
	d.t.Errorf(format, args...)
	panic(fmt.Sprintf(format, args...))
}
func (d *sessionHTTPDAO) id(id string) {
	if id != d.record.Snapshot.SessionID {
		d.fail("Session DAO id=%q, want %q", id, d.record.Snapshot.SessionID)
	}
}
func (d *sessionHTTPDAO) verify() {
	required := map[string]int{}
	switch d.first {
	case "ListSessionMediaLeases":
		if len(d.calls) != 1 || d.calls["ListSessionMediaLeases"] != 1 {
			d.fail("media recovery listing retained or reused its database scope")
		}
		return
	case "LockTaskRegistration":
		required = map[string]int{"LockTaskRegistration": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1}
	case "SessionLocation":
		required = map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "SessionLocationByGrant":
		required = map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "LockTask", "LockArchiveTask":
		required = map[string]int{d.first: 1, "LockCredential": 1, "ProjectAccess": 1}
	default:
		d.fail("unconfigured Session transaction begins with %q", d.first)
	}
	for name, n := range required {
		if d.calls[name] != n {
			d.fail("Session callback %s=%d, want %d (first=%s)", name, d.calls[name], n, d.first)
		}
	}
	if d.calls["SessionBotID"] != d.calls["LockSession"] {
		d.fail("Session lookup and lock count differ")
	}
	for _, name := range []string{"SaveSession", "TouchSession", "DisconnectSession", "ConnectSession", "SetSessionGrant", "SetSessionGenerationStop", "AcceptedSessionOperations", "CurrentTaskSession", "UnreconciledSessionOperationCount"} {
		if d.calls[name] > 1 {
			d.fail("extra Session callback %s", name)
		}
	}
	if d.calls["TouchSession"] != 0 || d.calls["ConnectSession"] != 0 || d.calls["DisconnectSession"] != 0 || d.calls["SetSessionGrant"] != 0 {
		if d.calls["SaveSession"] != 1 {
			d.fail("Session callback omitted exact SaveSession")
		}
	}
}
func (d *sessionHTTPDAO) ListSessionMediaLeases(ctx context.Context) ([]store.SessionResourceLease, error) {
	d.called(ctx, "ListSessionMediaLeases")
	d.f.mu.Lock()
	read := d.f.mediaRecoveryRead
	d.f.mu.Unlock()
	if read == nil {
		d.fail("unconfigured media recovery lease listing")
	}
	return read(ctx)
}

func (d *sessionHTTPDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.called(ctx, "LockCredential")
	if now.IsZero() || p != d.f.handler.principal {
		d.fail("Session credential changed principal or time: %+v", p)
	}
	d.f.mu.Lock()
	revoked := d.f.credentialRevoked
	d.f.mu.Unlock()
	if revoked {
		return model.ErrNotFound
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.called(ctx, "ProjectAccess")
	if user != d.f.handler.principal.UserID || project != d.f.task.ProjectID {
		d.fail("Session project access args %q/%q", user, project)
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, ctx.Err()
}
func (d *sessionHTTPDAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session Task lock changed address %q/%q", project, id)
	}
	return d.task, ctx.Err()
}
func (d *sessionHTTPDAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	d.called(ctx, "LockArchiveTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session archive Task lock changed address")
	}
	return d.task, false, ctx.Err()
}
func (d *sessionHTTPDAO) LockTaskRegistration(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTaskRegistration")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("registration lock changed address")
	}
	return d.task, ctx.Err()
}
func (d *sessionHTTPDAO) FindTaskRegistration(ctx context.Context, project, registration, task, claim string) (string, error) {
	d.called(ctx, "FindTaskRegistration")
	if project != d.f.task.ProjectID || task != d.f.task.ID || registration != d.f.registration.RegistrationID || claim != d.f.registration.ClaimID {
		d.fail("registration lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionHTTPDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.called(ctx, "SessionBotID")
	d.id(id)
	return nil, ctx.Err()
}
func (d *sessionHTTPDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.called(ctx, "LockSession")
	d.id(id)
	return d.record, ctx.Err()
}
func (d *sessionHTTPDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocation")
	d.id(id)
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: id}, ctx.Err()
}
func (d *sessionHTTPDAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocationByGrant")
	if !bytes.Equal(hash, d.record.GrantHash) {
		return store.SessionLocation{}, model.ErrNotFound
	}
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: d.record.Snapshot.SessionID}, ctx.Err()
}
func (d *sessionHTTPDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.called(ctx, "CurrentTaskSession")
	if project != d.f.task.ProjectID || task != d.f.task.ID || claim != d.record.Snapshot.ClaimID {
		d.fail("current Session lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionHTTPDAO) SaveSession(ctx context.Context, in store.SessionRecord) error {
	d.called(ctx, "SaveSession")
	d.id(in.Snapshot.SessionID)
	if in.Snapshot.ClaimID != d.record.Snapshot.ClaimID || in.Snapshot.Identity.ProjectID != d.f.task.ProjectID || in.Snapshot.Identity.TaskID != d.f.task.ID {
		d.fail("saved Session changed owner binding")
	}
	d.f.mu.Lock()
	d.f.writes.session = new(sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionGrant(ctx context.Context, in store.SessionGrant) error {
	d.called(ctx, "SetSessionGrant")
	d.id(in.SessionID)
	if in.ParentCredentialID != d.f.handler.principal.CredentialID || len(in.Hash) != 32 || in.ExpiresAt.IsZero() {
		d.fail("grant changed parent or token hash")
	}
	d.f.mu.Lock()
	d.f.writes.grant = new(sessionHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionHTTPDAO) SetSessionGenerationStop(ctx context.Context, id string, proof []byte) error {
	d.called(ctx, "SetSessionGenerationStop")
	d.id(id)
	if !json.Valid(proof) {
		d.fail("generation stop is not JSON")
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) ConnectSession(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
	d.called(ctx, "ConnectSession")
	d.id(id)
	if instance == "" || seen.IsZero() || expiry == nil || !expiry.Equal(*d.record.GrantExpiry) {
		d.fail("connection changed instance/time/grant expiry")
	}
	d.f.mu.Lock()
	d.f.writes.instance = instance
	d.f.writes.seen = &seen
	d.f.writes.connectionExpiry = expiry
	captured := d.f.connectionCaptured
	d.f.mu.Unlock()
	if captured == nil {
		d.fail("connection capture has no test barrier")
	}
	close(captured)
	return ctx.Err()
}
func (d *sessionHTTPDAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	d.called(ctx, "TouchSession")
	d.id(id)
	if now.IsZero() {
		d.fail("heartbeat time is zero")
	}
	return ctx.Err()
}
func (d *sessionHTTPDAO) DisconnectSession(ctx context.Context, id string) error {
	d.called(ctx, "DisconnectSession")
	d.id(id)
	if op, err := d.f.application.engine.BeginOperation(); err != nil {
		d.fail("engine stopped before controller disconnect: %v", err)
	} else {
		op.Close()
	}
	d.f.mu.Lock()
	d.f.writes.disconnected++
	d.f.mu.Unlock()
	return ctx.Err()
}

func (d *sessionHTTPDAO) AcceptedSessionOperations(ctx context.Context, id string) ([]string, error) {
	d.called(ctx, "AcceptedSessionOperations")
	d.id(id)
	return []string{}, ctx.Err()
}

func (d *sessionHTTPDAO) UnreconciledSessionOperations(ctx context.Context, id string, epoch int64) ([]string, error) {
	d.called(ctx, "UnreconciledSessionOperations")
	d.id(id)
	return []string{}, ctx.Err()
}
func (d *sessionHTTPDAO) UnreconciledSessionOperationCount(ctx context.Context, id string, epoch int64) (int, error) {
	d.called(ctx, "UnreconciledSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}

var _ store.SessionDAO = (*sessionHTTPDAO)(nil)

type sessionHTTPRejectedDAO struct{ t *testing.T }

func (d sessionHTTPRejectedDAO) LockOAuthCredential(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockOAuthCredential")
	panic("unconfigured SessionDAO.LockOAuthCredential")
}

func (d sessionHTTPRejectedDAO) ReadOAuthCredential(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ReadOAuthCredential")
	panic("unconfigured SessionDAO.ReadOAuthCredential")
}

func (d sessionHTTPRejectedDAO) LockCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockCredential")
	panic("unconfigured SessionDAO.LockCredential")
}

func (d sessionHTTPRejectedDAO) ReadCredential(a0 context.Context, a1 model.Principal, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ReadCredential")
	panic("unconfigured SessionDAO.ReadCredential")
}

func (d sessionHTTPRejectedDAO) ArchiveMetadata(a0 context.Context, a1 string) (store.ArchiveMetadata, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ArchiveMetadata")
	panic("unconfigured SessionDAO.ArchiveMetadata")
}

func (d sessionHTTPRejectedDAO) ProjectAccess(a0 context.Context, a1 string, a2 string) (model.ProjectAccess, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ProjectAccess")
	panic("unconfigured SessionDAO.ProjectAccess")
}

func (d sessionHTTPRejectedDAO) LockTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTask")
	panic("unconfigured SessionDAO.LockTask")
}

func (d sessionHTTPRejectedDAO) SessionBotID(a0 context.Context, a1 string) (*string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionBotID")
	panic("unconfigured SessionDAO.SessionBotID")
}

func (d sessionHTTPRejectedDAO) LockSession(a0 context.Context, a1 string) (store.SessionRecord, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockSession")
	panic("unconfigured SessionDAO.LockSession")
}

func (d sessionHTTPRejectedDAO) SaveSession(a0 context.Context, a1 store.SessionRecord) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveSession")
	panic("unconfigured SessionDAO.SaveSession")
}

func (d sessionHTTPRejectedDAO) LockTaskRegistration(a0 context.Context, a1 string, a2 string) (store.SessionTask, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTaskRegistration")
	panic("unconfigured SessionDAO.LockTaskRegistration")
}

func (d sessionHTTPRejectedDAO) LockTestOwner(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTestOwner")
	panic("unconfigured SessionDAO.LockTestOwner")
}

func (d sessionHTTPRejectedDAO) FindTaskRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTaskRegistration")
	panic("unconfigured SessionDAO.FindTaskRegistration")
}

func (d sessionHTTPRejectedDAO) FindTestRegistration(a0 context.Context, a1 string, a2 string, a3 string) (string, *string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTestRegistration")
	panic("unconfigured SessionDAO.FindTestRegistration")
}

func (d sessionHTTPRejectedDAO) InsertTaskSession(a0 context.Context, a1 store.SessionRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTaskSession")
	panic("unconfigured SessionDAO.InsertTaskSession")
}

func (d sessionHTTPRejectedDAO) InsertTestSession(a0 context.Context, a1 store.SessionRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTestSession")
	panic("unconfigured SessionDAO.InsertTestSession")
}

func (d sessionHTTPRejectedDAO) InsertBotSession(a0 context.Context, a1 store.SessionRegistration) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertBotSession")
	panic("unconfigured SessionDAO.InsertBotSession")
}

func (d sessionHTTPRejectedDAO) SessionLocation(a0 context.Context, a1 string) (store.SessionLocation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionLocation")
	panic("unconfigured SessionDAO.SessionLocation")
}

func (d sessionHTTPRejectedDAO) SessionLocationByGrant(a0 context.Context, a1 []byte) (store.SessionLocation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionLocationByGrant")
	panic("unconfigured SessionDAO.SessionLocationByGrant")
}

func (d sessionHTTPRejectedDAO) CurrentTaskSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.CurrentTaskSession")
	panic("unconfigured SessionDAO.CurrentTaskSession")
}

func (d sessionHTTPRejectedDAO) SetSessionGrant(a0 context.Context, a1 store.SessionGrant) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionGrant")
	panic("unconfigured SessionDAO.SetSessionGrant")
}

func (d sessionHTTPRejectedDAO) SetSessionGenerationStop(a0 context.Context, a1 string, a2 []byte) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionGenerationStop")
	panic("unconfigured SessionDAO.SetSessionGenerationStop")
}

func (d sessionHTTPRejectedDAO) SetTestSessionStop(a0 context.Context, a1 string, a2 []byte) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetTestSessionStop")
	panic("unconfigured SessionDAO.SetTestSessionStop")
}

func (d sessionHTTPRejectedDAO) ConnectSession(a0 context.Context, a1 string, a2 string, a3 time.Time, a4 *time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ConnectSession")
	panic("unconfigured SessionDAO.ConnectSession")
}

func (d sessionHTTPRejectedDAO) TouchSession(a0 context.Context, a1 string, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.TouchSession")
	panic("unconfigured SessionDAO.TouchSession")
}

func (d sessionHTTPRejectedDAO) DisconnectSession(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.DisconnectSession")
	panic("unconfigured SessionDAO.DisconnectSession")
}

func (d sessionHTTPRejectedDAO) LockBotSessions(a0 context.Context, a1 string) ([]store.BotSession, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockBotSessions")
	panic("unconfigured SessionDAO.LockBotSessions")
}

func (d sessionHTTPRejectedDAO) RevokeBotSessions(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.RevokeBotSessions")
	panic("unconfigured SessionDAO.RevokeBotSessions")
}

func (d sessionHTTPRejectedDAO) LockBotSessionStop(a0 context.Context, a1 string, a2 string, a3 string) (store.BotSessionStop, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockBotSessionStop")
	panic("unconfigured SessionDAO.LockBotSessionStop")
}

func (d sessionHTTPRejectedDAO) DeleteBotSession(a0 context.Context, a1 string, a2 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.DeleteBotSession")
	panic("unconfigured SessionDAO.DeleteBotSession")
}

func (d sessionHTTPRejectedDAO) RedactDeletedBot(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.RedactDeletedBot")
	panic("unconfigured SessionDAO.RedactDeletedBot")
}

func (d sessionHTTPRejectedDAO) SessionOperation(a0 context.Context, a1 string, a2 string) (store.SessionOperation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionOperation")
	panic("unconfigured SessionDAO.SessionOperation")
}

func (d sessionHTTPRejectedDAO) InsertSessionOperation(a0 context.Context, a1 store.SessionOperation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertSessionOperation")
	panic("unconfigured SessionDAO.InsertSessionOperation")
}

func (d sessionHTTPRejectedDAO) SetSessionOperationReceipt(a0 context.Context, a1 sp.Operation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionOperationReceipt")
	panic("unconfigured SessionDAO.SetSessionOperationReceipt")
}

func (d sessionHTTPRejectedDAO) SetSessionOperationEpoch(a0 context.Context, a1 string, a2 string, a3 int64) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionOperationEpoch")
	panic("unconfigured SessionDAO.SetSessionOperationEpoch")
}

func (d sessionHTTPRejectedDAO) HasOtherFirstInput(a0 context.Context, a1 string, a2 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.HasOtherFirstInput")
	panic("unconfigured SessionDAO.HasOtherFirstInput")
}

func (d sessionHTTPRejectedDAO) HasInteractionResponse(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.HasInteractionResponse")
	panic("unconfigured SessionDAO.HasInteractionResponse")
}

func (d sessionHTTPRejectedDAO) PendingSessionOperationCount(a0 context.Context, a1 string) (int, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.PendingSessionOperationCount")
	panic("unconfigured SessionDAO.PendingSessionOperationCount")
}

func (d sessionHTTPRejectedDAO) AcceptedSessionOperations(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.AcceptedSessionOperations")
	panic("unconfigured SessionDAO.AcceptedSessionOperations")
}

func (d sessionHTTPRejectedDAO) StoppingTestOperations(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.StoppingTestOperations")
	panic("unconfigured SessionDAO.StoppingTestOperations")
}

func (d sessionHTTPRejectedDAO) UnreconciledSessionOperations(a0 context.Context, a1 string, a2 int64) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.UnreconciledSessionOperations")
	panic("unconfigured SessionDAO.UnreconciledSessionOperations")
}

func (d sessionHTTPRejectedDAO) UnreconciledSessionOperationCount(a0 context.Context, a1 string, a2 int64) (int, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.UnreconciledSessionOperationCount")
	panic("unconfigured SessionDAO.UnreconciledSessionOperationCount")
}

func (d sessionHTTPRejectedDAO) LockArchiveTask(a0 context.Context, a1 string, a2 string) (store.SessionTask, bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockArchiveTask")
	panic("unconfigured SessionDAO.LockArchiveTask")
}

func (d sessionHTTPRejectedDAO) SessionArchive(a0 context.Context, a1 string) (sp.ArchiveStatus, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.SessionArchive")
	panic("unconfigured SessionDAO.SessionArchive")
}

func (d sessionHTTPRejectedDAO) SetSessionArchiveState(a0 context.Context, a1 string, a2 string, a3 *string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionArchiveState")
	panic("unconfigured SessionDAO.SetSessionArchiveState")
}

func (d sessionHTTPRejectedDAO) SetSessionArchiveReady(a0 context.Context, a1 string, a2 string, a3 int, a4 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetSessionArchiveReady")
	panic("unconfigured SessionDAO.SetSessionArchiveReady")
}

func (d sessionHTTPRejectedDAO) ListTestSessions(a0 context.Context, a1 string, a2 time.Time, a3 int, a4 bool, a5 time.Time, a6 *time.Time, a7 string) ([]store.TestSessionListItem, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.ListTestSessions")
	panic("unconfigured SessionDAO.ListTestSessions")
}

func (d sessionHTTPRejectedDAO) LockTerminal(a0 context.Context, a1 string) ([]byte, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.LockTerminal")
	panic("unconfigured SessionDAO.LockTerminal")
}

func (d sessionHTTPRejectedDAO) SaveTerminal(a0 context.Context, a1 string, a2 []byte, a3 *time.Time, a4 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminal")
	panic("unconfigured SessionDAO.SaveTerminal")
}

func (d sessionHTTPRejectedDAO) FindTerminalRegistration(a0 context.Context, a1 string, a2 string, a3 string, a4 string, a5 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.FindTerminalRegistration")
	panic("unconfigured SessionDAO.FindTerminalRegistration")
}

func (d sessionHTTPRejectedDAO) InsertTerminal(a0 context.Context, a1 store.TerminalRegistration) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTerminal")
	panic("unconfigured SessionDAO.InsertTerminal")
}

func (d sessionHTTPRejectedDAO) InsertRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string, a4 int64, a5 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertRecordingEvidence")
	panic("unconfigured SessionDAO.InsertRecordingEvidence")
}

func (d sessionHTTPRejectedDAO) TerminalOperation(a0 context.Context, a1 string, a2 string) (store.TerminalOperation, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalOperation")
	panic("unconfigured SessionDAO.TerminalOperation")
}

func (d sessionHTTPRejectedDAO) InsertTerminalOperation(a0 context.Context, a1 store.TerminalOperation) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InsertTerminalOperation")
	panic("unconfigured SessionDAO.InsertTerminalOperation")
}

func (d sessionHTTPRejectedDAO) SetTerminalOperationResult(a0 context.Context, a1 string, a2 v2.OperationResult) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SetTerminalOperationResult")
	panic("unconfigured SessionDAO.SetTerminalOperationResult")
}

func (d sessionHTTPRejectedDAO) InvalidateTerminalOperations(a0 context.Context, a1 string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.InvalidateTerminalOperations")
	panic("unconfigured SessionDAO.InvalidateTerminalOperations")
}

func (d sessionHTTPRejectedDAO) ExpireTerminalOperations(a0 context.Context, a1 string, a2 time.Time) error {
	unexpectedHTTPCall(d.t, "SessionDAO.ExpireTerminalOperations")
	panic("unconfigured SessionDAO.ExpireTerminalOperations")
}

func (d sessionHTTPRejectedDAO) QueuedTerminalOperation(a0 context.Context, a1 string) ([]string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.QueuedTerminalOperation")
	panic("unconfigured SessionDAO.QueuedTerminalOperation")
}

func (d sessionHTTPRejectedDAO) TerminalViewerOperationPending(a0 context.Context, a1 string, a2 string, a3 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalViewerOperationPending")
	panic("unconfigured SessionDAO.TerminalViewerOperationPending")
}

func (d sessionHTTPRejectedDAO) TerminalArchive(a0 context.Context, a1 string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalArchive")
	panic("unconfigured SessionDAO.TerminalArchive")
}

func (d sessionHTTPRejectedDAO) SaveTerminalReceipt(a0 context.Context, a1 string, a2 v2.Receipt, a3 *string) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminalReceipt")
	panic("unconfigured SessionDAO.SaveTerminalReceipt")
}

func (d sessionHTTPRejectedDAO) SaveTerminalArchiveStatus(a0 context.Context, a1 string, a2 v2.ArchiveStatus) error {
	unexpectedHTTPCall(d.t, "SessionDAO.SaveTerminalArchiveStatus")
	panic("unconfigured SessionDAO.SaveTerminalArchiveStatus")
}

func (d sessionHTTPRejectedDAO) CurrentTerminalSession(a0 context.Context, a1 string, a2 string, a3 string) (string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.CurrentTerminalSession")
	panic("unconfigured SessionDAO.CurrentTerminalSession")
}

func (d sessionHTTPRejectedDAO) TerminalHistory(a0 context.Context, a1 string, a2 string, a3 *time.Time, a4 *string, a5 int) ([]store.TerminalHistoryRow, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalHistory")
	panic("unconfigured SessionDAO.TerminalHistory")
}

func (d sessionHTTPRejectedDAO) TerminalRecordingEvidence(a0 context.Context, a1 string, a2 int64, a3 string) (string, string, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalRecordingEvidence")
	panic("unconfigured SessionDAO.TerminalRecordingEvidence")
}

func (d sessionHTTPRejectedDAO) TerminalAutomationAllowed(a0 context.Context, a1 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalAutomationAllowed")
	panic("unconfigured SessionDAO.TerminalAutomationAllowed")
}

func (d sessionHTTPRejectedDAO) TerminalInputPending(a0 context.Context, a1 string) (bool, error) {
	unexpectedHTTPCall(d.t, "SessionDAO.TerminalInputPending")
	panic("unconfigured SessionDAO.TerminalInputPending")
}

var _ store.SessionDAO = sessionHTTPRejectedDAO{}

type sessionHTTPRejectedBotDAO struct{ t *testing.T }

func (d sessionHTTPRejectedBotDAO) Credential(context.Context, model.Principal) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Credential")
	panic("unconfigured BotDAO.Credential")
}

func (d sessionHTTPRejectedBotDAO) Worker(context.Context, string, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Worker")
	panic("unconfigured BotDAO.Worker")
}

func (d sessionHTTPRejectedBotDAO) LockCreation(context.Context, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.LockCreation")
	panic("unconfigured BotDAO.LockCreation")
}

func (d sessionHTTPRejectedBotDAO) Bot(context.Context, string) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.Bot")
	panic("unconfigured BotDAO.Bot")
}

func (d sessionHTTPRejectedBotDAO) BotDefaults(context.Context, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotDefaults")
	panic("unconfigured BotDAO.BotDefaults")
}

func (d sessionHTTPRejectedBotDAO) InsertBot(context.Context, model.Bot) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.InsertBot")
	panic("unconfigured BotDAO.InsertBot")
}

func (d sessionHTTPRejectedBotDAO) SaveBotDeletion(context.Context, string, *model.BotDeletion) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.SaveBotDeletion")
	panic("unconfigured BotDAO.SaveBotDeletion")
}

func (d sessionHTTPRejectedBotDAO) BindBotSession(context.Context, string, int64, string, model.BotRoleConfiguration) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BindBotSession")
	panic("unconfigured BotDAO.BindBotSession")
}

func (d sessionHTTPRejectedBotDAO) SetBotStartup(context.Context, string, int64, model.BotStartupResult) (model.Bot, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.SetBotStartup")
	panic("unconfigured BotDAO.SetBotStartup")
}

func (d sessionHTTPRejectedBotDAO) CommitBotPreferences(context.Context, string) error {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.CommitBotPreferences")
	panic("unconfigured BotDAO.CommitBotPreferences")
}

func (d sessionHTTPRejectedBotDAO) BotPreferredWorker(context.Context, string) (*string, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotPreferredWorker")
	panic("unconfigured BotDAO.BotPreferredWorker")
}

func (d sessionHTTPRejectedBotDAO) BotCreationCandidate(context.Context, string, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationCandidate")
	panic("unconfigured BotDAO.BotCreationCandidate")
}

func (d sessionHTTPRejectedBotDAO) BotCreationCandidates(context.Context, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationCandidates")
	panic("unconfigured BotDAO.BotCreationCandidates")
}

func (d sessionHTTPRejectedBotDAO) BotCreationWorker(context.Context, string, string) (model.BotDefaultsInput, error) {
	unexpectedHTTPCall(d.t, "SessionScope.BotDAO.BotCreationWorker")
	panic("unconfigured BotDAO.BotCreationWorker")
}

var _ store.BotWriteDAO = sessionHTTPRejectedBotDAO{}

func startupBody(f *sessionHTTPFixture) map[string]any {
	return map[string]any{
		"schemaVersion": 1, "source": "worker", "sessionId": f.snapshot.SessionID, "claimId": f.snapshot.ClaimID,
		"executionGeneration": f.snapshot.ExecutionGeneration, "controllerInstanceId": f.registration.ControllerInstanceID,
		"revision": "1", "observedAt": "2026-11-05T00:00:00Z",
		"startup":  map[string]any{"state": "unknown", "reasonCode": "native_timeout"},
		"recovery": map[string]any{"state": "blocked", "reasonCode": "native_identity_missing"},
	}
}

func startupRequest(f *sessionHTTPFixture, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	authorizeResourceRequest(f.handler, request)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("X-Daynight-Startup-Version", "1")
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func TestFailedStartupReportHTTPReadback(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	report["startup"] = map[string]any{"state": "failed", "reasonCode": "native_rejected"}
	body := jsonBody(t, map[string]any{
		"version": f.task.Version, "claimId": f.snapshot.ClaimID, "phase": "waiting",
		"nativeSessionId": nil, "herdr": nil, "startupReport": report,
	})
	currentTask := startupTaskModel(f.task)
	value := startupReportValue(t, report)
	expectedTask := startupReportedTask(t, currentTask, value)
	expectedTask = startupReplaceWorker(t, expectedTask, func(worker *api.WorkerClaim) {
		worker.Phase = "waiting"
		worker.NativeSessionID = nil
		worker.Herdr = nil
	})
	startupExpectWrite(t, f, currentTask, &value, true, &expectedTask, nil, f.handler.principal, nil)
	updated := decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", body), http.StatusOK)
	if !reflect.DeepEqual(updated, startupTaskDocument(t, expectedTask)) {
		t.Fatal("worker startup response changed unrelated Task fields")
	}
	worker := apiWorker(t, updated.Properties)
	if worker.ClaimID != f.snapshot.ClaimID || worker.UserID != f.handler.principal.UserID || worker.Phase != "waiting" || worker.NativeSessionID != nil || worker.Herdr != nil {
		t.Fatalf("worker update lost its identity or waiting state: %+v", worker)
	}

	startupExpectTaskRead(t, f, expectedTask)
	read := decodeResponse[api.Task](t, projectRequest(f.handler, http.MethodGet, taskPath(f.task), ""), http.StatusOK)
	readWorker := apiWorker(t, read.Properties)
	if read.Version != updated.Version || !reflect.DeepEqual(readWorker, worker) || !reflect.DeepEqual(read.Properties["sessionStartup"], updated.Properties["sessionStartup"]) {
		t.Fatal("Task read response changed the supplied worker or startup report")
	}

	startupExpectCurrent(t, f, startupSessionTask(t, expectedTask, &value), f.record)
	response := startupRequest(f, http.MethodGet, f.base+"/current", "")
	current := decodeResponse[struct {
		Status        string          `json:"status"`
		Session       sp.Snapshot     `json:"session"`
		StartupReport json.RawMessage `json:"startupReport"`
	}](t, response, http.StatusOK)
	var expected map[string]any
	var actual map[string]any
	if err := json.Unmarshal([]byte(jsonBody(t, report)), &expected); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(current.StartupReport, &actual); err != nil {
		t.Fatal(err)
	}
	if current.Status != "registered" || current.Session.SessionID != f.snapshot.SessionID || current.Session.ClaimID != f.snapshot.ClaimID || current.Session.Identity.NativeSessionID != nil || !reflect.DeepEqual(actual, expected) {
		t.Fatalf("current session lost failed startup evidence or identity: %+v, report=%s", current.Session, current.StartupReport)
	}

	unauthenticated := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, f.base+"/current", nil)
	request.Header.Set("X-Daynight-Startup-Version", "1")
	request.Header.Set("X-Request-ID", "project-test")
	f.handler.ServeHTTP(unauthenticated, request)
	assertProjectError(t, unauthenticated, http.StatusUnauthorized, "unauthenticated")
}

func sendStartup(t *testing.T, f *sessionHTTPFixture, report map[string]any) api.Task {
	t.Helper()
	current := startupTaskModel(f.task)
	value := startupReportValue(t, report)
	previous, err := taskproperty.SessionStartup(current.Properties)
	if err != nil {
		t.Fatal(err)
	}
	expected := current
	var returned *model.Task
	if !reflect.DeepEqual(previous, &value) {
		expected = startupReportedTask(t, current, value)
		returned = &expected
	}
	startupExpectWrite(t, f, current, &value, true, returned, nil, f.handler.principal, nil)
	f.task = decodeResponse[api.Task](t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": current.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusOK)
	if !reflect.DeepEqual(f.task, startupTaskDocument(t, expected)) {
		t.Fatal("startup response changed expected Task fields")
	}
	return f.task
}

// The startup HTTP fixture supplies an explicit no-owner recovery result. The
// actual service still performs recovery before changing the generation fence.
func startupExpectEmptyMediaRecovery(t *testing.T, f *sessionHTTPFixture) {
	t.Helper()
	f.mu.Lock()
	before := f.calls["ListSessionMediaLeases"]
	f.mediaRecoveryRead = func(context.Context) ([]store.SessionResourceLease, error) {
		return []store.SessionResourceLease{}, nil
	}
	f.mu.Unlock()
	t.Cleanup(func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if actual := f.calls["ListSessionMediaLeases"] - before; actual != 1 {
			t.Errorf("generation grant recovery listings=%d, want 1", actual)
		}
	})
}

func TestStartupReportGenerationSwitchFiltersOldEvidence(t *testing.T) {
	f := sessionHTTPSetup(t)
	report := startupBody(f)
	sendStartup(t, f, report)
	previous := "1"
	nextInstance := uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: nextInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	startupExpectEmptyMediaRecovery(t, f)
	f.store.WriteSessionCall = f.store.run
	f.mintGrant(t, grant)
	nextRecord := f.record
	nextRecord.Snapshot.ExecutionGeneration = "2"
	nextRecord.Snapshot.Identity.ControllerInstanceID = nextInstance
	old := startupReportValue(t, report)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &old), nextRecord)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("new generation displays previous startup evidence")
	}
	report["revision"] = "999"
	old = startupReportValue(t, report)
	startupExpectWrite(t, f, startupTaskModel(f.task), &old, false, nil, nil, f.handler.principal, nil)
	assertProjectError(t, startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": report})), http.StatusConflict, "claim_conflict")
	report["revision"] = "1"
	report["executionGeneration"] = "2"
	report["controllerInstanceId"] = nextInstance
	sendStartup(t, f, report)
	currentReport := startupReportValue(t, report)
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &currentReport), nextRecord)
	current = decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] == nil {
		t.Fatal("current generation evidence not readable")
	}
}

func TestStartupReportConcurrentGenerationGrantKeepsCurrentFence(t *testing.T) {
	f := sessionHTTPSetup(t)
	previous := "1"
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: f.snapshot.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	grantBody := jsonBody(t, grant)
	report := startupReportValue(t, startupBody(f))
	reportBody := jsonBody(t, map[string]any{"version": f.task.Version, "claimId": f.snapshot.ClaimID, "startupReport": startupBody(f)})
	matched, grantFinished := make(chan struct{}), make(chan struct{})
	var release sync.Once
	reportDone := make(chan struct{})
	finishGrant := func() { release.Do(func() { close(grantFinished) }) }
	t.Cleanup(func() {
		finishGrant()
		select {
		case <-reportDone:
		case <-time.After(5 * time.Second):
			t.Error("startup report request did not drain")
		}
	})
	startupExpectWrite(t, f, startupTaskModel(f.task), &report, false, nil, nil, f.handler.principal, func() {
		close(matched)
		select {
		case <-grantFinished:
		case <-time.After(5 * time.Second):
			t.Error("concurrent grant did not complete")
			panic("grant timeout")
		}
	})
	reported := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		defer close(reportDone)
		reported <- startupRequest(f, http.MethodPatch, taskPath(f.task)+"/worker-claim", reportBody)
	}()
	select {
	case <-matched:
	case <-time.After(5 * time.Second):
		t.Fatal("report did not reach its Session fence")
	}
	startupExpectEmptyMediaRecovery(t, f)
	f.store.WriteSessionCall = f.store.run
	decodeResponse[sessioncore.GrantResult](t, projectRequest(f.handler, http.MethodPost, f.base+"/"+f.snapshot.SessionID+"/controller-grant", grantBody), http.StatusOK)
	finishGrant()
	var result *httptest.ResponseRecorder
	select {
	case result = <-reported:
	case <-time.After(5 * time.Second):
		t.Fatal("startup report response did not complete")
	}
	assertProjectError(t, result, http.StatusConflict, "claim_conflict")
	nextRecord := f.record
	nextRecord.Snapshot.ExecutionGeneration, nextRecord.Snapshot.Identity.ControllerInstanceID = "2", grant.ControllerInstanceID
	startupExpectCurrent(t, f, startupSessionTask(t, startupTaskModel(f.task), &report), nextRecord)
	current := decodeResponse[map[string]any](t, startupRequest(f, http.MethodGet, f.base+"/current", ""), http.StatusOK)
	if current["startupReport"] != nil {
		t.Fatal("racing old report crossed generation boundary")
	}
}

func startupTaskModel(value api.Task) model.Task {
	var platform *model.TaskPlatform
	if value.RequiredPlatform != nil {
		v := model.TaskPlatform(*value.RequiredPlatform)
		platform = &v
	}
	var tags []model.TagReference
	for _, tag := range value.Tags {
		tags = append(tags, model.TagReference{ID: tag.ID, Name: tag.Name})
	}
	return model.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description,
		Properties: taskproperty.Clone(value.Properties), Tags: tags, Status: model.TaskStatus(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt,
		CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn,
		BlockedBy: value.BlockedBy, RequiredPlatform: platform, AssignedTo: value.AssignedTo, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func startupReportValue(t *testing.T, body map[string]any) sp.StartupReport {
	t.Helper()
	value, err := sp.DecodeStartupReport([]byte(jsonBody(t, body)))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func startupReportedTask(t *testing.T, current model.Task, report sp.StartupReport) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	result.Properties["sessionStartup"] = rawProperty(t, report)
	result.Version, result.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	return result
}

func startupReplaceWorker(t *testing.T, current model.Task, change func(*api.WorkerClaim)) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	worker := apiWorker(t, result.Properties)
	change(worker)
	result.Properties["worker"] = rawProperty(t, worker)
	return result
}

// Each request installs a complete plan. A captured write cannot populate the
// facts supplied to a later Task or Session read.
func startupExpectWrite(t *testing.T, f *sessionHTTPFixture, current model.Task, report *sp.StartupReport, matched bool, returned *model.Task, observed *time.Time, principal model.Principal, beforeMatch func()) {
	t.Helper()
	base := newTaskHTTPMockBase(t, "startup")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	tasks := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }}
	counts := map[string]int{}
	var requestContext context.Context
	check := func(ctx context.Context, name string, valid bool) {
		counts[name]++
		if ctx != requestContext || counts[name] != 1 || !valid {
			t.Errorf("startup %s changed context, arguments or count", name)
			panic("invalid startup DAO call")
		}
	}
	project.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
		check(ctx, "access", reflect.DeepEqual(actual, principal))
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		check(ctx, "task", id == current.ID && counts["access"] == 1)
		return current, nil
	}
	if report != nil {
		sessions.MatchSessionStartupFn = func(ctx context.Context, id string, worker *model.WorkerClaim, actual sp.StartupReport) (bool, error) {
			expectedWorker, err := taskproperty.Worker(current.Properties)
			check(ctx, "match", err == nil && id == current.ID && reflect.DeepEqual(worker, expectedWorker) && reflect.DeepEqual(actual, *report) && counts["task"] == 1)
			if beforeMatch != nil {
				beforeMatch()
			}
			return matched, nil
		}
	}
	if observed != nil {
		tasks.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			check(ctx, "observed", counts["task"] == 1)
			return *observed, nil
		}
	}
	if returned != nil {
		wanted := taskcore.CurrentWrite(*returned)
		tasks.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
			check(ctx, "update", id == current.ID && reflect.DeepEqual(values, wanted) && counts["task"] == 1)
			return *returned, nil
		}
		var active *string
		worker, err := taskproperty.Worker(returned.Properties)
		if err != nil {
			t.Fatal(err)
		}
		if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
			active = &worker.ClaimID
		}
		wantDrain := store.TaskSessionDrain{ActiveClaim: active, SourceLifecycle: "active", GraceSeconds: 60,
			TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
			SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, value store.TaskSessionDrain) error {
			check(ctx, "drain", id == current.ID && counts["update"] == 1 && reflect.DeepEqual(value, wantDrain))
			return nil
		}
		wantTransition := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, value store.TaskSessionReceiptTransition) error {
			check(ctx, "receipts", id == current.ID && counts["drain"] == 1 && reflect.DeepEqual(value, wantTransition))
			return nil
		}
		if returned.Status != current.Status {
			capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
			capture.FreezeAudienceFn = func(ctx context.Context, project string, kinds []string) ([]store.WebhookAudience, error) {
				check(ctx, "capture", project == current.ProjectID && counts["receipts"] == 1 && reflect.DeepEqual(kinds, []string{protocol.StatusChanged}))
				return []store.WebhookAudience{}, nil
			}
			scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return capture }
		}
	}
	calls := 0
	f.store.WriteProjectCall = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		calls++
		if calls != 1 || id != current.ProjectID || work == nil {
			unexpectedHTTPCall(t, "startup WriteProject")
		}
		requestContext = ctx
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		if calls != 1 || counts["access"] != 1 || counts["task"] != 1 {
			t.Errorf("startup scope not consumed: calls=%d counts=%v", calls, counts)
		}
		if report != nil && counts["match"] != 1 {
			t.Errorf("startup matcher calls=%d, want1", counts["match"])
		}
		if returned != nil && (counts["update"] != 1 || counts["drain"] != 1 || counts["receipts"] != 1) {
			t.Errorf("startup write incomplete: %v", counts)
		}
		if observed != nil && counts["observed"] != 1 {
			t.Errorf("startup claim time calls=%d, want1", counts["observed"])
		}
		if returned != nil && returned.Status != current.Status && counts["capture"] != 1 {
			t.Errorf("startup status capture calls=%d, want1", counts["capture"])
		}
	})
}

func startupExpectTaskRead(t *testing.T, f *sessionHTTPFixture, value model.Task) {
	t.Helper()
	base := newTaskHTTPMockBase(t, "startup read")
	project := &taskHTTPProjectReaderMock{taskHTTPMockBase: base.withLabel("project")}
	task := &taskHTTPReaderMock{taskHTTPMockBase: base.withLabel("task")}
	access, reads, epochs, snapshots := 0, 0, 0, 0
	var requestContext context.Context
	project.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		access++
		if ctx != requestContext || access != 1 || principal != f.handler.principal || id != value.ProjectID {
			unexpectedHTTPCall(t, "startup read access")
		}
		return model.ProjectAccess{ProjectID: id, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	task.TaskFn = func(ctx context.Context, project, id string) (model.Task, error) {
		reads++
		if ctx != requestContext || access != 1 || reads != 1 || project != value.ProjectID || id != value.ID {
			unexpectedHTTPCall(t, "startup Task read")
		}
		return value, nil
	}
	task.TaskCacheEpochFn = func(ctx context.Context, project string) (string, error) {
		epochs++
		if ctx != requestContext || reads != 1 || epochs != 1 || project != value.ProjectID {
			unexpectedHTTPCall(t, "startup Task epoch")
		}
		return "startup-epoch", nil
	}
	scope := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectReader { return project }, TaskDAOFn: func() store.TaskReader { return task }}
	f.store.ReadSnapshotCall = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		snapshots++
		if snapshots != 1 || work == nil {
			unexpectedHTTPCall(t, "startup snapshot")
		}
		requestContext = ctx
		return work(scope)
	}
	t.Cleanup(func() {
		if snapshots != 1 || access != 1 || reads != 1 || epochs != 1 {
			t.Errorf("startup Task read counts=%d/%d/%d/%d", snapshots, access, reads, epochs)
		}
	})
}

func startupExpectCurrent(t *testing.T, f *sessionHTTPFixture, task store.SessionTask, record store.SessionRecord) {
	t.Helper()
	calls := map[string]int{}
	var requestContext context.Context
	dao := &startupCurrentDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, t: t, f: f, task: task, record: record, calls: calls, context: &requestContext}
	snapshots := 0
	f.store.WriteSessionCall = func(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
		snapshots++
		if snapshots != 1 || work == nil {
			unexpectedHTTPCall(t, "startup current scope")
		}
		requestContext = ctx
		err := work(startupCurrentScope{dao})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		for _, name := range []string{"task", "credential", "access", "current", "bot", "session"} {
			if calls[name] != 1 {
				t.Errorf("startup current %s calls=%d, want1", name, calls[name])
			}
		}
		if snapshots != 1 {
			t.Errorf("startup current scope calls=%d, want1", snapshots)
		}
	})
}

type startupCurrentScope struct{ dao *startupCurrentDAO }

func (s startupCurrentScope) SessionDAO() store.SessionDAO { return s.dao }
func (s startupCurrentScope) BotDAO() store.BotWriteDAO {
	return sessionHTTPRejectedBotDAO{t: s.dao.t}
}

type startupCurrentDAO struct {
	sessionHTTPRejectedDAO
	t       *testing.T
	f       *sessionHTTPFixture
	task    store.SessionTask
	record  store.SessionRecord
	calls   map[string]int
	context *context.Context
}

func (d *startupCurrentDAO) check(ctx context.Context, name string, valid bool) {
	d.calls[name]++
	if ctx != *d.context || d.calls[name] != 1 || !valid {
		unexpectedHTTPCall(d.t, "startup current "+name)
	}
}
func (d *startupCurrentDAO) LockTask(ctx context.Context, project, task string) (store.SessionTask, error) {
	d.check(ctx, "task", project == d.f.task.ProjectID && task == d.f.task.ID)
	return d.task, nil
}
func (d *startupCurrentDAO) LockCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	d.check(ctx, "credential", principal == d.f.handler.principal && !now.IsZero() && d.calls["task"] == 1)
	return nil
}
func (d *startupCurrentDAO) ProjectAccess(ctx context.Context, owner, project string) (model.ProjectAccess, error) {
	d.check(ctx, "access", project == d.f.task.ProjectID && owner == d.f.handler.principal.UserID && d.calls["credential"] == 1)
	return model.ProjectAccess{ProjectID: project, UserID: owner, Role: model.ProjectMemberRole}, nil
}
func (d *startupCurrentDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.check(ctx, "current", project == d.f.task.ProjectID && task == d.f.task.ID && claim == d.record.Snapshot.ClaimID && d.calls["access"] == 1)
	return d.record.Snapshot.SessionID, nil
}
func (d *startupCurrentDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.check(ctx, "bot", id == d.record.Snapshot.SessionID && d.calls["current"] == 1)
	return nil, nil
}
func (d *startupCurrentDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.check(ctx, "session", id == d.record.Snapshot.SessionID && d.calls["bot"] == 1)
	return d.record, nil
}

func startupSessionTask(t *testing.T, current model.Task, report *sp.StartupReport) store.SessionTask {
	t.Helper()
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		t.Fatal(err)
	}
	return store.SessionTask{Worker: worker, Status: string(current.Status), StartupReport: report}
}

func startupTaskDocument(t *testing.T, value model.Task) api.Task {
	t.Helper()
	var platform *string
	if value.RequiredPlatform != nil {
		v := string(*value.RequiredPlatform)
		platform = &v
	}
	tags := make([]taskprotocol.RESTTagReference, 0, len(value.Tags))
	for _, tag := range value.Tags {
		tags = append(tags, taskprotocol.RESTTagReference{ID: tag.ID, Name: tag.Name})
	}
	return api.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description, Properties: taskproperty.Clone(value.Properties), Tags: tags, Status: string(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt, CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn, BlockedBy: value.BlockedBy, AssignedTo: value.AssignedTo, RequiredPlatform: platform, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func (mock *taskHTTPSnapshotScopeMock) TagDAO() store.TagReader {
	mock.need("TagDAO", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectScopeMock) TagDAO() store.TagWriteDAO {
	mock.need("TagDAO", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectScopeMock) TaskTagDAO() store.TaskTagWriteDAO {
	mock.need("TaskTagDAO", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) RotateTagCatalogEpoch(context.Context) error {
	mock.need("RotateTagCatalogEpoch", false)
	panic("unreachable")
}

func (s *taskHTTPSnapshotScopeMock) GitHubDAO() store.GitHubReadDAO {
	panic("unexpected GitHubDAO access")
}

func (s *taskHTTPProjectScopeMock) GitHubDAO() store.GitHubWriteDAO {
	panic("unexpected GitHubDAO access")
}
