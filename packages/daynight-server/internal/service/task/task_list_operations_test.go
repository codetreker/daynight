package task

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const listOperationProject = "abcdef22-2222-4222-8222-222222222222"
const listOperationActor = "abcdef11-1111-4111-8111-111111111111"
const listOperationWorker = "abcdef66-6666-4666-8666-666666666666"

type listOperationContextKey struct{}

func listOperationPointer[T any](value T) *T { return &value }

func listOperationRows() []model.Task {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	rows := make([]model.Task, 2)
	for i, id := range []string{"abcdef44-4444-4444-8444-444444444444", "abcdef33-3333-4333-8333-333333333333"} {
		rows[i] = model.Task{ID: id, ProjectID: listOperationProject, Title: "List result", Description: "Preserved material",
			Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Evidence"}]`)},
			Status:     model.TaskInProgress, Version: 7, AssignedTo: listOperationPointer(listOperationActor),
			CreatedAt: at.Add(time.Duration(i)), UpdatedAt: at, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}}
	}
	return rows
}

type listOperationFixture struct {
	t               *testing.T
	ctx             context.Context
	contextValue    *int
	principal       model.Principal
	service         *Tasks
	request         TaskListRequest
	selection       taskcore.ListSelection
	projectDAO      *listOperationCapability
	taskDAO         *listOperationCapability
	page            store.TaskPage
	authorization   error
	readError       error
	readFault       *model.Fault
	callbackError   error
	completionError error
	active          bool
	snapshots       int
	want, trace     []string
}

func newListOperationFixture(t *testing.T) *listOperationFixture {
	t.Helper()
	marker := new(int)
	*marker = 47
	f := &listOperationFixture{t: t, ctx: context.WithValue(t.Context(), listOperationContextKey{}, marker), contextValue: marker,
		principal: model.Principal{UserID: listOperationActor, CredentialID: "abcdef77-7777-4777-8777-777777777777", Kind: model.SessionCredential},
		page:      store.TaskPage{Items: listOperationRows(), HasMore: true},
		want:      []string{"snapshot enter", "ProjectDAO", "authorization", "TaskDAO", "ReadList", "snapshot completion"}}
	f.projectDAO = &listOperationCapability{fixture: f, name: "project"}
	f.taskDAO = &listOperationCapability{fixture: f, name: "task"}
	f.request = TaskListRequest{PageRequest: model.PageRequest{Limit: 2}, AssignedTo: listOperationPointer("me"),
		Status: listOperationPointer(model.TaskInProgress), Ready: listOperationPointer(false), AllowAgents: listOperationPointer(true),
		CompatiblePlatform: listOperationPointer(model.PlatformLinux), PlatformSpecific: listOperationPointer(false), AutomaticCandidate: true, WorkerID: listOperationPointer(strings.ToUpper(listOperationWorker))}
	f.selection = taskcore.ListSelection{
		Scope: query.ListScope{TagFilterIdentity: taskcore.TagFilterIdentity(store.TagFilter{TagIDs: []string{}, TagMatch: "all"}), Type: model.TaskTypeTask, Kind: "tasks", ProjectID: listOperationProject, Status: listOperationPointer("in_progress"), Ready: listOperationPointer(false),
			AllowAgents: listOperationPointer(true), CompatiblePlatform: listOperationPointer(model.PlatformLinux), PlatformSpecific: listOperationPointer(false), AutomaticCandidate: true,
			WorkerID: listOperationPointer(listOperationWorker), WorkerUserID: listOperationPointer(listOperationActor), AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: listOperationActor}},
		Query: store.TaskQuery{TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}, Page: store.Page{Limit: 2}, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: listOperationActor},
			Status: listOperationPointer(model.TaskInProgress), Ready: listOperationPointer(false), AllowAgents: listOperationPointer(true), CompatiblePlatform: listOperationPointer(model.PlatformLinux),
			PlatformSpecific: listOperationPointer(false), AutomaticCandidate: true, Worker: &store.WorkerQuery{UserID: listOperationActor, WorkerID: listOperationWorker}},
	}
	before := time.Date(2026, 1, 2, 3, 4, 4, 0, time.UTC)
	const previous = "abcdef00-0000-4000-8000-000000000001"
	cursor, err := query.EncodeListCursor(f.selection.Scope, before, previous)
	if err != nil {
		t.Fatal(err)
	}
	f.request.Cursor = &cursor
	f.selection.Query.Page.After = &store.Position{ID: previous, CreatedAt: before}
	f.service = NewTasks(&listOperationStore{fixture: f})
	f.service.listOperations = taskListOperations{
		requireProjectRead: func(actual context.Context, reader projectcore.ProjectAccessReader, principal model.Principal, project string) (model.ProjectAccess, error) {
			f.step("authorization")
			f.requireActive(actual)
			if reader != f.projectDAO || principal != f.principal || project != listOperationProject {
				t.Errorf("authorization arguments changed: %T %v %q", reader, principal, project)
			}
			return model.ProjectAccess{ProjectID: listOperationProject, UserID: listOperationActor, Role: model.ProjectAdmin}, f.authorization
		},
		readList: func(actual context.Context, reader taskcore.ReadDAO, project string, selection taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
			f.step("ReadList")
			f.requireActive(actual)
			if reader != f.taskDAO || project != listOperationProject || !reflect.DeepEqual(selection, f.selection) {
				t.Errorf("List read arguments changed: reader=%T project=%q selection=%#v want=%#v", reader, project, selection, f.selection)
			}
			return f.page, f.readFault, f.readError
		},
	}
	t.Cleanup(func() {
		if f.active || !reflect.DeepEqual(f.trace, f.want) {
			t.Errorf("List operation order = %v, want %v; active=%v", f.trace, f.want, f.active)
		}
	})
	return f
}

func (f *listOperationFixture) step(name string) {
	f.t.Helper()
	f.trace = append(f.trace, name)
	index := len(f.trace) - 1
	if index >= len(f.want) || f.want[index] != name {
		f.t.Errorf("unexpected List stage %q at %d; expected %v", name, index, f.want)
	}
}

func (f *listOperationFixture) unexpected(name string) error {
	f.t.Helper()
	f.t.Errorf("unexpected List dependency call: %s", name)
	return fmt.Errorf("unexpected List dependency call: %s", name)
}

func (f *listOperationFixture) requireActive(actual context.Context) {
	f.t.Helper()
	if !f.active || actual != f.ctx || actual.Value(listOperationContextKey{}) != f.contextValue {
		f.t.Error("List operation lost its active snapshot or original context")
	}
}

func (f *listOperationFixture) invoke() (TaskPage, error) {
	f.t.Helper()
	return f.service.List(f.ctx, f.principal, strings.ToUpper(listOperationProject), f.request)
}

type listOperationStore struct{ fixture *listOperationFixture }

func (s *listOperationStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	f := s.fixture
	f.step("snapshot enter")
	f.snapshots++
	if ctx != f.ctx || f.active || run == nil || f.snapshots != 1 {
		f.t.Error("List did not enter exactly one snapshot with its original context")
	}
	f.active = true
	err := run(&listOperationScope{fixture: f})
	f.active = false
	f.step("snapshot completion")
	if err != f.callbackError {
		f.t.Errorf("snapshot callback error = %v, want original %v", err, f.callbackError)
	}
	if f.completionError != nil {
		return f.completionError
	}
	return err
}

func (s *listOperationStore) WriteProject(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error) {
	return store.Completion{}, s.fixture.unexpected("WriteProject")
}

type listOperationScope struct{ fixture *listOperationFixture }

func (s *listOperationScope) ProjectDAO() store.ProjectReader {
	s.fixture.step("ProjectDAO")
	s.fixture.requireActive(s.fixture.ctx)
	return s.fixture.projectDAO
}
func (s *listOperationScope) TaskDAO() store.TaskReader {
	s.fixture.step("TaskDAO")
	s.fixture.requireActive(s.fixture.ctx)
	return s.fixture.taskDAO
}
func (s *listOperationScope) CredentialDAO() store.CredentialReader {
	_ = s.fixture.unexpected("CredentialDAO")
	return nil
}
func (s *listOperationScope) TeamDAO() store.TeamReader {
	_ = s.fixture.unexpected("TeamDAO")
	return nil
}
func (s *listOperationScope) WorkerDAO() store.WorkerReader {
	_ = s.fixture.unexpected("WorkerDAO")
	return nil
}
func (s *listOperationScope) SessionDAO() store.SessionReader {
	_ = s.fixture.unexpected("SessionDAO")
	return nil
}
func (s *listOperationScope) BotDAO() store.BotReader {
	_ = s.fixture.unexpected("BotDAO")
	return nil
}
func (s *listOperationScope) AttachmentDAO() store.AttachmentReader {
	_ = s.fixture.unexpected("AttachmentDAO")
	return nil
}
func (s *listOperationScope) ObservedAt(context.Context) (time.Time, error) {
	return time.Time{}, s.fixture.unexpected("ObservedAt")
}

type listOperationCapability struct {
	fixture *listOperationFixture
	name    string
}

func (c *listOperationCapability) fail(method string) error {
	return c.fixture.unexpected(c.name + "." + method)
}

func (c *listOperationCapability) Project(context.Context, string) (model.Project, error) {
	return model.Project{}, c.fail("Project")
}

func (c *listOperationCapability) Projects(context.Context, store.Page) (store.ProjectPage, error) {
	return store.ProjectPage{}, c.fail("Projects")
}

func (c *listOperationCapability) DirectProjectMember(context.Context, string, string) (model.ProjectMember, error) {
	return model.ProjectMember{}, c.fail("DirectProjectMember")
}

func (c *listOperationCapability) ProjectParticipants(context.Context, string) ([]model.ProjectParticipant, error) {
	return nil, c.fail("ProjectParticipants")
}

func (c *listOperationCapability) Invitation(context.Context, []byte) (model.ProjectInvitation, error) {
	return model.ProjectInvitation{}, c.fail("Invitation")
}

func (c *listOperationCapability) Invitations(context.Context, string, time.Time) ([]model.ProjectInvitation, error) {
	return nil, c.fail("Invitations")
}

func (c *listOperationCapability) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, c.fail("ProjectAccess")
}

func (c *listOperationCapability) AccessibleProjects(context.Context, model.Principal, store.Page) (store.ProjectPage, error) {
	return store.ProjectPage{}, c.fail("AccessibleProjects")
}

func (c *listOperationCapability) ScopedProjects(context.Context, model.Principal, store.ProjectScope, store.Page) (store.ProjectPage, error) {
	return store.ProjectPage{}, c.fail("ScopedProjects")
}

func (c *listOperationCapability) TransferTeam(context.Context, string) (store.TransferTeam, error) {
	return store.TransferTeam{}, c.fail("TransferTeam")
}

func (c *listOperationCapability) TransferRole(context.Context, string, string, string) (*model.ProjectRole, error) {
	return nil, c.fail("TransferRole")
}

func (c *listOperationCapability) Task(context.Context, string, string) (model.Task, error) {
	return model.Task{}, c.fail("Task")
}

func (c *listOperationCapability) Tasks(context.Context, string, store.TaskQuery) (store.TaskPage, error) {
	return store.TaskPage{}, c.fail("Tasks")
}

func (c *listOperationCapability) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	return store.TaskListFence{}, c.fail("TaskListFence")
}

func (c *listOperationCapability) TaskPriorityList(context.Context, string, store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	return store.TaskPriorityPage{}, c.fail("TaskPriorityList")
}

func (c *listOperationCapability) TaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	return store.TaskPresence{}, c.fail("TaskPresence")
}

func (c *listOperationCapability) TaskHeader(context.Context, string, string) (model.TaskHeader, error) {
	return model.TaskHeader{}, c.fail("TaskHeader")
}

func (c *listOperationCapability) TaskStep(context.Context, string, string) (model.TaskStep, error) {
	return model.TaskStep{}, c.fail("TaskStep")
}

func (c *listOperationCapability) TaskSteps(context.Context, string) ([]model.TaskStep, error) {
	return nil, c.fail("TaskSteps")
}

func (c *listOperationCapability) TaskStepPage(context.Context, string, int64, int, bool) ([]store.TaskStepProjection, error) {
	return nil, c.fail("TaskStepPage")
}

func (c *listOperationCapability) TaskStepSummary(context.Context, string, string) (store.TaskStepProjection, error) {
	return store.TaskStepProjection{}, c.fail("TaskStepSummary")
}

func (c *listOperationCapability) ThreadMessage(context.Context, string, string) (model.ThreadMessage, error) {
	return model.ThreadMessage{}, c.fail("ThreadMessage")
}

func (c *listOperationCapability) ThreadCandidates(context.Context, string, *model.ThreadPosition, bool, int) ([]model.ThreadMessage, error) {
	return nil, c.fail("ThreadCandidates")
}

func (c *listOperationCapability) TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error) {
	return nil, c.fail("TaskAssignees")
}

func (c *listOperationCapability) ResolveTaskAssignees(context.Context, string, []string) ([]model.TaskAssigneeFact, error) {
	return nil, c.fail("ResolveTaskAssignees")
}

func (c *listOperationCapability) TaskGraphTasks(context.Context, string, string, store.TaskGraphSelection, int) ([]model.GraphTask, error) {
	return nil, c.fail("TaskGraphTasks")
}

func (c *listOperationCapability) TaskWorkGroups(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	return store.TaskWorkGroups{}, c.fail("TaskWorkGroups")
}

func (c *listOperationCapability) TaskWorkTargets(context.Context, string, []string, *store.TaskWorkTargetPosition, int) (store.TaskWorkTargets, error) {
	return store.TaskWorkTargets{}, c.fail("TaskWorkTargets")
}

func (c *listOperationCapability) TaskCacheEpoch(context.Context, string) (string, error) {
	return "", c.fail("TaskCacheEpoch")
}

func (c *listOperationCapability) TaskSyncTasks(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error) {
	return nil, c.fail("TaskSyncTasks")
}

func (c *listOperationCapability) TaskSyncDependencyStates(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error) {
	return nil, c.fail("TaskSyncDependencyStates")
}

func (c *listOperationCapability) ThreadSides(context.Context, string, model.ThreadPosition, model.ThreadPosition) (bool, bool, error) {
	return false, false, c.fail("ThreadSides")
}

var _ store.ProjectReader = (*listOperationCapability)(nil)
var _ store.TaskReader = (*listOperationCapability)(nil)

func TestTaskListOperationsDefaultBindings(t *testing.T) {
	service := NewTasks(nil)
	if reflect.ValueOf(service.listOperations.requireProjectRead).Pointer() != reflect.ValueOf(projectcore.RequireProjectRead).Pointer() ||
		reflect.ValueOf(service.listOperations.readList).Pointer() != reflect.ValueOf(taskcore.ReadList).Pointer() {
		t.Fatal("Task List production constructor did not bind its real business operations")
	}
}

func TestTaskListOperationsCoordinateSnapshotAndProjection(t *testing.T) {
	for _, hasMore := range []bool{true, false} {
		t.Run(fmt.Sprint(hasMore), func(t *testing.T) {
			f := newListOperationFixture(t)
			f.page.HasMore = hasMore
			page, err := f.invoke()
			if err != nil || f.active || !reflect.DeepEqual(page.Items, listOperationRows()) {
				t.Fatalf("List projection changed complete items or escaped its snapshot: %#v %v", page, err)
			}
			if !hasMore {
				if page.NextCursor != nil {
					t.Fatal("final List page retained a cursor")
				}
				return
			}
			if page.NextCursor == nil {
				t.Fatal("continued List page omitted its cursor")
			}
			encoded, err := base64.RawURLEncoding.Strict().DecodeString(*page.NextCursor)
			if err != nil {
				t.Fatal(err)
			}
			var cursor map[string]any
			if err := json.Unmarshal(encoded, &cursor); err != nil {
				t.Fatal(err)
			}
			last := listOperationRows()[1]
			want := map[string]any{"tagFilter": f.selection.Scope.TagFilterIdentity, "version": float64(3), "type": "task", "kind": "tasks", "projectId": listOperationProject,
				"status": "in_progress", "ready": false, "allowAgents": true, "compatiblePlatform": "linux", "platformSpecific": false, "automaticCandidate": true,
				"workerId": listOperationWorker, "workerUserId": listOperationActor, "assignedTo": "user:" + listOperationActor,
				"createdAt": last.CreatedAt.Format(time.RFC3339Nano), "id": last.ID}
			if !reflect.DeepEqual(cursor, want) {
				t.Fatalf("List cursor scope or position changed: %#v, want %#v", cursor, want)
			}
		})
	}
}

func TestTaskListOperationsRetainRefusalsAndCompletionPriority(t *testing.T) {
	fault := &model.Fault{Code: "not_found", Message: "Not visible"}
	cause := errors.New("lower operation failed")
	wrapped := fmt.Errorf("business read: %w", cause)
	completion := errors.New("snapshot completion failed")
	for _, tc := range []struct {
		name          string
		authorization error
		readError     error
		readFault     *model.Fault
		completion    error
		want          error
	}{
		{"authorization fault", fault, nil, nil, nil, fault},
		{"read fault", nil, nil, fault, nil, fault},
		{"authorization error", wrapped, nil, nil, nil, cause},
		{"read error", nil, wrapped, nil, nil, cause},
		{"successful page completion", nil, nil, nil, completion, completion},
		{"authorization fault completion", fault, nil, nil, completion, completion},
		{"read fault completion", nil, nil, fault, completion, completion},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newListOperationFixture(t)
			f.authorization, f.readError, f.readFault, f.completionError = tc.authorization, tc.readError, tc.readFault, tc.completion
			if tc.authorization != nil {
				f.want = []string{"snapshot enter", "ProjectDAO", "authorization", "snapshot completion"}
			}
			if tc.authorization == wrapped || tc.readError == wrapped {
				f.callbackError = wrapped
			}
			page, err := f.invoke()
			if !reflect.DeepEqual(page, TaskPage{}) || !errors.Is(err, tc.want) {
				t.Fatalf("List exposed partial data or lost its error chain: %#v, %v; want %v", page, err, tc.want)
			}
			if tc.want == fault && err != fault {
				t.Fatalf("staged refusal lost identity: %v", err)
			}
			if tc.completion != nil {
				var refusal *model.Fault
				if errors.As(err, &refusal) {
					t.Fatal("snapshot completion was downgraded to a staged refusal")
				}
			}
		})
	}
}

func TestTaskListOperationsEncodeCursorAfterSnapshotCompletion(t *testing.T) {
	for _, failedCompletion := range []bool{false, true} {
		t.Run(fmt.Sprint(failedCompletion), func(t *testing.T) {
			f := newListOperationFixture(t)
			f.page.Items[1].CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
			completion := errors.New("snapshot completion failed")
			if failedCompletion {
				f.completionError = completion
			}
			page, err := f.invoke()
			if err == nil || !reflect.DeepEqual(page, TaskPage{}) {
				t.Fatalf("invalid cursor time produced a successful or partial page: %#v %v", page, err)
			}
			var encoding *json.MarshalerError
			if failedCompletion {
				if !errors.Is(err, completion) || errors.As(err, &encoding) {
					t.Fatalf("cursor encoding overrode snapshot completion: %v", err)
				}
			} else if !errors.As(err, &encoding) || !strings.HasPrefix(err.Error(), "encode task cursor:") {
				t.Fatalf("real cursor encoder did not expose its failure: %v", err)
			}
		})
	}
}

func TestTaskListOperationsRejectBeforeSnapshot(t *testing.T) {
	for _, invalid := range []string{"principal", "project", "selection"} {
		t.Run(invalid, func(t *testing.T) {
			f := newListOperationFixture(t)
			f.want = nil
			principal, project, request := f.principal, strings.ToUpper(listOperationProject), f.request
			if invalid == "principal" {
				principal = model.Principal{}
			} else if invalid == "project" {
				project = "invalid"
			} else {
				request.Status = listOperationPointer(model.TaskStatus("unknown"))
			}
			page, err := f.service.List(f.ctx, principal, project, request)
			code := "invalid_input"
			if invalid == "principal" {
				code = "unauthenticated"
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != code || !reflect.DeepEqual(page, TaskPage{}) || f.snapshots != 0 {
				t.Fatalf("List preflight used storage, lost its refusal or returned data: %#v, %v snapshots=%d", page, err, f.snapshots)
			}
			if invalid == "selection" && fault.Message != "Task status is invalid." {
				t.Fatalf("List did not preserve the actual selection refusal: %v", err)
			}
		})
	}
}

func (c *listOperationCapability) GoalProgresses(context.Context, string, []string) (map[string]model.GoalProgress, error) {
	return nil, c.fail("GoalProgresses")
}
func (c *listOperationCapability) TaskBodies(context.Context, string, []string) ([]model.Task, error) {
	return nil, c.fail("TaskBodies")
}

func (s *listOperationScope) TagDAO() store.TagReader {
	_ = s.fixture.unexpected("TagDAO")
	return nil
}

func (s *listOperationScope) GitHubDAO() store.GitHubReadDAO { panic("unexpected GitHubDAO access") }
