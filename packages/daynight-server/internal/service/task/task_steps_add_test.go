package task

import (
	"context"
	"errors"
	"math"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func stepWritePtr[T any](v T) *T { return &v }
func writeHeader(version int64) model.TaskHeader {
	return model.TaskHeader{ProjectID: "22222222-2222-4222-8222-222222222222", ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: version}
}
func writeRows() []model.TaskStep {
	return []model.TaskStep{
		{ID: "00000000", Position: 0, Title: "same", Description: "original body", Status: model.TaskStepTodo, CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 3, 4, 5, 6, 654321000, time.UTC)},
		{ID: "abcdef01", Position: 1, Title: "same", Description: "other body", Status: model.TaskStepInProgress, CreatedAt: time.Date(2026, 1, 3, 3, 4, 5, 123456000, time.UTC), UpdatedAt: time.Date(2026, 2, 4, 4, 5, 6, 654321000, time.UTC)},
	}
}

// Each capability is bound to the callback lifetime and a single expected call.
type strictStepWrite struct {
	t                                                                        *testing.T
	ctx                                                                      context.Context
	principal                                                                model.Principal
	header                                                                   model.TaskHeader
	current                                                                  []model.TaskStep
	expectedCurrent                                                          []model.TaskStep
	projectID, taskID                                                        string
	events                                                                   []string
	active                                                                   bool
	headers                                                                  int
	project                                                                  *strictWriteProject
	captureDAO                                                               *strictWriteCaptureDAO
	svc                                                                      *TaskSteps
	addStep                                                                  model.TaskStep
	before, after                                                            *string
	changeID                                                                 string
	changes                                                                  tasksteps.Changes
	mutation                                                                 tasksteps.Mutation
	admitErr, authErr, headerErr, rowsErr, startErr, writeErr, completionErr error
	outcome                                                                  store.TransactionOutcome
	observed                                                                 time.Time
	expectedWrite                                                            model.TaskStep
	expectedFact                                                             protocol.Fact
}
type strictWriteProject struct {
	f *strictStepWrite
}
type strictWriteCaptureDAO struct{ f *strictStepWrite }

func (p *strictWriteProject) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	p.f.t.Fatal("Project core operation escaped its mock")
	return model.ProjectAccess{}, nil
}
func (f *strictStepWrite) event(name string) {
	f.t.Helper()
	if len(f.events) == 0 || f.events[0] != name {
		f.t.Fatalf("unexpected %s; remaining %v", name, f.events)
	}
	f.events = f.events[1:]
}
func (f *strictStepWrite) scoped(name string) {
	f.t.Helper()
	if !f.active {
		f.t.Fatalf("%s escaped scope", name)
	}
	f.event(name)
}
func (f *strictStepWrite) begin(names ...string) {
	f.t.Helper()
	if f.active || len(f.events) != 0 {
		f.t.Fatal("prior operation unfinished")
	}
	f.events = slices.Clone(names)
}
func (f *strictStepWrite) end() {
	f.t.Helper()
	if f.active || len(f.events) != 0 {
		f.t.Fatalf("missing calls or active scope: %v", f.events)
	}
}
func (f *strictStepWrite) ProjectDAO() store.ProjectWriteDAO {
	f.scoped("projectDAO")
	return f.project
}
func (f *strictStepWrite) TaskDAO() store.TaskWriteDAO { f.scoped("taskDAO"); return f }
func (f *strictStepWrite) CaptureDAO() store.WebhookCaptureDAO {
	f.scoped("captureDAO")
	return f.captureDAO
}
func (f *strictStepWrite) EligibilityDAO() store.WebhookEligibilityDAO {
	f.t.Fatal("unexpected EligibilityDAO call")
	return nil
}
func (f *strictStepWrite) SessionDAO() store.ProjectSessionDAO {
	f.t.Fatal("unexpected SessionDAO call")
	return nil
}
func (f *strictStepWrite) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	f.event("store")
	if ctx != f.ctx || id != f.projectID || work == nil || f.active {
		f.t.Fatal("project scope/context changed")
	}
	if f.startErr != nil {
		f.event("complete")
		return store.Completion{Outcome: store.TransactionNotCommitted}, f.startErr
	}
	f.active = true
	err := work(f)
	f.active = false
	f.event("complete")
	if f.completionErr != nil {
		if err != nil {
			f.t.Fatalf("unexpected callback error before completion: %v", err)
		}
		return store.Completion{Outcome: f.outcome}, f.completionErr
	}
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	return store.Completion{Outcome: f.outcome}, nil
}
func (f *strictStepWrite) TaskHeader(ctx context.Context, id string) (model.TaskHeader, error) {
	f.scoped("header")
	if ctx != f.ctx || id != f.taskID {
		f.t.Fatalf("header identity/context %s", id)
	}
	f.headers++
	if f.headerErr != nil {
		return model.TaskHeader{}, f.headerErr
	}
	h := f.header
	if f.headers == 2 {
		h.Version++
	}
	return h, nil
}
func (f *strictStepWrite) TaskSteps(ctx context.Context, id string) ([]model.TaskStep, error) {
	f.scoped("rows")
	if ctx != f.ctx || id != f.taskID {
		f.t.Fatal("collection identity/context changed")
	}
	return f.current, f.rowsErr
}
func (f *strictStepWrite) ObservedAt(ctx context.Context) (time.Time, error) {
	f.scoped("clock")
	if ctx != f.ctx {
		f.t.Fatal("clock context changed")
	}
	return f.observed, nil
}
func (f *strictStepWrite) InsertTaskStep(ctx context.Context, id string, step model.TaskStep) error {
	f.scoped("insert")
	return f.checkWrite(ctx, id, step)
}
func (f *strictStepWrite) UpdateTaskStep(ctx context.Context, id string, step model.TaskStep) error {
	f.scoped("update")
	return f.checkWrite(ctx, id, step)
}
func (f *strictStepWrite) checkWrite(ctx context.Context, id string, step model.TaskStep) error {
	f.t.Helper()
	if ctx != f.ctx || id != f.taskID || step != f.expectedWrite {
		f.t.Fatalf("write arguments %+v want %+v", step, f.expectedWrite)
	}
	return f.writeErr
}
func (f *strictStepWrite) TouchTask(ctx context.Context, id string, at time.Time) error {
	f.scoped("touch")
	if ctx != f.ctx || id != f.taskID || at != f.observed {
		f.t.Fatal("touch arguments changed")
	}
	return nil
}
func (f *strictStepWrite) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	f.scoped("capture")
	if ctx != f.ctx || dao != f.captureDAO || len(facts) != 1 || !reflect.DeepEqual(facts[0], f.expectedFact) {
		f.t.Fatalf("capture: %+v want %+v", facts, f.expectedFact)
	}
	return nil
}
func newStrictStepWrite(t *testing.T, h model.TaskHeader, rows []model.TaskStep) *strictStepWrite {
	t.Helper()
	f := &strictStepWrite{t: t, ctx: t.Context(), principal: model.Principal{Kind: model.SessionCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "33333333-3333-4333-8333-333333333333"}, header: h, current: rows, expectedCurrent: slices.Clone(rows), projectID: h.ProjectID, taskID: h.ID, outcome: store.TransactionCommitted}
	f.project = &strictWriteProject{f: f}
	f.captureDAO = &strictWriteCaptureDAO{f: f}
	f.svc = NewTaskSteps(f, f)
	if reflect.ValueOf(f.svc.writeOperations.requireProjectWrite).Pointer() != reflect.ValueOf(projectcore.RequireProjectWrite).Pointer() || reflect.ValueOf(f.svc.writeOperations.admitAdd).Pointer() != reflect.ValueOf(tasksteps.AdmitAdd).Pointer() || reflect.ValueOf(f.svc.writeOperations.admitChange).Pointer() != reflect.ValueOf(tasksteps.AdmitChange).Pointer() {
		t.Fatal("production constructor write bindings changed")
	}
	f.svc.writeOperations.requireProjectWrite = func(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal) (model.ProjectAccess, error) {
		f.scoped("authorize")
		if ctx != f.ctx || dao != f.project || p != f.principal {
			t.Fatal("authorization scope/context/principal changed")
		}
		return model.ProjectAccess{}, f.authErr
	}
	f.svc.writeOperations.admitAdd = func(h model.TaskHeader, rows []model.TaskStep, step model.TaskStep, before, after *string) (tasksteps.Mutation, error) {
		f.scoped("admit")
		if h != f.header || !reflect.DeepEqual(rows, f.expectedCurrent) || step != f.addStep || !reflect.DeepEqual(before, f.before) || !reflect.DeepEqual(after, f.after) {
			t.Fatalf("Add admission arguments: %+v %+v %v %v", h, step, before, after)
		}
		return f.mutation, f.admitErr
	}
	f.svc.writeOperations.admitChange = func(h model.TaskHeader, rows []model.TaskStep, id string, changes tasksteps.Changes) (tasksteps.Mutation, error) {
		f.scoped("admit")
		if h != f.header || !reflect.DeepEqual(rows, f.expectedCurrent) || id != f.changeID || !reflect.DeepEqual(changes, f.changes) {
			t.Fatalf("Change admission arguments: %+v %s %+v", h, id, changes)
		}
		return f.mutation, f.admitErr
	}
	return f
}
func writePath(stop string) []string {
	path := []string{"store"}
	if stop == "store" {
		return append(path, "complete")
	}
	path = append(path, "projectDAO", "authorize")
	if stop == "auth" {
		return append(path, "complete")
	}
	path = append(path, "taskDAO", "header")
	if stop == "header" {
		return append(path, "complete")
	}
	path = append(path, "taskDAO", "rows")
	if stop == "rows" {
		return append(path, "complete")
	}
	path = append(path, "admit")
	if stop == "admit" {
		return append(path, "complete")
	}
	path = append(path, "taskDAO", "clock", "taskDAO", stop)
	if stop == "updateFail" {
		path[len(path)-1] = "update"
		return append(path, "complete")
	}
	return append(path, "taskDAO", "touch", "taskDAO", "header", "captureDAO", "capture", "complete")
}
func expectReceipt(t *testing.T, r StepsWriteResult, err error, changed bool) {
	t.Helper()
	if err != nil || r.Changed != changed || r.Phase != "commit" || r.TransactionOutcome != store.TransactionCommitted || r.CleanupFailed || len(r.JSON) == 0 {
		t.Fatalf("receipt %+v %v", r, err)
	}
	stepReadJSON(t, r.Resource, r.JSON)
}
func expectRefusal(t *testing.T, r StepsWriteResult, err error, code string) {
	t.Helper()
	stepReadFault(t, err, code)
	if r.JSON != nil || r.TransactionOutcome != store.TransactionNotCommitted || !reflect.DeepEqual(r.Resource, taskcodec.StepsResource{}) {
		t.Fatalf("refusal receipt %+v", r)
	}
}
func expectInternal(t *testing.T, r StepsWriteResult, err, cause error) {
	t.Helper()
	if !errors.Is(err, cause) || r.JSON != nil || r.TransactionOutcome != store.TransactionNotCommitted {
		t.Fatalf("internal failure %+v %v", r, err)
	}
	if _, pure := TaskStepsFault(err); pure {
		t.Fatal("internal failure became refusal")
	}
}
func (f *strictStepWrite) changed(step model.TaskStep, observed time.Time, action string, fields []string, previous, status string) {
	f.expectedWrite = step
	f.observed = observed
	f.expectedFact = protocol.Fact{Type: protocol.StepUpdated, ProjectID: f.header.ProjectID, TaskID: f.header.ID, TaskVersion: f.header.Version + 1, OccurredAt: observed, StepID: step.ID, Action: action, ChangedFields: fields, PreviousStatus: previous, Status: status}
}

func TestTaskStepsAddUsesHeaderAndPreservesExistingContent(t *testing.T) {
	h := writeHeader(1)
	at := time.Date(2026, 3, 4, 5, 6, 7, 123456000, time.UTC)
	first := model.TaskStep{ID: "abcdef01", Title: "same", Status: model.TaskStepTodo, CreatedAt: at, UpdatedAt: at}
	f := newStrictStepWrite(t, h, []model.TaskStep{})
	f.addStep = model.TaskStep{ID: "abcdef01", Title: "same", Status: model.TaskStepTodo}
	f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{f.addStep}, To: 0, Changed: true}
	f.changed(first, at, "created", nil, "", "")
	f.begin(writePath("insert")...)
	result, err := f.svc.Add(f.ctx, f.principal, h.ProjectID, h.ID, AddTaskStep{Version: 1, ID: "ABCDEF01", Title: "same"})
	f.end()
	expectReceipt(t, result, err, true)
	post := h
	post.Version++
	if !reflect.DeepEqual(result.Resource, taskcodec.ProjectCollection(post, []model.TaskStep{first})) {
		t.Fatalf("first Add %+v", result.Resource)
	}
	h.Version++
	rows := []model.TaskStep{first}
	original := slices.Clone(rows)
	at = at.Add(time.Microsecond)
	expected := model.TaskStep{ID: "00000000", Title: "same", Description: "  # 原值\n<>&  ", Status: model.TaskStepSkipped, CreatedAt: at, UpdatedAt: at}
	f = newStrictStepWrite(t, h, rows)
	f.addStep = model.TaskStep{ID: expected.ID, Title: expected.Title, Description: expected.Description, Status: expected.Status}
	f.before = stepWritePtr("abcdef01")
	moved := first
	moved.Position = 1
	f.mutation = tasksteps.Mutation{Candidate: []model.TaskStep{f.addStep, moved}, To: 0, Changed: true}
	f.changed(expected, at, "created", nil, "", "")
	f.begin(writePath("insert")...)
	result, err = f.svc.Add(f.ctx, f.principal, h.ProjectID, h.ID, AddTaskStep{Version: 2, ID: "00000000", Title: "same", Description: expected.Description, Status: stepWritePtr(model.TaskStepSkipped), Before: stepWritePtr("ABCDEF01")})
	f.end()
	expectReceipt(t, result, err, true)
	post = h
	post.Version++
	if !reflect.DeepEqual(result.Resource, taskcodec.ProjectCollection(post, []model.TaskStep{expected, moved})) || !reflect.DeepEqual(rows, original) {
		t.Fatalf("second Add %+v", result.Resource)
	}
}
func TestTaskStepsAddAdmissionAndRefusalOrder(t *testing.T) {
	for _, tc := range []struct {
		version, actual int64
		id              string
		before          *string
		code            string
	}{
		{1, 2, "00000000", stepWritePtr("ffffffff"), "version_conflict"}, {2, 2, "00000000", stepWritePtr("ffffffff"), "step_id_conflict"}, {2, 2, "12345678", stepWritePtr("ffffffff"), "not_found"}, {2, math.MaxInt64, "00000000", nil, "version_conflict"}, {math.MaxInt64, math.MaxInt64, "00000000", nil, "step_id_conflict"}, {math.MaxInt64, math.MaxInt64, "12345678", stepWritePtr("ffffffff"), "not_found"}, {math.MaxInt64, math.MaxInt64, "12345678", nil, "version_exhausted"},
	} {
		t.Run(tc.code+"/"+tc.id, func(t *testing.T) {
			rows := writeRows()[:1]
			original := slices.Clone(rows)
			f := newStrictStepWrite(t, writeHeader(tc.actual), rows)
			f.addStep = model.TaskStep{ID: tc.id, Title: "x", Status: model.TaskStepTodo}
			f.before = tc.before
			stop := "admit"
			if tc.version != tc.actual {
				stop = "header"
			} else {
				f.admitErr = &model.Fault{Code: tc.code, Message: "controlled refusal"}
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Add(f.ctx, f.principal, f.header.ProjectID, f.header.ID, AddTaskStep{Version: tc.version, ID: tc.id, Title: "x", Before: tc.before})
			f.end()
			expectRefusal(t, r, err, tc.code)
			if !reflect.DeepEqual(rows, original) {
				t.Fatal("refusal changed rows")
			}
		})
	}
	for _, stage := range []string{"principal", "project ID", "task ID", "missing project", "missing task", "project access", "deleted task"} {
		t.Run(stage, func(t *testing.T) {
			f := newStrictStepWrite(t, writeHeader(2), writeRows()[:1])
			p, project, task, code := f.principal, f.projectID, f.taskID, "not_found"
			stop := ""
			switch stage {
			case "principal":
				p = model.Principal{}
				code = "unauthenticated"
			case "project ID":
				project = "bad"
				code = "invalid_input"
			case "task ID":
				task = "bad"
				code = "invalid_input"
			case "missing project":
				project = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.projectID = project
				f.startErr = &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
				stop = "store"
			case "missing task":
				task = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.taskID = task
				f.headerErr = model.ErrNotFound
				stop = "header"
			case "project access":
				p.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				f.principal = p
				f.authErr = &model.Fault{Code: "not_found", Message: "controlled"}
				stop = "auth"
			case "deleted task":
				d := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
				f.header.DeletedAt = &d
				f.header.Version = math.MaxInt64
				code = "task_deleted"
				stop = "header"
			}
			if stop != "" {
				f.begin(writePath(stop)...)
			} else {
				f.begin()
			}
			r, err := f.svc.Add(f.ctx, p, project, task, AddTaskStep{Version: 2, ID: "12345678", Title: "x"})
			f.end()
			expectRefusal(t, r, err, code)
		})
	}
}
func TestTaskStepsAddInputAndStorageFailures(t *testing.T) {
	for _, input := range []AddTaskStep{{Version: 0, ID: "00000000", Title: "x"}, {Version: 1, ID: "bad", Title: "x"}, {Version: 1, ID: "00000000", Title: "\u0085"}, {Version: 1, ID: "00000000", Title: "x", Description: "\x00"}, {Version: 1, ID: "00000000", Title: "x", Status: stepWritePtr(model.TaskStepStatus(""))}, {Version: 1, ID: "00000000", Title: "x", Before: stepWritePtr("00000001"), After: stepWritePtr("00000002")}, {Version: 1, ID: "00000000", Title: "x", Before: stepWritePtr("bad")}} {
		f := newStrictStepWrite(t, writeHeader(1), nil)
		f.begin()
		r, err := f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, input)
		f.end()
		expectRefusal(t, r, err, "invalid_input")
	}
	rows := writeRows()[:1]
	rows[0].Position = 2
	f := newStrictStepWrite(t, writeHeader(2), rows)
	cause := errors.New("corrupt collection")
	f.addStep = model.TaskStep{ID: "abcdef01", Title: "x", Status: model.TaskStepTodo}
	f.admitErr = cause
	f.begin(writePath("admit")...)
	r, err := f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, AddTaskStep{Version: 2, ID: "abcdef01", Title: "x"})
	f.end()
	expectInternal(t, r, err, cause)
	f = newStrictStepWrite(t, writeHeader(2), rows)
	cause = errors.New("closed store")
	f.startErr = cause
	f.begin(writePath("store")...)
	r, err = f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, AddTaskStep{Version: 2, ID: "abcdef01", Title: "x"})
	f.end()
	expectInternal(t, r, err, cause)
}
func TestTaskStepsFaultRejectsTypedCompletionFailures(t *testing.T) {
	refusal := &model.Fault{Code: "step_id_conflict", Message: "private business refusal"}
	for _, failure := range []*store.TransactionError{{Phase: "cleanup", Cause: refusal, Outcome: store.TransactionNotCommitted, CleanupFailed: true}, {Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true}, {Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown}} {
		if _, pure := TaskStepsFault(failure); pure {
			t.Fatal("transaction completion fault concealed")
		}
		if _, pure := TaskStepsFault(&model.Fault{Code: "not_found", Message: "wrapped refusal", Cause: failure}); pure {
			t.Fatal("wrapped completion fault concealed")
		}
	}
	failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
	if actual, pure := TaskStepsFault(failure); !pure || actual != refusal {
		t.Fatal("confirmed pure refusal lost")
	}
}
func TestTaskStepsAddQueryFailuresRemainInternal(t *testing.T) {
	for _, stage := range []string{"header", "collection"} {
		t.Run(stage, func(t *testing.T) {
			f := newStrictStepWrite(t, writeHeader(1), nil)
			cause := errors.New(stage + " query failed")
			stop := "header"
			if stage == "header" {
				f.headerErr = cause
			} else {
				f.rowsErr = cause
				stop = "rows"
			}
			f.begin(writePath(stop)...)
			r, err := f.svc.Add(f.ctx, f.principal, f.projectID, f.taskID, AddTaskStep{Version: 1, ID: "00000000", Title: "x"})
			f.end()
			expectInternal(t, r, err, cause)
		})
	}
}

func (f *strictStepWrite) unexpected(name string) {
	f.t.Helper()
	f.t.Fatalf("unexpected %s call", name)
}
func (f *strictStepWrite) Task(context.Context, string) (model.Task, error) {
	f.unexpected("Task")
	return model.Task{}, nil
}
func (f *strictStepWrite) TasksByID(context.Context, []string) ([]model.Task, error) {
	f.unexpected("TasksByID")
	return nil, nil
}
func (f *strictStepWrite) VisibleTaskIDs(context.Context, []string) ([]string, error) {
	panic("unexpected VisibleTaskIDs")
}
func (f *strictStepWrite) ActiveDependentIDs(context.Context, string) ([]string, error) {
	f.unexpected("ActiveDependentIDs")
	return nil, nil
}
func (f *strictStepWrite) Reachable(context.Context, string, string, store.DependencyReplacement) (bool, error) {
	f.unexpected("Reachable")
	return false, nil
}
func (f *strictStepWrite) CreateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	f.unexpected("CreateTask")
	return model.Task{}, nil
}
func (f *strictStepWrite) UpdateTask(context.Context, string, store.TaskWrite) (model.Task, error) {
	f.unexpected("UpdateTask")
	return model.Task{}, nil
}
func (f *strictStepWrite) DependentIDs(context.Context, string) ([]string, error) {
	f.unexpected("DependentIDs")
	return nil, nil
}
func (f *strictStepWrite) DeleteTask(context.Context, string, bool) (model.TaskTombstone, error) {
	f.unexpected("DeleteTask")
	return model.TaskTombstone{}, nil
}
func (f *strictStepWrite) MoveTaskStep(context.Context, string, string, int64, int64) error {
	f.unexpected("MoveTaskStep")
	return nil
}
func (f *strictStepWrite) DeleteTaskStep(context.Context, string, string, int64, int64) error {
	f.unexpected("DeleteTaskStep")
	return nil
}
func (p *strictWriteProject) InvalidateTaskCache(context.Context) error {
	p.f.unexpected("InvalidateTaskCache")
	return nil
}
func (p *strictWriteProject) Project(context.Context) (model.Project, error) {
	p.f.unexpected("Project")
	return model.Project{}, nil
}
func (p *strictWriteProject) UpdateProjectSettings(context.Context, int32) (model.Project, error) {
	p.f.unexpected("UpdateProjectSettings")
	return model.Project{}, nil
}
func (p *strictWriteProject) DirectProjectMember(context.Context, string) (model.ProjectMember, error) {
	p.f.unexpected("DirectProjectMember")
	return model.ProjectMember{}, nil
}
func (p *strictWriteProject) SetMemberRole(context.Context, string, model.ProjectRole) (model.ProjectMember, error) {
	p.f.unexpected("SetMemberRole")
	return model.ProjectMember{}, nil
}
func (p *strictWriteProject) RemoveMember(context.Context, string) error {
	p.f.unexpected("RemoveMember")
	return nil
}
func (p *strictWriteProject) AddInvitedMember(context.Context, string) (model.ProjectMember, error) {
	p.f.unexpected("AddInvitedMember")
	return model.ProjectMember{}, nil
}
func (p *strictWriteProject) LockInvitation(context.Context, []byte) (model.ProjectInvitation, error) {
	p.f.unexpected("LockInvitation")
	return model.ProjectInvitation{}, nil
}
func (p *strictWriteProject) CreateInvitation(context.Context, model.ProjectInvitation) error {
	p.f.unexpected("CreateInvitation")
	return nil
}
func (p *strictWriteProject) RevokeInvitation(context.Context, string, time.Time) error {
	p.f.unexpected("RevokeInvitation")
	return nil
}
func (p *strictWriteProject) ConsumeInvitation(context.Context, string, string, time.Time) error {
	p.f.unexpected("ConsumeInvitation")
	return nil
}
func (p *strictWriteProject) DirectGrant(context.Context, string) (model.ProjectGrant, error) {
	p.f.unexpected("DirectGrant")
	return model.ProjectGrant{}, nil
}
func (p *strictWriteProject) CreateGrant(context.Context, string, model.ProjectRole) (model.ProjectGrant, error) {
	p.f.unexpected("CreateGrant")
	return model.ProjectGrant{}, nil
}
func (p *strictWriteProject) LockTransferOwnership(context.Context) (model.ProjectOwnership, error) {
	p.f.unexpected("LockTransferOwnership")
	return model.ProjectOwnership{}, nil
}
func (p *strictWriteProject) LockTransferTeams(context.Context, string, string) (store.TransferTeam, store.TransferTeam, error) {
	p.f.unexpected("LockTransferTeams")
	return store.TransferTeam{}, store.TransferTeam{}, nil
}
func (p *strictWriteProject) MoveOwnership(context.Context, string) (model.ProjectOwnership, error) {
	p.f.unexpected("MoveOwnership")
	return model.ProjectOwnership{}, nil
}

func (f *strictStepWrite) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	f.unexpected("ReadSnapshot")
	return nil
}
func (d *strictWriteCaptureDAO) FreezeAudience(context.Context, string, []string) ([]store.WebhookAudience, error) {
	d.f.unexpected("FreezeAudience")
	return nil, nil
}
func (d *strictWriteCaptureDAO) RecordedAt(context.Context) (time.Time, error) {
	d.f.unexpected("RecordedAt")
	return time.Time{}, nil
}
func (d *strictWriteCaptureDAO) Policy(context.Context, int64) (webhook.Policy, error) {
	d.f.unexpected("Policy")
	return webhook.Policy{}, nil
}
func (d *strictWriteCaptureDAO) SaveCapture(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error {
	d.f.unexpected("SaveCapture")
	return nil
}
