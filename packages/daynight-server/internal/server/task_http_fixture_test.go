package server

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

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

type taskHTTPStoreMock struct {
	taskHTTPMockBase
	ReadSnapshotFn func(context.Context, func(store.SnapshotScope) error) error
	WriteProjectFn func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
	WriteThreadFn  func(context.Context, func(store.ThreadScope) error) (store.Completion, error)
}

func (mock *taskHTTPStoreMock) ReadSnapshot(p0 context.Context, p1 func(store.SnapshotScope) error) error {
	mock.need("ReadSnapshot", mock.ReadSnapshotFn != nil)
	return mock.ReadSnapshotFn(p0, p1)
}

func (mock *taskHTTPStoreMock) WriteProject(p0 context.Context, p1 string, p2 func(store.ProjectWriteScope) error) (store.Completion, error) {
	mock.need("WriteProject", mock.WriteProjectFn != nil)
	return mock.WriteProjectFn(p0, p1, p2)
}

func (mock *taskHTTPStoreMock) WriteThread(p0 context.Context, p1 func(store.ThreadScope) error) (store.Completion, error) {
	mock.need("WriteThread", mock.WriteThreadFn != nil)
	return mock.WriteThreadFn(p0, p1)
}

var _ store.SnapshotReader = (*taskHTTPStoreMock)(nil)

var _ store.ProjectWriter = (*taskHTTPStoreMock)(nil)

var _ store.ThreadWriter = (*taskHTTPStoreMock)(nil)

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

type taskHTTPThreadScopeMock struct {
	taskHTTPMockBase
	CaptureDAOFn    func() store.WebhookCaptureDAO
	TaskDAOFn       func() store.ThreadTaskDAO
	CredentialDAOFn func() store.ThreadCredentialDAO
	ProjectDAOFn    func() store.ThreadProjectDAO
	ThreadDAOFn     func() store.ThreadDAO
}

func (mock *taskHTTPThreadScopeMock) CaptureDAO() store.WebhookCaptureDAO {
	mock.need("CaptureDAO", mock.CaptureDAOFn != nil)
	return mock.CaptureDAOFn()
}

func (mock *taskHTTPThreadScopeMock) TaskDAO() store.ThreadTaskDAO {
	mock.need("TaskDAO", mock.TaskDAOFn != nil)
	return mock.TaskDAOFn()
}

func (mock *taskHTTPThreadScopeMock) CredentialDAO() store.ThreadCredentialDAO {
	mock.need("CredentialDAO", mock.CredentialDAOFn != nil)
	return mock.CredentialDAOFn()
}

func (mock *taskHTTPThreadScopeMock) ProjectDAO() store.ThreadProjectDAO {
	mock.need("ProjectDAO", mock.ProjectDAOFn != nil)
	return mock.ProjectDAOFn()
}

func (mock *taskHTTPThreadScopeMock) ThreadDAO() store.ThreadDAO {
	mock.need("ThreadDAO", mock.ThreadDAOFn != nil)
	return mock.ThreadDAOFn()
}

var _ store.ThreadScope = (*taskHTTPThreadScopeMock)(nil)

type taskHTTPReaderMock struct {
	taskHTTPMockBase
	TaskFn                 func(context.Context, string, string) (model.Task, error)
	TasksFn                func(context.Context, string, store.TaskQuery) (store.TaskPage, error)
	TaskListFenceFn        func(context.Context, string) (store.TaskListFence, error)
	TaskPriorityListFn     func(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error)
	TaskPresenceFn         func(context.Context, string, string) (store.TaskPresence, error)
	TaskHeaderFn           func(context.Context, string, string) (model.TaskHeader, error)
	TaskStepFn             func(context.Context, string, string) (model.TaskStep, error)
	TaskStepsFn            func(context.Context, string) ([]model.TaskStep, error)
	TaskStepPageFn         func(context.Context, string, int64, int, bool) ([]store.TaskStepProjection, error)
	TaskStepSummaryFn      func(context.Context, string, string) (store.TaskStepProjection, error)
	ThreadMessageFn        func(context.Context, string, string) (model.ThreadMessage, error)
	ThreadCandidatesFn     func(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error)
	ThreadSidesFn          func(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error)
	TaskAssigneesFn        func(context.Context, string) ([]model.TaskAssigneeFact, error)
	ResolveTaskAssigneesFn func(context.Context, string, []string) ([]model.TaskAssigneeFact, error)
	TaskGraphTasksFn       func(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error)
	TaskCacheEpochFn       func(context.Context, string) (string, error)
	TaskSyncTasksFn        func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
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

var _ store.TaskReader = (*taskHTTPReaderMock)(nil)

type taskHTTPWriterMock struct {
	taskHTTPMockBase
	TaskFn               func(context.Context, string) (model.Task, error)
	TasksByIDFn          func(context.Context, []string) ([]model.Task, error)
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

func (mock *taskHTTPWriterMock) Task(p0 context.Context, p1 string) (model.Task, error) {
	mock.need("Task", mock.TaskFn != nil)
	return mock.TaskFn(p0, p1)
}

func (mock *taskHTTPWriterMock) TasksByID(p0 context.Context, p1 []string) ([]model.Task, error) {
	mock.need("TasksByID", mock.TasksByIDFn != nil)
	return mock.TasksByIDFn(p0, p1)
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

type taskHTTPThreadTaskMock struct {
	taskHTTPMockBase
	LockTaskPresenceFn func(context.Context, string, string) (store.TaskPresence, error)
	SourceTaskFn       func(context.Context, string, string) (model.Task, error)
}

func (mock *taskHTTPThreadTaskMock) LockTaskPresence(p0 context.Context, p1 string, p2 string) (store.TaskPresence, error) {
	mock.need("LockTaskPresence", mock.LockTaskPresenceFn != nil)
	return mock.LockTaskPresenceFn(p0, p1, p2)
}

func (mock *taskHTTPThreadTaskMock) SourceTask(p0 context.Context, p1 string, p2 string) (model.Task, error) {
	mock.need("SourceTask", mock.SourceTaskFn != nil)
	return mock.SourceTaskFn(p0, p1, p2)
}

var _ store.ThreadTaskDAO = (*taskHTTPThreadTaskMock)(nil)

type taskHTTPThreadCredentialMock struct {
	taskHTTPMockBase
	CredentialFn      func(context.Context, model.Principal) (store.ThreadCredential, error)
	CredentialValidFn func(context.Context, store.ThreadCredential) (bool, error)
	AuthorNameFn      func(context.Context, string) (*string, error)
}

func (mock *taskHTTPThreadCredentialMock) Credential(p0 context.Context, p1 model.Principal) (store.ThreadCredential, error) {
	mock.need("Credential", mock.CredentialFn != nil)
	return mock.CredentialFn(p0, p1)
}

func (mock *taskHTTPThreadCredentialMock) CredentialValid(p0 context.Context, p1 store.ThreadCredential) (bool, error) {
	mock.need("CredentialValid", mock.CredentialValidFn != nil)
	return mock.CredentialValidFn(p0, p1)
}

func (mock *taskHTTPThreadCredentialMock) AuthorName(p0 context.Context, p1 string) (*string, error) {
	mock.need("AuthorName", mock.AuthorNameFn != nil)
	return mock.AuthorNameFn(p0, p1)
}

var _ store.ThreadCredentialDAO = (*taskHTTPThreadCredentialMock)(nil)

type taskHTTPThreadProjectMock struct {
	taskHTTPMockBase
	LockProjectAuthorizationFn func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (mock *taskHTTPThreadProjectMock) LockProjectAuthorization(p0 context.Context, p1 model.Principal, p2 string) (model.ProjectAccess, error) {
	mock.need("LockProjectAuthorization", mock.LockProjectAuthorizationFn != nil)
	return mock.LockProjectAuthorizationFn(p0, p1, p2)
}

var _ store.ThreadProjectDAO = (*taskHTTPThreadProjectMock)(nil)

type taskHTTPThreadDAOMock struct {
	taskHTTPMockBase
	LockHeadFn         func(context.Context, string) (*model.ThreadPosition, error)
	ThreadMessageFn    func(context.Context, string, string) (model.ThreadMessage, error)
	InsertMessageFn    func(context.Context, model.ThreadMessage) (model.ThreadMessage, error)
	PrepareTimestampFn func(context.Context, *model.ThreadMessage, *model.ThreadPosition) error
	AdvanceHeadFn      func(context.Context, string, model.ThreadPosition) error
}

func (mock *taskHTTPThreadDAOMock) LockHead(p0 context.Context, p1 string) (*model.ThreadPosition, error) {
	mock.need("LockHead", mock.LockHeadFn != nil)
	return mock.LockHeadFn(p0, p1)
}

func (mock *taskHTTPThreadDAOMock) ThreadMessage(p0 context.Context, p1 string, p2 string) (model.ThreadMessage, error) {
	mock.need("ThreadMessage", mock.ThreadMessageFn != nil)
	return mock.ThreadMessageFn(p0, p1, p2)
}

func (mock *taskHTTPThreadDAOMock) InsertMessage(p0 context.Context, p1 model.ThreadMessage) (model.ThreadMessage, error) {
	mock.need("InsertMessage", mock.InsertMessageFn != nil)
	return mock.InsertMessageFn(p0, p1)
}

func (mock *taskHTTPThreadDAOMock) PrepareTimestamp(p0 context.Context, p1 *model.ThreadMessage, p2 *model.ThreadPosition) error {
	mock.need("PrepareTimestamp", mock.PrepareTimestampFn != nil)
	return mock.PrepareTimestampFn(p0, p1, p2)
}

func (mock *taskHTTPThreadDAOMock) AdvanceHead(p0 context.Context, p1 string, p2 model.ThreadPosition) error {
	mock.need("AdvanceHead", mock.AdvanceHeadFn != nil)
	return mock.AdvanceHeadFn(p0, p1, p2)
}

var _ store.ThreadDAO = (*taskHTTPThreadDAOMock)(nil)

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

type eligibilityDAOMock struct {
	taskHTTPMockBase
	ReadEligibilityFn func(context.Context, webhook.Owner, string, string) (store.WebhookEligibility, error)
	LockAffectedFn    func(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error)
	RevokeFn          func(context.Context, string, int64) error
}

func (mock *eligibilityDAOMock) ReadEligibility(p0 context.Context, p1 webhook.Owner, p2 string, p3 string) (store.WebhookEligibility, error) {
	mock.need("ReadEligibility", mock.ReadEligibilityFn != nil)
	return mock.ReadEligibilityFn(p0, p1, p2, p3)
}

func (mock *eligibilityDAOMock) LockAffected(p0 context.Context, p1 store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	mock.need("LockAffected", mock.LockAffectedFn != nil)
	return mock.LockAffectedFn(p0, p1)
}

func (mock *eligibilityDAOMock) Revoke(p0 context.Context, p1 string, p2 int64) error {
	mock.need("Revoke", mock.RevokeFn != nil)
	return mock.RevokeFn(p0, p1, p2)
}

var _ store.WebhookEligibilityDAO = (*eligibilityDAOMock)(nil)

type taskHTTPWorkerReaderMock struct {
	taskHTTPMockBase
	WorkersFn             func(context.Context, string, time.Time, store.Page) (store.WorkerPage, error)
	WorkerSummariesFn     func(context.Context, string, time.Time, store.Page) (store.WorkerSummaryPage, error)
	WorkerFn              func(context.Context, string, string, time.Time) (model.WorkerSnapshot, error)
	WorkerConfigurationFn func(context.Context, string, string) (model.WorkerConfigurationResource, error)
}

func (mock *taskHTTPWorkerReaderMock) Workers(p0 context.Context, p1 string, p2 time.Time, p3 store.Page) (store.WorkerPage, error) {
	mock.need("Workers", mock.WorkersFn != nil)
	return mock.WorkersFn(p0, p1, p2, p3)
}

func (mock *taskHTTPWorkerReaderMock) WorkerSummaries(p0 context.Context, p1 string, p2 time.Time, p3 store.Page) (store.WorkerSummaryPage, error) {
	mock.need("WorkerSummaries", mock.WorkerSummariesFn != nil)
	return mock.WorkerSummariesFn(p0, p1, p2, p3)
}

func (mock *taskHTTPWorkerReaderMock) Worker(p0 context.Context, p1 string, p2 string, p3 time.Time) (model.WorkerSnapshot, error) {
	mock.need("Worker", mock.WorkerFn != nil)
	return mock.WorkerFn(p0, p1, p2, p3)
}

func (mock *taskHTTPWorkerReaderMock) WorkerConfiguration(p0 context.Context, p1 string, p2 string) (model.WorkerConfigurationResource, error) {
	mock.need("WorkerConfiguration", mock.WorkerConfigurationFn != nil)
	return mock.WorkerConfigurationFn(p0, p1, p2)
}

var _ store.WorkerReader = (*taskHTTPWorkerReaderMock)(nil)

func taskHTTPMockModels() (model.Project, model.Task, model.Principal) {
	observed := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	principal := defaultHTTPPrincipal()
	project := model.Project{ID: "33333333-3333-4333-8333-333333333333", Name: "Project", RepoURL: "https://github.com/example/repository", CreatedAt: observed, UpdatedAt: observed, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}, Ownership: model.ProjectOwnership{TeamID: "44444444-4444-4444-8444-444444444444", Version: 1, UpdatedAt: observed}}
	task := model.Task{ID: "55555555-5555-4555-8555-555555555555", ProjectID: project.ID, Title: "Task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: observed, UpdatedAt: observed, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &principal.UserID, Ready: true}
	return project, task, principal
}

func taskHTTPMockAccess(project model.Project, principal model.Principal) model.ProjectAccess {
	return model.ProjectAccess{ProjectID: project.ID, UserID: principal.UserID, Role: model.ProjectAdmin, OwnerTeam: model.TeamRef{ID: project.Ownership.TeamID, Kind: "personal"}, Ownership: project.Ownership}
}

func taskHTTPMockStep(id string, position int64) model.TaskStep {
	observed := time.Date(2026, time.January, 2, 3, 4, 5, 0, time.UTC)
	return model.TaskStep{ID: id, Position: position, Title: "Step", Status: model.TaskStepTodo, CreatedAt: observed, UpdatedAt: observed}
}

func (mock *taskHTTPReaderMock) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	mock.need("TaskWorkGroups", false)
	panic("unreachable")
}
func (mock *taskHTTPReaderMock) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	mock.need("TaskWorkTargets", false)
	panic("unreachable")
}
func (mock *taskHTTPSessionReaderMock) TaskSessionSources(context.Context, string, []string) ([]store.TaskSessionSource, error) {
	mock.need("TaskSessionSources", false)
	panic("unreachable")
}
func (mock *taskHTTPSessionReaderMock) TaskSessionInspectionSource(context.Context, string, string, string) (store.TaskSessionSource, error) {
	mock.need("TaskSessionInspectionSource", false)
	panic("unreachable")
}
