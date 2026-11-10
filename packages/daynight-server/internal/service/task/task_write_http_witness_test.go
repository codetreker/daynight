package task

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type writeWitnessContextKey struct{}
type writeWitness struct {
	t                      *testing.T
	ctx                    context.Context
	principal              model.Principal
	project                model.Project
	target                 model.Task
	service                *Tasks
	projectDAO             *writeWitnessProjectDAO
	taskDAO                *writeWitnessTaskDAO
	active                 bool
	trace                  []string
	method                 string
	outcome                store.TransactionOutcome
	failure, callbackError error
	writes                 int
}

func newWriteWitness(t *testing.T, method string, outcome store.TransactionOutcome, failure error) *writeWitness {
	t.Helper()
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	principal := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222", Kind: model.SessionCredential}
	project := model.Project{ID: "33333333-3333-4333-8333-333333333333", Name: "Project", RepoURL: "https://github.com/example/repository", CreatedAt: at, UpdatedAt: at, Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 120}, Ownership: model.ProjectOwnership{TeamID: "44444444-4444-4444-8444-444444444444", Version: 1, UpdatedAt: at}}
	target := model.Task{ID: "55555555-5555-4555-8555-555555555555", ProjectID: project.ID, Title: "Task", Properties: model.TaskProperties{}, Status: model.TaskTodo, Version: 1, CreatedAt: at, UpdatedAt: at, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, AssignedTo: &principal.UserID, Ready: true}
	f := &writeWitness{t: t, ctx: context.WithValue(t.Context(), writeWitnessContextKey{}, new(int)), principal: principal, project: project, target: target, method: method, outcome: outcome, failure: failure}
	f.projectDAO = &writeWitnessProjectDAO{f: f}
	f.taskDAO = &writeWitnessTaskDAO{f: f}
	f.service = NewTasks(&writeWitnessStore{f: f})
	f.service.writeOperations = taskWriteOperations{
		requireProjectWrite: func(ctx context.Context, dao store.ProjectWriteDAO, principal model.Principal) (model.ProjectAccess, error) {
			f.step("controlled authorization")
			f.checkContext(ctx)
			if dao != f.projectDAO || principal != f.principal {
				t.Fatalf("authorization changed capability or principal: %T %#v", dao, principal)
			}
			return model.ProjectAccess{ProjectID: f.project.ID, UserID: f.principal.UserID, Role: model.ProjectAdmin, OwnerTeam: model.TeamRef{ID: f.project.Ownership.TeamID, Kind: "personal"}, Ownership: f.project.Ownership}, nil
		},
		prepareCreate: func(ctx context.Context, dao store.TaskWriteDAO, id string, values store.TaskWrite) (taskcore.Mutation, error) {
			f.prepare("create", ctx, dao)
			parsed, err := uuid.Parse(id)
			want := store.TaskWrite{Title: "Unwritten task", Status: model.TaskTodo, Properties: model.TaskProperties{}, DependsOn: []string{}, ExternalDependsOn: []string{}}
			if err != nil || parsed.String() != id || parsed.Version() != 4 || !reflect.DeepEqual(values, want) {
				t.Fatalf("PrepareCreate arguments changed: id=%q values=%#v want=%#v", id, values, want)
			}
			return taskcore.Mutation{}, f.failure
		},
		prepareUpdate: func(ctx context.Context, dao store.TaskWriteDAO, id string, input taskcore.UpdateTask) (taskcore.Mutation, error) {
			f.prepare("update", ctx, dao)
			title := "Unwritten update"
			want := taskcore.UpdateTask{Version: 1, Title: &title}
			if id != f.target.ID || !reflect.DeepEqual(input, want) {
				t.Fatalf("PrepareUpdate arguments changed: id=%q input=%#v want=%#v", id, input, want)
			}
			return taskcore.Mutation{}, f.failure
		},
		prepareStatus: func(ctx context.Context, dao store.TaskWriteDAO, principal model.Principal, id string, input taskcore.SetTaskStatus) (taskcore.Mutation, error) {
			f.prepare("status", ctx, dao)
			want := taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone}
			if principal != f.principal || id != f.target.ID || !reflect.DeepEqual(input, want) {
				t.Fatalf("PrepareStatus arguments changed: principal=%#v id=%q input=%#v want=%#v", principal, id, input, want)
			}
			return taskcore.Mutation{}, f.failure
		},
	}
	t.Cleanup(func() {
		want := f.want()
		if f.writes != 1 || f.active || !slices.Equal(f.trace, want) {
			t.Errorf("write coordination = %v, writes=%d active=%t; want %v", f.trace, f.writes, f.active, want)
		}
	})
	return f
}
func (f *writeWitness) want() []string {
	return []string{"WriteProject", "ProjectDAO", "controlled authorization", "TaskDAO", "controlled Prepare" + map[string]string{"create": "Create", "update": "Update", "status": "Status"}[f.method], "completion"}
}
func (f *writeWitness) unexpected(name string) string {
	f.t.Helper()
	msg := "unexpected write dependency: " + name
	f.t.Error(msg)
	return msg
}
func (f *writeWitness) step(name string) {
	f.t.Helper()
	want := f.want()
	i := len(f.trace)
	f.trace = append(f.trace, name)
	if i >= len(want) || name != want[i] {
		panic(f.unexpected(fmt.Sprintf("stage %q at %d", name, i)))
	}
}
func (f *writeWitness) checkContext(ctx context.Context) {
	f.t.Helper()
	if !f.active || ctx != f.ctx || ctx.Value(writeWitnessContextKey{}) != f.ctx.Value(writeWitnessContextKey{}) {
		f.t.Fatal("write lost original context or active scope")
	}
}
func (f *writeWitness) prepare(method string, ctx context.Context, dao store.TaskWriteDAO) {
	f.t.Helper()
	if method != f.method {
		panic(f.unexpected("Prepare" + method))
	}
	f.step("controlled Prepare" + map[string]string{"create": "Create", "update": "Update", "status": "Status"}[method])
	f.checkContext(ctx)
	if dao != f.taskDAO {
		f.t.Fatalf("preparation changed task capability: %T", dao)
	}
}
func (f *writeWitness) invoke() (model.Task, error) {
	switch f.method {
	case "create":
		return f.service.Create(f.ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Unwritten task"})
	case "update":
		title := "Unwritten update"
		return f.service.Update(f.ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: 1, Title: &title})
	case "status":
		return f.service.SetStatus(f.ctx, f.principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: 1, Status: model.TaskDone})
	default:
		panic(f.unexpected("entry " + f.method))
	}
}

type writeWitnessStore struct{ f *writeWitness }

func (s *writeWitnessStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic(s.f.unexpected("ReadSnapshot"))
}
func (s *writeWitnessStore) WriteProject(ctx context.Context, project string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
	f := s.f
	f.step("WriteProject")
	f.writes++
	if ctx != f.ctx || project != f.project.ID || run == nil || f.active || f.writes != 1 {
		f.t.Fatal("WriteProject changed its context, project, callback or count")
	}
	f.active = true
	f.callbackError = run(&writeWitnessScope{f: f})
	f.active = false
	f.step("completion")
	return store.Completion{Outcome: f.outcome}, f.callbackError
}

type writeWitnessScope struct{ f *writeWitness }

func (s *writeWitnessScope) ProjectDAO() store.ProjectWriteDAO {
	s.f.checkContext(s.f.ctx)
	s.f.step("ProjectDAO")
	return s.f.projectDAO
}
func (s *writeWitnessScope) TaskDAO() store.TaskWriteDAO {
	s.f.checkContext(s.f.ctx)
	s.f.step("TaskDAO")
	return s.f.taskDAO
}
func (s *writeWitnessScope) EligibilityDAO() store.WebhookEligibilityDAO {
	panic(s.f.unexpected("EligibilityDAO"))
}
func (s *writeWitnessScope) CaptureDAO() store.WebhookCaptureDAO { panic(s.f.unexpected("CaptureDAO")) }
func (s *writeWitnessScope) SessionDAO() store.ProjectSessionDAO { panic(s.f.unexpected("SessionDAO")) }

type writeWitnessProjectDAO struct{ f *writeWitness }
type writeWitnessTaskDAO struct{ f *writeWitness }

func (d *writeWitnessProjectDAO) InvalidateTaskCache(context.Context) error {
	panic(d.f.unexpected("ProjectWriteDAO.InvalidateTaskCache"))
}
func (d *writeWitnessProjectDAO) Project(context.Context) (model.Project, error) {
	panic(d.f.unexpected("ProjectWriteDAO.Project"))
}
func (d *writeWitnessProjectDAO) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	panic(d.f.unexpected("ProjectWriteDAO.ProjectAccess"))
}
func (d *writeWitnessProjectDAO) UpdateProjectSettings(context.Context, int32) (model.Project, error) {
	panic(d.f.unexpected("ProjectWriteDAO.UpdateProjectSettings"))
}
func (d *writeWitnessProjectDAO) DirectProjectMember(context.Context, string) (model.ProjectMember, error) {
	panic(d.f.unexpected("ProjectWriteDAO.DirectProjectMember"))
}
func (d *writeWitnessProjectDAO) SetMemberRole(context.Context, string, model.ProjectRole) (model.ProjectMember, error) {
	panic(d.f.unexpected("ProjectWriteDAO.SetMemberRole"))
}
func (d *writeWitnessProjectDAO) RemoveMember(context.Context, string) error {
	panic(d.f.unexpected("ProjectWriteDAO.RemoveMember"))
}
func (d *writeWitnessProjectDAO) AddInvitedMember(context.Context, string) (model.ProjectMember, error) {
	panic(d.f.unexpected("ProjectWriteDAO.AddInvitedMember"))
}
func (d *writeWitnessProjectDAO) LockInvitation(context.Context, []byte) (model.ProjectInvitation, error) {
	panic(d.f.unexpected("ProjectWriteDAO.LockInvitation"))
}
func (d *writeWitnessProjectDAO) CreateInvitation(context.Context, model.ProjectInvitation) error {
	panic(d.f.unexpected("ProjectWriteDAO.CreateInvitation"))
}
func (d *writeWitnessProjectDAO) RevokeInvitation(context.Context, string, time.Time) error {
	panic(d.f.unexpected("ProjectWriteDAO.RevokeInvitation"))
}
func (d *writeWitnessProjectDAO) ConsumeInvitation(context.Context, string, string, time.Time) error {
	panic(d.f.unexpected("ProjectWriteDAO.ConsumeInvitation"))
}
func (d *writeWitnessProjectDAO) DirectGrant(context.Context, string) (model.ProjectGrant, error) {
	panic(d.f.unexpected("ProjectWriteDAO.DirectGrant"))
}
func (d *writeWitnessProjectDAO) CreateGrant(context.Context, string, model.ProjectRole) (model.ProjectGrant, error) {
	panic(d.f.unexpected("ProjectWriteDAO.CreateGrant"))
}
func (d *writeWitnessProjectDAO) LockTransferOwnership(context.Context) (model.ProjectOwnership, error) {
	panic(d.f.unexpected("ProjectWriteDAO.LockTransferOwnership"))
}
func (d *writeWitnessProjectDAO) LockTransferTeams(context.Context, string, string) (store.TransferTeam, store.TransferTeam, error) {
	panic(d.f.unexpected("ProjectWriteDAO.LockTransferTeams"))
}
func (d *writeWitnessProjectDAO) MoveOwnership(context.Context, string) (model.ProjectOwnership, error) {
	panic(d.f.unexpected("ProjectWriteDAO.MoveOwnership"))
}
func (d *writeWitnessTaskDAO) Task(context.Context, string) (model.Task, error) {
	panic(d.f.unexpected("TaskWriteDAO.Task"))
}
func (d *writeWitnessTaskDAO) TasksByID(context.Context, []string) ([]model.Task, error) {
	panic(d.f.unexpected("TaskWriteDAO.TasksByID"))
}
func (d *writeWitnessTaskDAO) ActiveDependentIDs(context.Context, string) ([]string, error) {
	panic(d.f.unexpected("TaskWriteDAO.ActiveDependentIDs"))
}
func (d *writeWitnessTaskDAO) Reachable(context.Context, string, string, store.DependencyReplacement) (bool, error) {
	panic(d.f.unexpected("TaskWriteDAO.Reachable"))
}
func (d *writeWitnessTaskDAO) CreateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	panic(d.f.unexpected("TaskWriteDAO.CreateTask"))
}
func (d *writeWitnessTaskDAO) UpdateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	panic(d.f.unexpected("TaskWriteDAO.UpdateTask"))
}
func (d *writeWitnessTaskDAO) ObservedAt(context.Context) (time.Time, error) {
	panic(d.f.unexpected("TaskWriteDAO.ObservedAt"))
}
func (d *writeWitnessTaskDAO) DependentIDs(context.Context, string) ([]string, error) {
	panic(d.f.unexpected("TaskWriteDAO.DependentIDs"))
}
func (d *writeWitnessTaskDAO) DeleteTask(context.Context, string, bool) (model.TaskTombstone, error) {
	panic(d.f.unexpected("TaskWriteDAO.DeleteTask"))
}
func (d *writeWitnessTaskDAO) TaskHeader(context.Context, string) (model.TaskHeader, error) {
	panic(d.f.unexpected("TaskWriteDAO.TaskHeader"))
}
func (d *writeWitnessTaskDAO) TaskSteps(context.Context, string) ([]model.TaskStep, error) {
	panic(d.f.unexpected("TaskWriteDAO.TaskSteps"))
}
func (d *writeWitnessTaskDAO) InsertTaskStep(context.Context, string, model.TaskStep) error {
	panic(d.f.unexpected("TaskWriteDAO.InsertTaskStep"))
}
func (d *writeWitnessTaskDAO) TouchTask(context.Context, string, time.Time) error {
	panic(d.f.unexpected("TaskWriteDAO.TouchTask"))
}
func (d *writeWitnessTaskDAO) UpdateTaskStep(context.Context, string, model.TaskStep) error {
	panic(d.f.unexpected("TaskWriteDAO.UpdateTaskStep"))
}
func (d *writeWitnessTaskDAO) MoveTaskStep(context.Context, string, string, int64, int64) error {
	panic(d.f.unexpected("TaskWriteDAO.MoveTaskStep"))
}
func (d *writeWitnessTaskDAO) DeleteTaskStep(context.Context, string, string, int64, int64) error {
	panic(d.f.unexpected("TaskWriteDAO.DeleteTaskStep"))
}

func TestTaskWriteOperationsDefaultBindings(t *testing.T) {
	operations := NewTasks(nil).writeOperations
	if reflect.ValueOf(operations.requireProjectWrite).Pointer() != reflect.ValueOf(projectcore.RequireProjectWrite).Pointer() ||
		reflect.ValueOf(operations.prepareCreate).Pointer() != reflect.ValueOf(taskcore.PrepareCreate).Pointer() ||
		reflect.ValueOf(operations.prepareUpdate).Pointer() != reflect.ValueOf(taskcore.PrepareUpdate).Pointer() ||
		reflect.ValueOf(operations.prepareStatus).Pointer() != reflect.ValueOf(taskcore.PrepareStatus).Pointer() {
		t.Fatal("Task production constructor did not bind its real write operations")
	}
}
func TestTaskWritesPreserveDatabaseFailuresBeforeMutation(t *testing.T) {
	for _, method := range []string{"create", "update", "status"} {
		t.Run(method, func(t *testing.T) {
			driver := errors.New("task query driver sentinel")
			database := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "42P01", Cause: driver}
			refusal := &model.Fault{Code: "invalid_input", Message: "joined domain refusal"}
			failure := errors.Join(refusal, database)
			f := newWriteWitness(t, method, store.TransactionNotCommitted, failure)
			got, err := f.invoke()
			if !reflect.DeepEqual(got, model.Task{}) || f.callbackError != failure || !errors.Is(f.callbackError, database) || !errors.Is(err, failure) || !errors.Is(err, driver) || !errors.Is(err, refusal) {
				t.Fatalf("database failure became a successful callback, lost a cause or exposed a task: task=%#v callback=%v err=%v", got, f.callbackError, err)
			}
			if _, known := operation.KnownFault(err); known {
				t.Fatalf("database failure became a recoverable domain refusal: %v", err)
			}
			failed, state := store.DatabaseErrorFacts(err)
			if !failed || state != "42P01" {
				t.Fatalf("write lost database classification: failure=%t state=%s", failed, state)
			}
		})
	}
}
func TestTaskStatusPreparationRetainsUnsafeCompletionFacts(t *testing.T) {
	for _, test := range []struct {
		phase   string
		outcome store.TransactionOutcome
		cleanup bool
	}{
		{"commit", store.TransactionUnknown, false}, {"cleanup", store.TransactionNotCommitted, true}, {"operation", store.TransactionUnknown, false},
	} {
		t.Run(test.phase+"_"+string(test.outcome), func(t *testing.T) {
			refusal := &model.Fault{Code: "invalid_input", Message: "business refusal sentinel"}
			cause := errors.New("transaction completion sentinel")
			failure := &store.TransactionError{Phase: test.phase, Outcome: test.outcome, CleanupFailed: test.cleanup, CommitAttempted: test.phase == "commit", Cause: errors.Join(refusal, context.Canceled, cause)}
			f := newWriteWitness(t, "status", test.outcome, failure)
			got, err := f.invoke()
			var transaction *store.TransactionError
			if !reflect.DeepEqual(got, model.Task{}) || f.callbackError != failure || !errors.As(err, &transaction) || transaction != failure || !errors.Is(err, refusal) || !errors.Is(err, context.Canceled) || !errors.Is(err, cause) {
				t.Fatalf("unsafe completion became a pure refusal or lost its original facts: task=%#v transaction=%#v err=%v", got, transaction, err)
			}
			if _, known := operation.KnownFault(err); known || operation.CompletionFacts(err) != (operation.Facts{Outcome: test.outcome, Phase: test.phase, CleanupFailed: test.cleanup}) {
				t.Fatalf("unsafe completion was hidden by its joined refusal: %v", err)
			}
		})
	}
}
