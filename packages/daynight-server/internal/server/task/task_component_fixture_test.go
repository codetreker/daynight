package task_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

// Each callback supplies independent facts, writes and completion outcomes.
type httpTestStore struct {
	t                *testing.T
	ReadSnapshotCall func(context.Context, func(store.SnapshotScope) error) error
	WriteThreadCall  func(context.Context, func(store.ThreadScope) error) (store.Completion, error)
	WriteProjectCall func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
}

func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }
func newHTTPTestStoreForPrincipal(t *testing.T, _ model.Principal) *httpTestStore {
	return newHTTPTestStore(t)
}
func (s *httpTestStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	if s.ReadSnapshotCall == nil {
		unexpectedHTTPCall(s.t, "ReadSnapshot")
	}
	return s.ReadSnapshotCall(ctx, run)
}
func (s *httpTestStore) WriteProject(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
	if s.WriteProjectCall == nil {
		unexpectedHTTPCall(s.t, "WriteProject")
	}
	return s.WriteProjectCall(ctx, id, run)
}
func (s *httpTestStore) WriteThread(ctx context.Context, run func(store.ThreadScope) error) (store.Completion, error) {
	if s.WriteThreadCall == nil {
		unexpectedHTTPCall(s.t, "WriteThread")
	}
	return s.WriteThreadCall(ctx, run)
}
func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}
func defaultHTTPPrincipal() model.Principal {
	return model.Principal{UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222", Kind: model.PATCredential}
}
func httpTestToken(kind model.CredentialKind) string {
	const value = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	switch kind {
	case model.PATCredential:
		return "dnpat_" + value
	case model.SessionCredential:
		return "dnst_" + value
	case model.OAuthCredential:
		return model.OAuthAccessPrefix + value
	default:
		panic("unsupported HTTP fixture credential")
	}
}
func defaultHTTPToken() string { return httpTestToken(model.PATCredential) }

func taskComponentHandler(t *testing.T, database *httpTestStore, output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	handler := &resourceTestHandler{token: httpTestToken(principal.Kind), principal: principal}
	handler.AuthenticateFunc = func(_ context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if kind != principal.Kind || credential != handler.token {
			return model.Principal{}, authhttp.Failure()
		}
		return handler.principal, nil
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		return handler.AuthenticateFunc(ctx, kind, credential)
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	engine := sessioncore.NewEngine(nil)
	tasks := taskservice.NewTasks(database)
	observations := taskservice.NewObservations(database, engine)
	sync := taskservice.NewTaskSync(database, engine, 10*time.Second)
	mux := http.NewServeMux()
	taskhttp.TaskRoutes(mux, tasks, observations, auth, logger)
	taskhttp.TaskSyncRoutes(mux, sync.Get, auth, logger, 10*time.Second)
	handler.Handler = httpx.RequestLogging(logger, httpx.LimitRequestTarget(logger, mux))
	return handler
}

type httpCallPlan struct {
	t          *testing.T
	mu         sync.Mutex
	want, seen map[string]int
}

func newHTTPCallPlan(t *testing.T, want map[string]int) *httpCallPlan {
	t.Helper()
	p := &httpCallPlan{t: t, want: make(map[string]int, len(want)), seen: make(map[string]int)}
	for name, count := range want {
		p.want[name] = count
	}
	t.Cleanup(p.Verify)
	return p
}
func (p *httpCallPlan) Called(name string) {
	p.mu.Lock()
	p.seen[name]++
	got, want := p.seen[name], p.want[name]
	p.mu.Unlock()
	if got > want {
		unexpectedHTTPCall(p.t, name)
	}
}
func (p *httpCallPlan) Verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, want := range p.want {
		if p.seen[name] != want {
			p.t.Errorf("DAO %s calls = %d, want %d", name, p.seen[name], want)
		}
	}
}

type taskHTTPMockBase struct {
	t     *testing.T
	label string
}

func newTaskHTTPMockBase(t *testing.T, label string) taskHTTPMockBase {
	t.Helper()
	return taskHTTPMockBase{t: t, label: label}
}

func (base taskHTTPMockBase) withLabel(label string) taskHTTPMockBase {
	base.label = label
	return base
}

func (base taskHTTPMockBase) need(method string, configured bool) {
	base.t.Helper()
	name := base.label + "." + method
	if !configured {
		base.t.Errorf("unexpected DAO call %s", name)
		panic(fmt.Sprintf("unexpected DAO call %s", name))
	}
}

type taskHTTPSnapshotScopeMock struct {
	AttachmentDAOFn func() store.AttachmentReader
	taskHTTPMockBase
	CredentialDAOFn func() store.CredentialReader
	ProjectDAOFn    func() store.ProjectReader
	TaskDAOFn       func() store.TaskReader
	SessionDAOFn    func() store.SessionReader
	ObservedAtFn    func(context.Context) (time.Time, error)
}

func (mock *taskHTTPSnapshotScopeMock) CredentialDAO() store.CredentialReader {
	mock.need("CredentialDAO", mock.CredentialDAOFn != nil)
	return mock.CredentialDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) TeamDAO() store.TeamReader {
	mock.need("TeamDAO", false)
	panic("unreachable")
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
	mock.need("WorkerDAO", false)
	panic("unreachable")
}

func (mock *taskHTTPSnapshotScopeMock) SessionDAO() store.SessionReader {
	mock.need("SessionDAO", mock.SessionDAOFn != nil)
	return mock.SessionDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) BotDAO() store.BotReader {
	mock.need("BotDAO", false)
	panic("unreachable")
}

func (mock *taskHTTPSnapshotScopeMock) AttachmentDAO() store.AttachmentReader {
	mock.need("AttachmentDAO", mock.AttachmentDAOFn != nil)
	return mock.AttachmentDAOFn()
}

func (mock *taskHTTPSnapshotScopeMock) ObservedAt(p0 context.Context) (time.Time, error) {
	mock.need("ObservedAt", mock.ObservedAtFn != nil)
	return mock.ObservedAtFn(p0)
}

type taskHTTPProjectScopeMock struct {
	taskHTTPMockBase
	CaptureDAOFn func() store.WebhookCaptureDAO
	ProjectDAOFn func() store.ProjectWriteDAO
	TaskDAOFn    func() store.TaskWriteDAO
	SessionDAOFn func() store.ProjectSessionDAO
}

func (mock *taskHTTPProjectScopeMock) EligibilityDAO() store.WebhookEligibilityDAO {
	mock.need("EligibilityDAO", false)
	panic("unreachable")
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

type taskHTTPReaderMock struct {
	TaskHeaderFn func(context.Context, string, string) (model.TaskHeader, error)
	TaskStepFn   func(context.Context, string, string) (model.TaskStep, error)
	TaskStepsFn  func(context.Context, string) ([]model.TaskStep, error)
	taskHTTPMockBase
	TaskFn                     func(context.Context, string, string) (model.Task, error)
	TaskBodiesFn               func(context.Context, string, []string) ([]model.Task, error)
	GoalProgressesFn           func(context.Context, string, []string) (map[string]model.GoalProgress, error)
	TasksFn                    func(context.Context, string, store.TaskQuery) (store.TaskPage, error)
	TaskPresenceFn             func(context.Context, string, string) (store.TaskPresence, error)
	ThreadCandidatesFn         func(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSidesFn              func(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
	TaskAssigneesFn            func(context.Context, string) ([]model.TaskAssigneeFact, error)
	ResolveTaskAssigneesFn     func(context.Context, string, []string) ([]model.TaskAssigneeFact, error)
	TaskGraphTasksFn           func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
	TaskCacheEpochFn           func(context.Context, string) (string, error)
	TaskSyncTasksFn            func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	TaskSyncDependencyStatesFn func(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
}

func (mock *taskHTTPReaderMock) Task(p0 context.Context, p1 string, p2 string) (model.Task, error) {
	mock.need("Task", mock.TaskFn != nil)
	return mock.TaskFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskBodies(ctx context.Context, project string, ids []string) ([]model.Task, error) {
	mock.need("TaskBodies", mock.TaskBodiesFn != nil)
	return mock.TaskBodiesFn(ctx, project, ids)
}

func (mock *taskHTTPReaderMock) GoalProgresses(ctx context.Context, project string, ids []string) (map[string]model.GoalProgress, error) {
	mock.need("GoalProgresses", mock.GoalProgressesFn != nil)
	return mock.GoalProgressesFn(ctx, project, ids)
}

func (mock *taskHTTPReaderMock) Tasks(p0 context.Context, p1 string, p2 store.TaskQuery) (store.TaskPage, error) {
	mock.need("Tasks", mock.TasksFn != nil)
	return mock.TasksFn(p0, p1, p2)
}

func (mock *taskHTTPReaderMock) TaskListFence(p0 context.Context, p1 string) (store.TaskListFence, error) {
	mock.need("TaskListFence", false)
	panic("unreachable")
}

func (mock *taskHTTPReaderMock) TaskPriorityList(p0 context.Context, p1 string, p2 store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	mock.need("TaskPriorityList", false)
	panic("unreachable")
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
	mock.need("TaskStepPage", false)
	panic("unreachable")
}

func (mock *taskHTTPReaderMock) TaskStepSummary(p0 context.Context, p1 string, p2 string) (store.TaskStepProjection, error) {
	mock.need("TaskStepSummary", false)
	panic("unreachable")
}

func (mock *taskHTTPReaderMock) ThreadMessage(p0 context.Context, p1 string, p2 string) (model.ThreadMessage, error) {
	mock.need("ThreadMessage", false)
	panic("unreachable")
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

func (mock *taskHTTPReaderMock) TaskSyncDependencyStates(ctx context.Context, projectID string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
	mock.need("TaskSyncDependencyStates", mock.TaskSyncDependencyStatesFn != nil)
	return mock.TaskSyncDependencyStatesFn(ctx, projectID, lower)
}

type taskHTTPWriterMock struct {
	ParentTaskFn     func(context.Context, string) (model.Task, error)
	GoalProgressesFn func(context.Context, string, []string) (map[string]model.GoalProgress, error)
	TaskHeaderFn     func(context.Context, string) (model.TaskHeader, error)
	TaskStepsFn      func(context.Context, string) ([]model.TaskStep, error)
	InsertTaskStepFn func(context.Context, string, model.TaskStep) error
	TouchTaskFn      func(context.Context, string, time.Time) error
	UpdateTaskStepFn func(context.Context, string, model.TaskStep) error
	MoveTaskStepFn   func(context.Context, string, string, int64, int64) error
	DeleteTaskStepFn func(context.Context, string, string, int64, int64) error
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

func (mock *taskHTTPWriterMock) VisibleTaskIDs(p0 context.Context, p1 []string) ([]string, error) {
	mock.need("VisibleTaskIDs", mock.VisibleTaskIDsFn != nil)
	return mock.VisibleTaskIDsFn(p0, p1)
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

type taskHTTPProjectReaderMock struct {
	taskHTTPMockBase
	ProjectFn       func(context.Context, string) (model.Project, error)
	ProjectAccessFn func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (mock *taskHTTPProjectReaderMock) Project(p0 context.Context, p1 string) (model.Project, error) {
	mock.need("Project", mock.ProjectFn != nil)
	return mock.ProjectFn(p0, p1)
}

func (mock *taskHTTPProjectReaderMock) Projects(p0 context.Context, p1 store.Page) (store.ProjectPage, error) {
	mock.need("Projects", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) DirectProjectMember(p0 context.Context, p1 string, p2 string) (model.ProjectMember, error) {
	mock.need("DirectProjectMember", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) ProjectParticipants(p0 context.Context, p1 string) ([]model.ProjectParticipant, error) {
	mock.need("ProjectParticipants", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) Invitation(p0 context.Context, p1 []byte) (model.ProjectInvitation, error) {
	mock.need("Invitation", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) Invitations(p0 context.Context, p1 string, p2 time.Time) ([]model.ProjectInvitation, error) {
	mock.need("Invitations", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) ProjectAccess(p0 context.Context, p1 model.Principal, p2 string) (model.ProjectAccess, error) {
	mock.need("ProjectAccess", mock.ProjectAccessFn != nil)
	return mock.ProjectAccessFn(p0, p1, p2)
}

func (mock *taskHTTPProjectReaderMock) AccessibleProjects(p0 context.Context, p1 model.Principal, p2 store.Page) (store.ProjectPage, error) {
	mock.need("AccessibleProjects", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) ScopedProjects(p0 context.Context, p1 model.Principal, p2 store.ProjectScope, p3 store.Page) (store.ProjectPage, error) {
	mock.need("ScopedProjects", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) TransferTeam(p0 context.Context, p1 string) (store.TransferTeam, error) {
	mock.need("TransferTeam", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectReaderMock) TransferRole(p0 context.Context, p1 string, p2 string, p3 string) (*model.ProjectRole, error) {
	mock.need("TransferRole", false)
	panic("unreachable")
}

type taskHTTPProjectWriterMock struct {
	taskHTTPMockBase
	InvalidateTaskCacheFn func(context.Context) error
	ProjectFn             func(context.Context) (model.Project, error)
	ProjectAccessFn       func(context.Context, model.Principal) (model.ProjectAccess, error)
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
	mock.need("UpdateProjectSettings", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) DirectProjectMember(p0 context.Context, p1 string) (model.ProjectMember, error) {
	mock.need("DirectProjectMember", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) SetMemberRole(p0 context.Context, p1 string, p2 model.ProjectRole) (model.ProjectMember, error) {
	mock.need("SetMemberRole", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) RemoveMember(p0 context.Context, p1 string) error {
	mock.need("RemoveMember", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) AddInvitedMember(p0 context.Context, p1 string) (model.ProjectMember, error) {
	mock.need("AddInvitedMember", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) LockInvitation(p0 context.Context, p1 []byte) (model.ProjectInvitation, error) {
	mock.need("LockInvitation", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) CreateInvitation(p0 context.Context, p1 model.ProjectInvitation) error {
	mock.need("CreateInvitation", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) RevokeInvitation(p0 context.Context, p1 string, p2 time.Time) error {
	mock.need("RevokeInvitation", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) ConsumeInvitation(p0 context.Context, p1 string, p2 string, p3 time.Time) error {
	mock.need("ConsumeInvitation", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) DirectGrant(p0 context.Context, p1 string) (model.ProjectGrant, error) {
	mock.need("DirectGrant", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) CreateGrant(p0 context.Context, p1 string, p2 model.ProjectRole) (model.ProjectGrant, error) {
	mock.need("CreateGrant", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) LockTransferOwnership(p0 context.Context) (model.ProjectOwnership, error) {
	mock.need("LockTransferOwnership", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) LockTransferTeams(p0 context.Context, p1 string, p2 string) (store.TransferTeam, store.TransferTeam, error) {
	mock.need("LockTransferTeams", false)
	panic("unreachable")
}

func (mock *taskHTTPProjectWriterMock) MoveOwnership(p0 context.Context, p1 string) (model.ProjectOwnership, error) {
	mock.need("MoveOwnership", false)
	panic("unreachable")
}

type taskHTTPSessionReaderMock struct {
	taskHTTPMockBase
	CurrentTaskSessionSourcesFn func(context.Context, string) ([]store.TaskSessionSource, error)
	TaskSessionSourcesFn        func(context.Context, string, []string) ([]store.TaskSessionSource, error)
}

func (mock *taskHTTPSessionReaderMock) CurrentTaskSessionSources(p0 context.Context, p1 string) ([]store.TaskSessionSource, error) {
	mock.need("CurrentTaskSessionSources", mock.CurrentTaskSessionSourcesFn != nil)
	return mock.CurrentTaskSessionSourcesFn(p0, p1)
}

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

type taskHTTPCaptureDAOMock struct {
	taskHTTPMockBase
	FreezeAudienceFn func(context.Context, string, []string) ([]store.WebhookAudience, error)
}

func (mock *taskHTTPCaptureDAOMock) FreezeAudience(p0 context.Context, p1 string, p2 []string) ([]store.WebhookAudience, error) {
	mock.need("FreezeAudience", mock.FreezeAudienceFn != nil)
	return mock.FreezeAudienceFn(p0, p1, p2)
}

func (mock *taskHTTPCaptureDAOMock) RecordedAt(p0 context.Context) (time.Time, error) {
	mock.need("RecordedAt", false)
	panic("unreachable")
}

func (mock *taskHTTPCaptureDAOMock) Policy(p0 context.Context, p1 int64) (webhook.Policy, error) {
	mock.need("Policy", false)
	panic("unreachable")
}

func (mock *taskHTTPCaptureDAOMock) SaveCapture(p0 context.Context, p1 store.WebhookCapturedEvent, p2 []store.WebhookCapturedDelivery) error {
	mock.need("SaveCapture", false)
	panic("unreachable")
}

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

func copyTaskHTTPWrite(values store.TaskWrite) store.TaskWrite {
	values.Properties = copyTaskHTTPProperties(values.Properties)
	values.DependsOn = copyTaskHTTPSlice(values.DependsOn)
	values.ExternalDependsOn = copyTaskHTTPSlice(values.ExternalDependsOn)
	values.AssignedTo = copyTaskHTTPPointer(values.AssignedTo)
	values.RequiredPlatform = copyTaskHTTPPointer(values.RequiredPlatform)
	return values
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

func copyTaskHTTPSyncRows(rows []model.TaskViewRecord) []model.TaskViewRecord {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.Properties = copyTaskHTTPProperties(row.Properties)
		row.DependsOn = copyTaskHTTPSlice(row.DependsOn)
		row.ExternalDependsOn = copyTaskHTTPSlice(row.ExternalDependsOn)
		row.AssignedTo = copyTaskHTTPPointer(row.AssignedTo)
		row.RequiredPlatform = copyTaskHTTPPointer(row.RequiredPlatform)
		row.StartedAt = copyTaskHTTPPointer(row.StartedAt)
		row.CompletedAt = copyTaskHTTPPointer(row.CompletedAt)
		row.CancelledAt = copyTaskHTTPPointer(row.CancelledAt)
	}
	return result
}

func copyTaskHTTPAssigneeFacts(rows []model.TaskAssigneeFact) []model.TaskAssigneeFact {
	result := copyTaskHTTPSlice(rows)
	for index := range result {
		row := &result[index]
		row.ProfileID = copyTaskHTTPPointer(row.ProfileID)
		row.Name = copyTaskHTTPPointer(row.Name)
		row.AvatarURL = copyTaskHTTPPointer(row.AvatarURL)
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
	f.handler = taskComponentHandler(t, f.store, io.Discard, principal)
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
		if query.TagFilter.TagMatch == "" {
			query.TagFilter.TagMatch = "all"
		}
		query.TagFilter.TagIDs = append([]string{}, query.TagFilter.TagIDs...)
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

func (f *taskHTTPFixture) expectSync(rows []model.TaskViewRecord, states map[string]model.TaskDependencyState, facts []model.TaskAssigneeFact, lower *time.Time) {
	f.t.Helper()
	rows, facts, lower = copyTaskHTTPSyncRows(rows), copyTaskHTTPAssigneeFacts(facts), copyTaskHTTPPointer(lower)
	stateCopy := make(map[string]model.TaskDependencyState, len(states))
	for id, state := range states {
		state.BlockedBy = copyTaskHTTPSlice(state.BlockedBy)
		stateCopy[id] = state
	}
	f.expectSnapshot(map[string]int{"project": 1, "epoch": 1, "sync": 1, "dependencies": 1, "people": 1, "observed": 1, "sessions": 1}, func(reader *taskHTTPReaderMock, _ *taskHTTPProjectReaderMock, sessions *taskHTTPSessionReaderMock, _ *taskHTTPSnapshotScopeMock, plan *httpCallPlan) {
		reader.TaskCacheEpochFn = func(ctx context.Context, id string) (string, error) {
			f.require(ctx, id)
			plan.Called("epoch")
			return taskHTTPEpoch, nil
		}
		reader.TaskSyncTasksFn = func(ctx context.Context, id string, since *time.Time, preview int) ([]model.TaskViewRecord, error) {
			f.require(ctx, id)
			plan.Called("sync")
			if !reflect.DeepEqual(since, lower) || preview != projection.TitlePreviewCharacters {
				unexpectedHTTPCall(f.t, "TaskSync arguments")
			}
			return copyTaskHTTPSyncRows(rows), nil
		}
		reader.TaskSyncDependencyStatesFn = func(ctx context.Context, id string, since *time.Time) (map[string]model.TaskDependencyState, error) {
			f.require(ctx, id)
			plan.Called("dependencies")
			if !reflect.DeepEqual(since, lower) {
				unexpectedHTTPCall(f.t, "TaskSync dependency arguments")
			}
			result := make(map[string]model.TaskDependencyState, len(stateCopy))
			for id, state := range stateCopy {
				state.BlockedBy = copyTaskHTTPSlice(state.BlockedBy)
				result[id] = state
			}
			return result, nil
		}
		reader.TaskAssigneesFn = func(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
			f.require(ctx, id)
			plan.Called("people")
			return copyTaskHTTPAssigneeFacts(facts), nil
		}
		sessions.CurrentTaskSessionSourcesFn = func(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
			f.require(ctx, id)
			plan.Called("sessions")
			return []store.TaskSessionSource{}, nil
		}
	})
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
