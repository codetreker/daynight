package task_test

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func assignmentChange(value *string) **string { return &value }

func createAssignedTask(t *testing.T, tasks *taskservice.Tasks, actor model.Principal, projectID string, assigned *string) model.Task {
	t.Helper()
	created, err := tasks.Create(context.Background(), actor, projectID, taskcore.CreateTask{
		Title: "Assigned responsibility", Description: "Preserved material", AssignedTo: assigned,
		Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00", Title: "Evidence"}),
	})
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func assertAssignmentChanged(t *testing.T, before, after model.Task, assigned *string) {
	t.Helper()
	if !model.EqualOptional(after.AssignedTo, assigned) || after.AllowAgents || after.Version != before.Version+1 || !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("assignment transition: before %#v, after %#v", before, after)
	}
	preserved := after
	preserved.AssignedTo, preserved.AllowAgents, preserved.Version, preserved.UpdatedAt = before.AssignedTo, before.AllowAgents, before.Version, before.UpdatedAt
	if !reflect.DeepEqual(preserved, before) {
		t.Fatalf("assignment changed unrelated task facts: before %#v, after %#v", before, after)
	}
}

func assignmentTaskModels() (model.Project, model.Task, model.Principal) {
	project, target, principal := taskMockModels()
	target.Description = "Preserved material"
	target.Properties = model.TaskProperties{"pullRequests": []byte(`[{"url":"opaque\u0000","title":"Evidence"}]`)}
	return project, target, principal
}

type assignmentCapture struct {
	t  *testing.T
	fn func(context.Context, []protocol.Fact) error
}

func (c *assignmentCapture) CaptureBatch(ctx context.Context, _ store.WebhookCaptureDAO, facts []protocol.Fact) error {
	c.t.Helper()
	if c.fn == nil {
		c.t.Fatal("unexpected source capture")
	}
	return c.fn(ctx, facts)
}

type assignmentFixture struct {
	t            *testing.T
	ctx          context.Context
	project      model.Project
	principal    model.Principal
	current      model.Task
	tasks        *taskservice.Tasks
	database     *taskStoreMock
	writer       *taskWriterMock
	projectDAO   *projectWriterMock
	sessions     *projectSessionMock
	capture      *assignmentCapture
	accessCalls  int
	targetAccess func(model.Principal) (model.ProjectAccess, error)
}

func newAssignmentFixture(t *testing.T, current model.Task, prerequisites []model.Task) *assignmentFixture {
	t.Helper()
	project, _, principal := assignmentTaskModels()
	base := newTaskMockBase(t, "assignment")
	f := &assignmentFixture{t: t, ctx: t.Context(), project: project, principal: principal, current: current, capture: &assignmentCapture{t: t}}
	f.writer = &taskWriterMock{taskMockBase: base.withLabel("task")}
	f.projectDAO = &projectWriterMock{taskMockBase: base.withLabel("project")}
	f.sessions = &projectSessionMock{taskMockBase: base.withLabel("session")}
	f.projectDAO.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
		if ctx != f.ctx {
			t.Fatal("authorization context")
		}
		f.accessCalls++
		if p == principal {
			return taskMockAccess(project, principal), nil
		}
		if f.targetAccess == nil {
			t.Fatal("unexpected target lookup")
		}
		return f.targetAccess(p)
	}
	taskReads := 0
	f.writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		taskReads++
		if ctx != f.ctx || id != current.ID || taskReads != 1 {
			t.Fatal("Task identity/context")
		}
		return current, nil
	}
	dependencyReads := 0
	f.writer.TasksByIDFn = func(ctx context.Context, ids []string) ([]model.Task, error) {
		dependencyReads++
		if ctx != f.ctx || !reflect.DeepEqual(ids, current.DependsOn) || dependencyReads != 1 {
			t.Fatalf("dependency arguments: %v", ids)
		}
		return prerequisites, nil
	}
	scope := &taskProjectScopeMock{taskMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectWriteDAO { return f.projectDAO }, TaskDAOFn: func() store.TaskWriteDAO { return f.writer }, SessionDAOFn: func() store.ProjectSessionDAO { return f.sessions }, CaptureDAOFn: func() store.WebhookCaptureDAO { return &captureDAOMock{taskMockBase: base.withLabel("capture")} }}
	scopeWrites := 0
	f.database = &taskStoreMock{taskMockBase: base.withLabel("store"), WriteProjectFn: func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		scopeWrites++
		if ctx != f.ctx || id != project.ID || scopeWrites != 1 {
			t.Fatal("Project writer scope")
		}
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}}
	f.tasks = taskservice.NewTasks(f.database, f.capture)
	return f
}
func (f *assignmentFixture) expectTarget(id string, err error) {
	f.targetAccess = func(p model.Principal) (model.ProjectAccess, error) {
		if p != (model.Principal{UserID: id}) {
			f.t.Fatalf("target principal: %#v", p)
		}
		return model.ProjectAccess{ProjectID: f.project.ID, UserID: id, Role: model.ProjectMemberRole}, err
	}
	f.t.Cleanup(func() {
		if f.accessCalls != 2 {
			f.t.Errorf("actor and target authorization calls=%d", f.accessCalls)
		}
	})
}
func (f *assignmentFixture) expectUpdate(values store.TaskWrite, after model.Task) {
	writes, drains, receipts := 0, 0, 0
	f.writer.UpdateTaskFn = func(ctx context.Context, id string, v store.TaskWrite) (model.Task, error) {
		writes++
		if ctx != f.ctx || id != f.current.ID || !reflect.DeepEqual(v, values) {
			f.t.Fatalf("proposed write=%#v want=%#v", v, values)
		}
		return after, nil
	}
	f.sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, v store.TaskSessionDrain) error {
		drains++
		if ctx != f.ctx || id != f.current.ID || v.SourceLifecycle != "active" || v.GraceSeconds != 60 {
			f.t.Fatal("session drain arguments")
		}
		return nil
	}
	f.sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, v store.TaskSessionReceiptTransition) error {
		receipts++
		if ctx != f.ctx || id != f.current.ID || v.PreviousState != "accepted" || v.NextState != "rejected" {
			f.t.Fatal("session receipt arguments")
		}
		return nil
	}
	if after.Status != f.current.Status {
		captures := 0
		f.capture.fn = func(ctx context.Context, facts []protocol.Fact) error {
			captures++
			if ctx != f.ctx || len(facts) != 1 || facts[0].Type != protocol.StatusChanged || facts[0].PreviousStatus != string(f.current.Status) || facts[0].Status != string(after.Status) {
				f.t.Fatalf("status facts: %#v", facts)
			}
			return nil
		}
		f.t.Cleanup(func() {
			if captures != 1 {
				f.t.Errorf("status captures=%d", captures)
			}
		})
	}
	f.t.Cleanup(func() {
		if writes != 1 || drains != 1 || receipts != 1 {
			f.t.Errorf("write/drain/receipt calls=%d/%d/%d", writes, drains, receipts)
		}
	})
}
func assignmentResult(before model.Task, v store.TaskWrite) model.Task {
	after := before
	after.AssignedTo, after.RequiredPlatform, after.AllowAgents = v.AssignedTo, v.RequiredPlatform, v.AllowAgents
	after.Title, after.Description, after.Properties = v.Title, v.Description, v.Properties
	after.Status, after.DependsOn, after.ExternalDependsOn = v.Status, v.DependsOn, v.ExternalDependsOn
	after.Version++
	after.UpdatedAt = before.UpdatedAt.Add(time.Microsecond)
	after.Ready = after.Status == model.TaskTodo && len(after.BlockedBy) == 0
	return after
}
func assignmentName(v *string) string {
	if v == nil {
		return "unassigned"
	}
	return *v
}
func assignmentAlias(t *testing.T, canonical string) string {
	t.Helper()
	alias := strings.ToUpper(canonical)
	if alias == canonical || strings.ToLower(canonical) != canonical {
		t.Fatal("assignment alias fixture must have distinct uppercase and canonical lowercase spellings")
	}
	return alias
}

func TestTaskAssignmentCreateAndTransitions(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	alice, bob := "aaaaaa66-6666-4666-8666-666666666666", "bbbbbb77-7777-4777-8777-777777777777"
	for _, assigned := range []*string{nil, &alice, pointer(assignmentAlias(t, alice)), &actor.UserID} {
		t.Run("create_"+assignmentName(assigned), func(t *testing.T) {
			current := base
			current.AssignedTo = nil
			f := newAssignmentFixture(t, current, nil)
			want := assigned
			if want != nil {
				want = pointer(strings.ToLower(*assigned))
				f.expectTarget(*want, nil)
				if *want == actor.UserID {
					f.targetAccess = func(principal model.Principal) (model.ProjectAccess, error) {
						if principal != (model.Principal{UserID: actor.UserID}) {
							t.Fatalf("self-assignment principal: %#v", principal)
						}
						return taskMockAccess(f.project, actor), nil
					}
				}
			}
			calls := 0
			f.writer.CreateTaskFn = func(ctx context.Context, id string, v store.TaskWrite) (model.Task, error) {
				calls++
				if ctx != f.ctx || id == "" || !model.EqualOptional(v.AssignedTo, want) || v.AllowAgents || v.Status != model.TaskTodo || v.Title != "Assigned responsibility" || v.Description != "Preserved material" || !reflect.DeepEqual(v.Properties, base.Properties) {
					t.Fatalf("creation write: %#v", v)
				}
				result := base
				result.ID = id
				result.AssignedTo = want
				return result, nil
			}
			f.capture.fn = func(ctx context.Context, facts []protocol.Fact) error {
				if ctx != f.ctx || len(facts) != 1 || facts[0].Type != protocol.Created {
					t.Fatalf("creation facts: %#v", facts)
				}
				return nil
			}
			got, err := f.tasks.Create(f.ctx, actor, f.project.ID, taskcore.CreateTask{Title: "Assigned responsibility", Description: "Preserved material", AssignedTo: assigned, Properties: base.Properties})
			if err != nil || calls != 1 || !model.EqualOptional(got.AssignedTo, want) || got.AllowAgents || got.Version != 1 || got.Status != model.TaskTodo {
				t.Fatalf("creation result: %#v %v", got, err)
			}
		})
	}
	for _, bad := range []string{"", " ", "not-a-uuid", " " + alice, alice + " "} {
		f := newAssignmentFixture(t, base, nil)
		_, err := f.tasks.Create(f.ctx, actor, f.project.ID, taskcore.CreateTask{Title: "Invalid assignment", AssignedTo: &bad})
		requireFault(t, err, "invalid_input")
		if f.accessCalls != 0 {
			t.Fatal("invalid input read storage")
		}
	}
	f := newAssignmentFixture(t, base, nil)
	f.expectTarget(bob, model.ErrNotFound)
	_, err := f.tasks.Create(f.ctx, actor, f.project.ID, taskcore.CreateTask{Title: "Ineligible assignment", AssignedTo: &bob})
	requireFault(t, err, "invalid_input")
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskDone} {
		for _, change := range []struct{ from, to *string }{{nil, &alice}, {&alice, &bob}, {&alice, nil}} {
			t.Run(string(status)+"_"+assignmentName(change.from)+"_"+assignmentName(change.to), func(t *testing.T) {
				before := base
				before.AssignedTo = change.from
				before.Status = status
				before.Ready = status == model.TaskTodo
				before.AllowAgents = true
				f := newAssignmentFixture(t, before, nil)
				if change.to != nil {
					f.expectTarget(*change.to, nil)
				}
				v := taskcore.CurrentWrite(before)
				v.AssignedTo = change.to
				v.AllowAgents = false
				after := assignmentResult(before, v)
				f.expectUpdate(v, after)
				got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(change.to), AllowAgents: pointer(true)})
				if err != nil {
					t.Fatal(err)
				}
				assertAssignmentChanged(t, before, got, change.to)
			})
		}
	}
}
func TestTaskAssignmentNoOpsAndExecutionLocks(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	alice, bob := "aaaaaa66-6666-4666-8666-666666666666", "bbbbbb77-7777-4777-8777-777777777777"
	for _, assigned := range []*string{nil, &alice} {
		for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			t.Run(assignmentName(assigned)+"_"+string(status), func(t *testing.T) {
				before := base
				before.AssignedTo = assigned
				before.Status = status
				before.Ready = status == model.TaskTodo
				before.AllowAgents = true
				equal := assigned
				if equal != nil {
					equal = pointer(assignmentAlias(t, *equal))
				}
				f := newAssignmentFixture(t, before, nil)
				got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(equal)})
				if err != nil || !reflect.DeepEqual(got, before) || f.accessCalls != 1 {
					t.Fatalf("same assignment: %#v %v", got, err)
				}
				f = newAssignmentFixture(t, before, nil)
				_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version + 1, AssignedTo: assignmentChange(equal)})
				requireFault(t, err, "version_conflict")
				if status == model.TaskInProgress {
					for _, next := range []*string{&bob, nil} {
						if model.EqualOptional(next, assigned) {
							continue
						}
						f = newAssignmentFixture(t, before, nil)
						_, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(next), Description: pointer("Must not partly save")})
						requireFault(t, err, "invalid_transition")
						if f.accessCalls != 1 {
							t.Fatal("locked assignment requalified target")
						}
					}
				}
			})
		}
	}
	for _, bad := range []string{"", "bad", " " + alice} {
		before := base
		before.AssignedTo = &alice
		f := newAssignmentFixture(t, before, nil)
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bad), Title: pointer("Must not save")})
		requireFault(t, err, "invalid_input")
	}
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress} {
		before := base
		before.AssignedTo = &alice
		before.Status = status
		before.Ready = status == model.TaskTodo
		f := newAssignmentFixture(t, before, nil)
		code := "invalid_transition"
		if status == model.TaskTodo {
			f.expectTarget(bob, model.ErrNotFound)
			code = "invalid_input"
		}
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bob), Description: pointer("Must not save")})
		requireFault(t, err, code)
	}
}
func TestTaskAssignmentPreservesCombinedChanges(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	before.AssignedTo = nil
	f := newAssignmentFixture(t, before, nil)
	alice := "aaaaaa66-6666-4666-8666-666666666666"
	f.expectTarget(alice, nil)
	v := taskcore.CurrentWrite(before)
	v.AssignedTo = &alice
	v.AllowAgents = false
	v.Title = "Updated title"
	v.Description = "Updated description"
	v.RequiredPlatform = pointer(model.PlatformLinux)
	after := assignmentResult(before, v)
	f.expectUpdate(v, after)
	got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&alice), AllowAgents: pointer(true), Title: &v.Title, Description: &v.Description, RequiredPlatform: platformChange(v.RequiredPlatform)})
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatalf("combined assignment: %#v %v", got, err)
	}
}
func TestTaskAssignmentSurvivesMemberLossAndUnrelatedWrites(t *testing.T) {
	_, base, actor := assignmentTaskModels()
	alice := "aaaaaa66-6666-4666-8666-666666666666"
	base.AssignedTo = &alice
	base.AllowAgents = true
	f := newAssignmentFixture(t, base, nil)
	got, err := f.tasks.Update(f.ctx, actor, f.project.ID, base.ID, taskcore.UpdateTask{Version: base.Version, AssignedTo: assignmentChange(pointer(assignmentAlias(t, alice)))})
	if err != nil || !reflect.DeepEqual(got, base) || f.accessCalls != 1 {
		t.Fatalf("historical same assignment: %#v %v", got, err)
	}
	v := taskcore.CurrentWrite(base)
	v.Title = "Legitimate metadata"
	v.RequiredPlatform = pointer(model.PlatformLinux)
	after := assignmentResult(base, v)
	f = newAssignmentFixture(t, base, nil)
	f.expectUpdate(v, after)
	got, err = f.tasks.Update(f.ctx, actor, f.project.ID, base.ID, taskcore.UpdateTask{Version: base.Version, AssignedTo: assignmentChange(&alice), Title: &v.Title, RequiredPlatform: platformChange(v.RequiredPlatform)})
	if err != nil || !reflect.DeepEqual(got, after) || f.accessCalls != 1 {
		t.Fatalf("historical assignee requalified: %#v %v", got, err)
	}

	before := after
	v = taskcore.CurrentWrite(before)
	v.Properties["paused"] = []byte("true")
	after = assignmentResult(before, v)
	f = newAssignmentFixture(t, before, nil)
	f.expectUpdate(v, after)
	f.capture.fn = func(ctx context.Context, facts []protocol.Fact) error {
		if ctx != f.ctx || len(facts) != 1 || facts[0].Type != protocol.Paused || !facts[0].Paused {
			t.Fatalf("property source fact: %#v", facts)
		}
		return nil
	}
	got, err = f.tasks.SetProperty(f.ctx, actor, f.project.ID, before.ID, "paused", "true", before.Version)
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatalf("property set changed responsibility: %#v %v", got, err)
	}
	before = after
	v = taskcore.CurrentWrite(before)
	delete(v.Properties, "paused")
	after = assignmentResult(before, v)
	f = newAssignmentFixture(t, before, nil)
	f.expectUpdate(v, after)
	got, err = f.tasks.RemoveProperty(f.ctx, actor, f.project.ID, before.ID, "paused", before.Version)
	if err != nil || !reflect.DeepEqual(got, after) {
		t.Fatalf("property removal changed responsibility: %#v %v", got, err)
	}
	before = after
	f = newAssignmentFixture(t, before, nil)
	got, err = f.tasks.RemoveProperty(f.ctx, actor, f.project.ID, before.ID, "paused", before.Version)
	if err != nil || !reflect.DeepEqual(got, before) {
		t.Fatalf("absent property changed responsibility: %#v %v", got, err)
	}
	for _, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskInProgress, model.TaskDone, model.TaskTodo} {
		before = assignmentStatus(t, before, status)
		if !model.EqualOptional(before.AssignedTo, &alice) || !before.AllowAgents {
			t.Fatalf("status %s changed historical responsibility", status)
		}
	}

	v = taskcore.CurrentWrite(before)
	v.AssignedTo = nil
	v.AllowAgents = false
	after = assignmentResult(before, v)
	f = newAssignmentFixture(t, before, nil)
	f.expectUpdate(v, after)
	got, err = f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(nil)})
	if err != nil {
		t.Fatal(err)
	}
	assertAssignmentChanged(t, before, got, nil)
}
func TestTaskAssignmentCompetesWithExecutionAndPermission(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	alice, bob := "aaaaaa66-6666-4666-8666-666666666666", "bbbbbb77-7777-4777-8777-777777777777"
	before.AssignedTo = &alice
	for _, competitor := range []string{"start", "claim", "enable"} {
		t.Run(competitor, func(t *testing.T) {
			current := before
			current.Version++
			current.AllowAgents = true
			if competitor != "enable" {
				current.Status = model.TaskInProgress
			}
			f := newAssignmentFixture(t, current, nil)
			_, err := f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&bob)})
			requireFault(t, err, "version_conflict")
			if competitor != "enable" {
				f = newAssignmentFixture(t, current, nil)
				_, err = f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, AssignedTo: assignmentChange(&bob)})
				requireFault(t, err, "invalid_transition")
			}
		})
	}
}
func TestTaskAssignmentNoOpAndClaimCanBothSucceed(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	before.AllowAgents = true
	f := newAssignmentFixture(t, before, nil)
	got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(before.AssignedTo)})
	if err != nil || !reflect.DeepEqual(got, before) {
		t.Fatalf("equal assignment: %#v %v", got, err)
	}
	current := before
	current.Status = model.TaskInProgress
	current.Version++
	f = newAssignmentFixture(t, current, nil)
	_, err = f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(before.AssignedTo)})
	requireFault(t, err, "version_conflict")
	f = newAssignmentFixture(t, current, nil)
	got, err = f.tasks.Update(f.ctx, actor, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, AssignedTo: assignmentChange(current.AssignedTo)})
	if err != nil || !reflect.DeepEqual(got, current) {
		t.Fatalf("equal assignment during execution: %#v %v", got, err)
	}
}
func TestTaskAssignmentRechecksMemberRemoval(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	before.AssignedTo = nil
	target := "aaaaaa66-6666-4666-8666-666666666666"
	for _, removeActor := range []bool{false, true} {
		f := newAssignmentFixture(t, before, nil)
		code := "invalid_input"
		if removeActor {
			f.projectDAO.ProjectAccessFn = func(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
				if ctx != f.ctx || p != actor {
					t.Fatal("actor recheck scope")
				}
				return model.ProjectAccess{}, model.ErrNotFound
			}
			code = "not_found"
		} else {
			f.expectTarget(target, model.ErrNotFound)
		}
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target)})
		requireFault(t, err, code)
	}
}
func TestTaskAssignmentFailuresPreserveAtomicityAndCause(t *testing.T) {
	_, before, actor := assignmentTaskModels()
	before.AssignedTo = nil
	target := "aaaaaa66-6666-4666-8666-666666666666"
	t.Run("target lookup failure", func(t *testing.T) {
		f := newAssignmentFixture(t, before, nil)
		failure := errors.New("target lookup failed")
		f.expectTarget(target, failure)
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target)})
		if !errors.Is(err, failure) {
			t.Fatalf("target failure: %v", err)
		}
		assertOperational(t, err)
	})
	t.Run("cancel after update", func(t *testing.T) {
		f := newAssignmentFixture(t, before, nil)
		f.expectTarget(target, nil)
		calls := 0
		f.writer.UpdateTaskFn = func(ctx context.Context, id string, v store.TaskWrite) (model.Task, error) {
			calls++
			if ctx != f.ctx || id != before.ID || !model.EqualOptional(v.AssignedTo, &target) || v.AllowAgents {
				t.Fatal("canceled assignment arguments")
			}
			return model.Task{}, context.Canceled
		}
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target)})
		if calls != 1 || !errors.Is(err, context.Canceled) {
			t.Fatalf("assignment cancellation: %v", err)
		}
		assertOperational(t, err)
	})
	t.Run("commit failure dominates target refusal", func(t *testing.T) {
		f := newAssignmentFixture(t, before, nil)
		f.expectTarget(target, model.ErrNotFound)
		original := f.database.WriteProjectFn
		f.database.WriteProjectFn = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
			_, err := original(ctx, id, work)
			if err != nil {
				t.Fatal(err)
			}
			return store.Completion{Outcome: store.TransactionUnknown}, context.Canceled
		}
		_, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target)})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("failed completion masked: %v", err)
		}
		assertOperational(t, err)
	})
	t.Run("later edge failure", func(t *testing.T) {
		f := newAssignmentFixture(t, before, nil)
		f.expectTarget(target, nil)
		failure := errors.New("edge write failed")
		f.writer.UpdateTaskFn = func(ctx context.Context, id string, v store.TaskWrite) (model.Task, error) {
			if ctx != f.ctx || id != before.ID || !model.EqualOptional(v.AssignedTo, &target) || v.AllowAgents || v.Description != "Must not save" {
				t.Fatal("failed assignment write")
			}
			return model.Task{}, failure
		}
		got, err := f.tasks.Update(f.ctx, actor, f.project.ID, before.ID, taskcore.UpdateTask{Version: before.Version, AssignedTo: assignmentChange(&target), Description: pointer("Must not save")})
		if !errors.Is(err, failure) || !reflect.DeepEqual(got, model.Task{}) {
			t.Fatalf("partial result exposed: %#v %v", got, err)
		}
		assertOperational(t, err)
	})
}

func TestTaskAssignmentSurvivesEveryWorkerWrite(t *testing.T) {
	_, base, owner := assignmentTaskModels()
	bob := "bbbbbb77-7777-4777-8777-777777777777"
	descriptor := workerDescriptor()
	descriptor.AgentControlMode = model.AgentControlModeHerdr
	active := base
	active.AllowAgents = true
	active.Status = model.TaskInProgress
	active.Ready = false
	active.StartedAt = &active.CreatedAt
	active.Properties = testWithWorker(t, base.Properties, testWorker(t, workerProtocolTask(t, owner, descriptor, model.WorkerActive).Properties))
	assertReturned := func(t *testing.T, got, want model.Task, err error) {
		t.Helper()
		if err != nil || !reflect.DeepEqual(got, want) || !model.EqualOptional(got.AssignedTo, want.AssignedTo) {
			t.Fatalf("worker responsibility: got %#v want %#v err %v", got, want, err)
		}
	}
	t.Run("claim", func(t *testing.T) {
		before := base
		before.AllowAgents = true
		f := workerMockWrite(t, before, owner)
		clock := before.UpdatedAt.Add(time.Second)
		worker := *testWorker(t, active.Properties)
		worker.ClaimedAt = clock
		v := taskcore.CurrentWrite(before)
		v.Status = model.TaskInProgress
		v.Properties = testWithWorker(t, before.Properties, &worker)
		after := assignmentResult(before, v)
		after.UpdatedAt = clock
		after.StartedAt = &clock
		f.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			if ctx != f.Context {
				t.Fatal("claim clock scope")
			}
			return clock, nil
		}
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, before, after)
		got, err := f.Tasks.ClaimWorker(f.Context, owner, before.ProjectID, before.ID, taskcore.ClaimWorker{Version: before.Version, WorkerDescriptor: descriptor})
		assertReturned(t, got, after, err)
		if testWorker(t, got.Properties).UserID != owner.UserID {
			t.Fatal("claim changed execution owner")
		}
	})
	t.Run("active reassignment", func(t *testing.T) {
		f := newAssignmentFixture(t, active, nil)
		_, err := f.tasks.Update(f.ctx, owner, f.project.ID, active.ID, taskcore.UpdateTask{Version: active.Version, AssignedTo: assignmentChange(&bob)})
		requireFault(t, err, "invalid_transition")
	})
	t.Run("update and same phase", func(t *testing.T) {
		f := workerMockWrite(t, active, owner)
		worker := *testWorker(t, active.Properties)
		worker.Phase = model.WorkerExecuting
		v := taskcore.CurrentWrite(active)
		v.Properties = testWithWorker(t, active.Properties, &worker)
		after := assignmentResult(active, v)
		f.ExpectUpdate(v, after)
		got, err := f.Tasks.UpdateWorker(f.Context, owner, active.ProjectID, active.ID, taskcore.UpdateWorker{Version: active.Version, ClaimID: descriptor.ClaimID, Phase: &worker.Phase})
		assertReturned(t, got, after, err)
		f = workerMockWrite(t, after, owner)
		got, err = f.Tasks.UpdateWorker(f.Context, owner, after.ProjectID, after.ID, taskcore.UpdateWorker{Version: after.Version, ClaimID: descriptor.ClaimID, Phase: &worker.Phase})
		assertReturned(t, got, after, err)
	})
	t.Run("active properties", func(t *testing.T) {
		f := workerMockWrite(t, active, owner)
		v := taskcore.CurrentWrite(active)
		v.Properties["paused"] = []byte("true")
		after := assignmentResult(active, v)
		f.ExpectUpdate(v, after)
		f.ExpectCapture([]protocol.Fact{{Type: protocol.Paused, ProjectID: active.ProjectID, TaskID: active.ID, TaskVersion: after.Version, OccurredAt: after.UpdatedAt, Paused: true}})
		got, err := f.Tasks.SetProperty(f.Context, owner, active.ProjectID, active.ID, "paused", "true", active.Version)
		assertReturned(t, got, after, err)
		f = workerMockWrite(t, after, owner)
		v = taskcore.CurrentWrite(after)
		delete(v.Properties, "paused")
		removed := assignmentResult(after, v)
		f.ExpectUpdate(v, removed)
		got, err = f.Tasks.RemoveProperty(f.Context, owner, after.ProjectID, after.ID, "paused", after.Version)
		assertReturned(t, got, removed, err)
	})
	released := active
	released.Status = model.TaskTodo
	released.Ready = true
	released.StartedAt = nil
	releasedWorker := *testWorker(t, active.Properties)
	releasedWorker.State = model.WorkerReleased
	released.Properties = testWithWorker(t, active.Properties, &releasedWorker)
	t.Run("release", func(t *testing.T) {
		f := workerMockWrite(t, active, owner)
		v := taskcore.CurrentWrite(active)
		v.Status = model.TaskTodo
		v.Properties = released.Properties
		after := assignmentResult(active, v)
		after.StartedAt = nil
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, active, after)
		got, err := f.Tasks.ReleaseWorker(f.Context, owner, active.ProjectID, active.ID, taskcore.ReleaseWorker{Version: active.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
		assertReturned(t, got, after, err)
	})
	reassigned := released
	reassigned.AssignedTo = &bob
	reassigned.AllowAgents = false
	t.Run("reassign retained execution", func(t *testing.T) {
		f := newAssignmentFixture(t, released, nil)
		f.expectTarget(bob, nil)
		v := taskcore.CurrentWrite(released)
		v.AssignedTo = &bob
		v.AllowAgents = false
		after := assignmentResult(released, v)
		f.expectUpdate(v, after)
		got, err := f.tasks.Update(f.ctx, owner, f.project.ID, released.ID, taskcore.UpdateTask{Version: released.Version, AssignedTo: assignmentChange(&bob)})
		assertReturned(t, got, after, err)
		if testWorker(t, got.Properties).UserID != owner.UserID || got.AllowAgents {
			t.Fatal("reassignment transferred execution ownership")
		}
	})
	next := workerDescriptor()
	next.AgentControlMode = model.AgentControlModeHerdr
	t.Run("assignee cannot resume another owner", func(t *testing.T) {
		actor := owner
		actor.UserID = bob
		f := workerMockWrite(t, reassigned, actor)
		f.ExpectedAccessCalls = 2
		_, err := f.Tasks.ResumeWorker(f.Context, actor, reassigned.ProjectID, reassigned.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: reassigned.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
		requireFault(t, err, "forbidden")
	})
	resumed := reassigned
	resumed.Status = model.TaskInProgress
	resumed.Ready = false
	resumedWorker := *testWorker(t, workerProtocolTask(t, owner, next, model.WorkerActive).Properties)
	clock := reassigned.UpdatedAt.Add(time.Second)
	resumedWorker.ClaimedAt = clock
	resumed.Properties = testWithWorker(t, reassigned.Properties, &resumedWorker)
	t.Run("original owner resumes", func(t *testing.T) {
		f := workerMockWrite(t, reassigned, owner)
		v := taskcore.CurrentWrite(reassigned)
		v.Status = model.TaskInProgress
		v.Properties = resumed.Properties
		after := assignmentResult(reassigned, v)
		after.UpdatedAt = clock
		after.StartedAt = &clock
		f.Task.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			if ctx != f.Context {
				t.Fatal("resume clock scope")
			}
			return clock, nil
		}
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, reassigned, after)
		got, err := f.Tasks.ResumeWorker(f.Context, owner, reassigned.ProjectID, reassigned.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: reassigned.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
		assertReturned(t, got, after, err)
		if got.AllowAgents {
			t.Fatal("manual resume changed automatic permission")
		}
	})
	completed := resumed
	completed.Status = model.TaskDone
	completed.Ready = false
	completedWorker := resumedWorker
	completedWorker.State = model.WorkerCompleted
	completed.Properties = testWithWorker(t, resumed.Properties, &completedWorker)
	t.Run("claim completion", func(t *testing.T) {
		f := workerMockWrite(t, resumed, owner)
		v := taskcore.CurrentWrite(resumed)
		v.Status = model.TaskDone
		v.Properties = completed.Properties
		after := assignmentResult(resumed, v)
		after.CompletedAt = &after.UpdatedAt
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, resumed, after)
		got, err := f.Tasks.SetStatus(f.Context, owner, resumed.ProjectID, resumed.ID, taskcore.SetTaskStatus{Version: resumed.Version, Status: model.TaskDone, ClaimID: &next.ClaimID})
		assertReturned(t, got, after, err)
	})
	t.Run("reopen keeps historical owner", func(t *testing.T) {
		f := workerMockWrite(t, completed, owner)
		f.Task.ActiveDependentIDsFn = func(ctx context.Context, id string) ([]string, error) {
			if ctx != f.Context || id != completed.ID {
				t.Fatal("reopen dependency scope")
			}
			return []string{}, nil
		}
		v := taskcore.CurrentWrite(completed)
		v.Status = model.TaskInProgress
		after := assignmentResult(completed, v)
		after.StartedAt = &after.UpdatedAt
		after.CompletedAt = nil
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, completed, after)
		got, err := f.Tasks.SetStatus(f.Context, owner, completed.ProjectID, completed.ID, taskcore.SetTaskStatus{Version: completed.Version, Status: model.TaskInProgress})
		assertReturned(t, got, after, err)
		if testWorker(t, got.Properties).State != model.WorkerCompleted {
			t.Fatal("reopen replaced retained execution")
		}
	})
	t.Run("withdraw", func(t *testing.T) {
		f := workerMockWrite(t, active, owner)
		v := taskcore.CurrentWrite(active)
		v.Status = model.TaskTodo
		v.AllowAgents = false
		v.Properties = testWithWorker(t, active.Properties, nil)
		after := assignmentResult(active, v)
		after.StartedAt = nil
		f.ExpectUpdate(v, after)
		workerProtocolCapture(f, active, after)
		got, err := f.Tasks.WithdrawWorker(f.Context, owner, active.ProjectID, active.ID, taskcore.WithdrawWorker{Version: active.Version, ClaimID: descriptor.ClaimID})
		assertReturned(t, got, after, err)
		if got.AllowAgents || testWorker(t, got.Properties) != nil {
			t.Fatal("withdraw retained permission or claim")
		}
	})
}
