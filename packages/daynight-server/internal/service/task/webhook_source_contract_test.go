package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

const (
	sourceUserID    = "11111111-1111-4111-8111-111111111111"
	sourceProjectID = "22222222-2222-4222-8222-222222222222"
	sourceTaskID    = "33333333-3333-4333-8333-333333333333"
	sourceClaimID   = "44444444-4444-4444-8444-444444444444"
)

type sourceContextKey struct{}

type sourceCapture struct {
	t     *testing.T
	dao   store.WebhookCaptureDAO
	calls []string
	trace *[]string
	facts []protocol.Fact
	cause error
}

func (c *sourceCapture) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	c.t.Helper()
	if ctx.Value(sourceContextKey{}) != c || dao != c.dao {
		c.t.Fatal("source capture escaped its context or transaction DAO")
	}
	c.calls = append(c.calls, "capture")
	*c.trace = append(*c.trace, "capture")
	c.facts = append(c.facts, facts...)
	return c.cause
}

type sourceCaptureDAO struct{ store.WebhookCaptureDAO }

type sourceProjectDAO struct {
	store.ProjectWriteDAO
	t          *testing.T
	calls      *[]string
	invalidate bool
}

func (d sourceProjectDAO) ProjectAccess(_ context.Context, principal model.Principal) (model.ProjectAccess, error) {
	d.t.Helper()
	if principal.UserID != sourceUserID {
		d.t.Fatalf("unexpected source principal: %#v", principal)
	}
	return model.ProjectAccess{ProjectID: sourceProjectID, UserID: sourceUserID, Role: model.ProjectAdmin}, nil
}

func (d sourceProjectDAO) InvalidateTaskCache(context.Context) error {
	d.t.Helper()
	if !d.invalidate {
		d.t.Fatal("unexpected source cache invalidation")
	}
	*d.calls = append(*d.calls, "invalidate")
	return nil
}

type sourceSessionDAO struct {
	store.ProjectSessionDAO
	t     *testing.T
	calls *[]string
}

func (d sourceSessionDAO) DrainTaskSessions(_ context.Context, taskID string, _ store.TaskSessionDrain) error {
	d.t.Helper()
	if taskID != sourceTaskID {
		d.t.Fatalf("unexpected drained Task: %s", taskID)
	}
	*d.calls = append(*d.calls, "drain")
	return nil
}

func (d sourceSessionDAO) TransitionTaskSessionReceipts(_ context.Context, taskID string, _ store.TaskSessionReceiptTransition) error {
	d.t.Helper()
	if taskID != sourceTaskID {
		d.t.Fatalf("unexpected receipt Task: %s", taskID)
	}
	*d.calls = append(*d.calls, "receipts")
	return nil
}

type sourceTaskDAO struct {
	store.TaskWriteDAO
	t           *testing.T
	current     model.Task
	updated     model.Task
	calls       *[]string
	clock       time.Time
	clockCalls  int
	allowClock  bool
	taskCalls   int
	lookups     int
	allowLookup bool
	writes      []store.TaskWrite
	headerCalls int
	headers     []model.TaskHeader
	steps       []model.TaskStep
	stepWrites  []model.TaskStep
	stepAction  string
	tombstone   *model.TaskTombstone
	create      bool
}

func (d *sourceTaskDAO) Task(_ context.Context, id string) (model.Task, error) {
	d.t.Helper()
	if id != sourceTaskID || d.taskCalls != 0 {
		d.t.Fatalf("unexpected source Task read: %s", id)
	}
	d.taskCalls++
	return d.current, nil
}

func (d *sourceTaskDAO) ActiveDependentIDs(_ context.Context, id string) ([]string, error) {
	d.t.Helper()
	if d.current.Status != model.TaskDone || id != sourceTaskID {
		d.t.Fatal("unexpected active dependent read")
	}
	return []string{}, nil
}

func (d *sourceTaskDAO) TasksByID(_ context.Context, ids []string) ([]model.Task, error) {
	d.t.Helper()
	if !d.allowLookup || d.lookups != 0 || len(ids) != 0 {
		d.t.Fatalf("unexpected dependency lookup: %v", ids)
	}
	d.lookups++
	return []model.Task{}, nil
}

func (d *sourceTaskDAO) UpdateTask(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
	d.t.Helper()
	if id != sourceTaskID || d.updated.ID == "" {
		d.t.Fatal("unexpected source Task update")
	}
	d.writes = append(d.writes, values)
	*d.calls = append(*d.calls, "update")
	return d.updated, nil
}

func (d *sourceTaskDAO) CreateTask(_ context.Context, id string, values store.TaskWrite) (model.Task, error) {
	d.t.Helper()
	if !d.create || values.Title != "Source" || values.Status != model.TaskProposed || string(values.Properties["paused"]) != "true" {
		d.t.Fatalf("unexpected source creation: %#v", values)
	}
	d.writes = append(d.writes, values)
	*d.calls = append(*d.calls, "create")
	projection := d.updated
	projection.ID = id
	return projection, nil
}

func (d *sourceTaskDAO) ObservedAt(context.Context) (time.Time, error) {
	d.t.Helper()
	if !d.allowClock || d.clockCalls != 0 {
		d.t.Fatal("unexpected source time observation")
	}
	d.clockCalls++
	return d.clock, nil
}

func (d *sourceTaskDAO) DeleteTask(_ context.Context, id string, removeDepends bool) (model.TaskTombstone, error) {
	d.t.Helper()
	if id != sourceTaskID || !removeDepends || d.tombstone == nil {
		d.t.Fatal("unexpected source deletion")
	}
	*d.calls = append(*d.calls, "delete")
	return *d.tombstone, nil
}

func (d *sourceTaskDAO) TaskHeader(_ context.Context, id string) (model.TaskHeader, error) {
	d.t.Helper()
	if id != sourceTaskID || d.stepAction == "" {
		d.t.Fatal("unexpected Step parent read")
	}
	d.headerCalls++
	if d.headerCalls > len(d.headers) {
		d.t.Fatal("extra Step parent read")
	}
	return d.headers[d.headerCalls-1], nil
}

func (d *sourceTaskDAO) TaskSteps(_ context.Context, id string) ([]model.TaskStep, error) {
	d.t.Helper()
	if id != sourceTaskID || d.stepAction == "" || d.steps == nil {
		d.t.Fatal("unexpected Step collection read")
	}
	result := make([]model.TaskStep, len(d.steps))
	copy(result, d.steps)
	return result, nil
}

func (d *sourceTaskDAO) InsertTaskStep(_ context.Context, id string, step model.TaskStep) error {
	d.t.Helper()
	if d.stepAction != "created" || id != sourceTaskID || step.ID != "87654321" {
		d.t.Fatalf("unexpected Step insert: %s %#v", id, step)
	}
	*d.calls = append(*d.calls, "step")
	d.stepWrites = append(d.stepWrites, step)
	return nil
}

func (d *sourceTaskDAO) UpdateTaskStep(_ context.Context, id string, step model.TaskStep) error {
	d.t.Helper()
	if (d.stepAction != "updated" && d.stepAction != "status_changed") || id != sourceTaskID || step.ID != "abcdef01" {
		d.t.Fatalf("unexpected Step update: %s %#v", id, step)
	}
	*d.calls = append(*d.calls, "step")
	d.stepWrites = append(d.stepWrites, step)
	return nil
}

func (d *sourceTaskDAO) MoveTaskStep(_ context.Context, id, stepID string, from, to int64) error {
	d.t.Helper()
	if d.stepAction != "moved" || id != sourceTaskID || stepID != "12345678" || from != 1 || to != 0 {
		d.t.Fatalf("unexpected Step move: %s %s %d %d", id, stepID, from, to)
	}
	*d.calls = append(*d.calls, "step")
	return nil
}

func (d *sourceTaskDAO) DeleteTaskStep(_ context.Context, id, stepID string, from, remaining int64) error {
	d.t.Helper()
	if d.stepAction != "deleted" || id != sourceTaskID || stepID != "abcdef01" || from != 0 || remaining != 1 {
		d.t.Fatalf("unexpected Step deletion: %s %s %d %d", id, stepID, from, remaining)
	}
	*d.calls = append(*d.calls, "step")
	return nil
}

func (d *sourceTaskDAO) TouchTask(_ context.Context, id string, observed time.Time) error {
	d.t.Helper()
	if d.stepAction == "" || id != sourceTaskID || !observed.Equal(d.clock) {
		d.t.Fatal("unexpected Step revision update")
	}
	*d.calls = append(*d.calls, "touch")
	return nil
}

type sourceWriteScope struct {
	store.ProjectWriteScope
	tasks    *sourceTaskDAO
	projects sourceProjectDAO
	sessions sourceSessionDAO
	capture  store.WebhookCaptureDAO
}

func (s sourceWriteScope) TaskDAO() store.TaskWriteDAO         { return s.tasks }
func (s sourceWriteScope) ProjectDAO() store.ProjectWriteDAO   { return s.projects }
func (s sourceWriteScope) SessionDAO() store.ProjectSessionDAO { return s.sessions }
func (s sourceWriteScope) CaptureDAO() store.WebhookCaptureDAO { return s.capture }

type sourceWriteStore struct {
	t     *testing.T
	ctx   context.Context
	scope sourceWriteScope
	calls int
}

func (d *sourceWriteStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	d.t.Helper()
	d.t.Error("source write unexpectedly entered a separate snapshot")
	panic("unexpected source snapshot")
}

func (d *sourceWriteStore) WriteProject(ctx context.Context, project string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	d.t.Helper()
	if ctx != d.ctx || project != sourceProjectID || work == nil || d.calls != 0 {
		d.t.Fatalf("unexpected source Project scope: %s", project)
	}
	d.calls++
	if err := work(d.scope); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func sourceTask(status model.TaskStatus) model.Task {
	now := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	return model.Task{ID: sourceTaskID, ProjectID: sourceProjectID, Title: "Source", Status: status, Version: 7, CreatedAt: now, UpdatedAt: now, Properties: model.TaskProperties{}, DependsOn: []string{}, ExternalDependsOn: []string{}}
}

func sourcePrincipal() model.Principal {
	return model.Principal{Kind: model.PATCredential, UserID: sourceUserID, CredentialID: "55555555-5555-4555-8555-555555555555"}
}

func newSourceWrite(t *testing.T, current, updated model.Task) (*sourceWriteStore, *sourceCapture, context.Context, *[]string) {
	t.Helper()
	calls := []string{}
	marker := &sourceCaptureDAO{}
	record := &sourceCapture{t: t, dao: marker, trace: &calls}
	dao := &sourceTaskDAO{t: t, current: current, updated: updated, clock: current.UpdatedAt.Add(time.Second), calls: &calls}
	ctx := context.WithValue(t.Context(), sourceContextKey{}, record)
	database := &sourceWriteStore{t: t, ctx: ctx, scope: sourceWriteScope{tasks: dao, projects: sourceProjectDAO{t: t, calls: &calls}, sessions: sourceSessionDAO{t: t, calls: &calls}, capture: marker}}
	return database, record, ctx, &calls
}

func assertSourceFact(t *testing.T, record *sourceCapture, current model.Task, kind string) protocol.Fact {
	t.Helper()
	if len(record.facts) != 1 {
		t.Fatalf("expected one source fact: %#v", record.facts)
	}
	f := record.facts[0]
	if f.Type != kind || f.ProjectID != current.ProjectID || f.TaskID != current.ID || f.TaskVersion != current.Version || !f.OccurredAt.Equal(current.UpdatedAt) {
		t.Fatalf("source fact did not use authoritative row: %#v", f)
	}
	return f
}

func TestTaskStatusSourcesUseAuthoritativeRows(t *testing.T) {
	for _, transition := range [][2]model.TaskStatus{{model.TaskTodo, model.TaskInProgress}, {model.TaskInProgress, model.TaskDone}, {model.TaskDone, model.TaskTodo}, {model.TaskTodo, model.TaskCancelled}} {
		t.Run(string(transition[0])+" to "+string(transition[1]), func(t *testing.T) {
			current := sourceTask(transition[0])
			updated := current
			updated.Status, updated.Version, updated.UpdatedAt = transition[1], 8, current.UpdatedAt.Add(time.Second)
			db, record, ctx, calls := newSourceWrite(t, current, updated)
			got, err := NewTasks(db, record).SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: transition[1]})
			if err != nil || got.Version != 8 || len(db.scope.tasks.writes) != 1 || db.scope.tasks.writes[0].Status != transition[1] {
				t.Fatalf("status source: %#v %v", got, err)
			}
			f := assertSourceFact(t, record, updated, protocol.StatusChanged)
			if f.PreviousStatus != string(transition[0]) || f.Status != string(transition[1]) || f.Paused || !reflect.DeepEqual(*calls, []string{"update", "drain", "receipts", "capture"}) {
				t.Fatalf("status source attribution: %#v, %v", f, *calls)
			}
		})
	}
}

func TestTaskCreationCapturesCreatedPausedFactInSourceScope(t *testing.T) {
	created := sourceTask(model.TaskProposed)
	created.Version = 1
	created.Properties = model.TaskProperties{"paused": []byte(`true`)}
	db, record, ctx, calls := newSourceWrite(t, model.Task{}, created)
	db.scope.tasks.create, db.scope.tasks.allowLookup = true, true
	got, err := NewTasks(db, record).Create(ctx, sourcePrincipal(), sourceProjectID, taskcore.CreateTask{Title: "Source", Properties: model.TaskProperties{"paused": []byte(`true`)}})
	if err != nil || len(record.facts) != 1 || !reflect.DeepEqual(*calls, []string{"create", "capture"}) {
		t.Fatalf("creation capture: %#v %v, %v", record.facts, err, *calls)
	}
	f := record.facts[0]
	if f.Type != protocol.Created || f.TaskID != got.ID || f.ProjectID != got.ProjectID || f.TaskVersion != got.Version || f.Status != "proposed" || !f.Paused || !f.OccurredAt.Equal(got.CreatedAt) {
		t.Fatalf("created source: %#v", f)
	}
}

func TestTaskSourceRefusalsAndNoopsDoNotInvokeCapture(t *testing.T) {
	for _, mode := range []string{"same status", "same title", "stale status", "stale delete", "invalid create"} {
		t.Run(mode, func(t *testing.T) {
			current := sourceTask(model.TaskTodo)
			db, record, ctx, calls := newSourceWrite(t, current, model.Task{})
			s := NewTasks(db, record)
			var err error
			switch mode {
			case "same status":
				_, err = s.SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: model.TaskTodo})
			case "same title":
				db.scope.tasks.allowLookup = true
				_, err = s.Update(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.UpdateTask{Version: 7, Title: sourcePointer("Source")})
			case "stale status":
				_, err = s.SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 6, Status: model.TaskInProgress})
			case "stale delete":
				err = s.Delete(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.DeleteTask{Version: 6})
			case "invalid create":
				_, err = s.Create(ctx, sourcePrincipal(), sourceProjectID, taskcore.CreateTask{})
			}
			if mode == "same status" || mode == "same title" {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				want := "version_conflict"
				if mode == "invalid create" {
					want = "invalid_input"
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != want {
					t.Fatalf("source refusal: %v", err)
				}
			}
			if len(record.calls) != 0 || len(*calls) != 0 || len(db.scope.tasks.writes) != 0 {
				t.Fatalf("refusal/no-op invoked source effects: %v %v", record.calls, *calls)
			}
		})
	}
}

func sourceWorker(t *testing.T, state model.WorkerState, claimID, worktreeID string, phase model.WorkerPhase, claimedAt time.Time) model.TaskProperties {
	t.Helper()
	p, err := taskproperties.WithWorker(model.TaskProperties{}, &model.WorkerClaim{ClaimID: claimID, State: state, UserID: sourceUserID, WorkerID: "66666666-6666-4666-8666-666666666666", Machine: model.WorkerMachine{ID: "77777777-7777-4777-8777-777777777777", Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: worktreeID, Phase: phase, ClaimedAt: claimedAt})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestWorkerSourcePublishesOnlyLogicalTaskTransitions(t *testing.T) {
	for _, mode := range []string{"claim", "reclaim", "release", "withdraw", "phase", "complete", "wrong completion"} {
		t.Run(mode, func(t *testing.T) {
			current := sourceTask(model.TaskInProgress)
			current.AssignedTo, current.AllowAgents = sourcePointer(sourceUserID), true
			current.Properties = sourceWorker(t, model.WorkerActive, sourceClaimID, "88888888-8888-4888-8888-888888888888", model.WorkerPreparing, current.CreatedAt)
			updated := current
			updated.Version, updated.UpdatedAt = 8, current.UpdatedAt.Add(time.Second)
			descriptor := taskcore.WorkerDescriptor{ClaimID: sourceClaimID, WorkerID: "66666666-6666-4666-8666-666666666666", Machine: model.WorkerMachine{ID: "77777777-7777-4777-8777-777777777777", Name: "Machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "99999999-9999-4999-8999-999999999999"}
			switch mode {
			case "claim":
				current.Status, current.Properties = model.TaskTodo, model.TaskProperties{}
				updated.Properties = sourceWorker(t, model.WorkerActive, sourceClaimID, descriptor.WorktreeID, model.WorkerPreparing, current.UpdatedAt.Add(time.Second))
			case "reclaim":
				current.Status = model.TaskTodo
				current.Properties = model.TaskProperties{}
				descriptor.ClaimID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
				updated.Properties = sourceWorker(t, model.WorkerActive, descriptor.ClaimID, descriptor.WorktreeID, model.WorkerPreparing, current.UpdatedAt.Add(time.Second))
			case "release":
				updated.Status = model.TaskTodo
				updated.Properties = model.TaskProperties{}
			case "withdraw":
				updated.Status, updated.AllowAgents, updated.Properties = model.TaskTodo, false, model.TaskProperties{}
			case "phase":
				updated.Properties = sourceWorker(t, model.WorkerActive, sourceClaimID, "88888888-8888-4888-8888-888888888888", model.WorkerExecuting, current.CreatedAt)
			case "complete", "wrong completion":
				updated.Status = model.TaskDone
				updated.Properties = sourceWorker(t, model.WorkerCompleted, sourceClaimID, "88888888-8888-4888-8888-888888888888", model.WorkerPreparing, current.CreatedAt)
			}
			db, record, ctx, _ := newSourceWrite(t, current, updated)
			db.scope.tasks.allowClock = mode == "claim" || mode == "reclaim"
			s := NewTasks(db, record)
			var err error
			switch mode {
			case "claim", "reclaim":
				_, err = s.ClaimWorker(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.ClaimWorker{Version: 7, WorkerDescriptor: descriptor})
			case "release":
				_, err = s.ReleaseWorker(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.ReleaseWorker{Version: 7, ClaimID: sourceClaimID, StoppedConfirmed: true})
			case "withdraw":
				_, err = s.WithdrawWorker(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.WithdrawWorker{Version: 7, ClaimID: sourceClaimID})
			case "phase":
				_, err = s.UpdateWorker(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.UpdateWorker{Version: 7, ClaimID: sourceClaimID, Phase: sourcePointer(model.WorkerExecuting)})
			default:
				claim := sourceClaimID
				if mode == "wrong completion" {
					claim = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				}
				_, err = s.SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: model.TaskDone, ClaimID: &claim})
			}
			if mode == "wrong completion" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "claim_conflict" || len(record.calls) != 0 || len(db.scope.tasks.writes) != 0 {
					t.Fatalf("rejected completion captured or wrote: %#v %v", record.facts, err)
				}
				return
			}
			if err != nil || len(db.scope.tasks.writes) != 1 || db.scope.tasks.writes[0].Status != updated.Status || !reflect.DeepEqual(db.scope.tasks.writes[0].Properties, updated.Properties) {
				t.Fatalf("worker source: %v", err)
			}
			if mode == "phase" {
				worker, err := taskproperty.Worker(db.scope.tasks.writes[0].Properties)
				if err != nil || worker.Phase != model.WorkerExecuting || len(record.calls) != 0 {
					t.Fatalf("phase update became logical source: %#v %v", record.facts, err)
				}
				return
			}
			f := assertSourceFact(t, record, updated, protocol.StatusChanged)
			if f.PreviousStatus != string(current.Status) || f.Status != string(updated.Status) || f.Paused {
				t.Fatalf("worker source status: %#v", f)
			}
		})
	}
}

func TestWebhookWorkerLocalPauseDoesNotPublishTaskPause(t *testing.T) {
	current := sourceTask(model.TaskInProgress)
	current.AssignedTo, current.AllowAgents = sourcePointer(sourceUserID), true
	current.Properties = sourceWorker(t, model.WorkerActive, sourceClaimID, "88888888-8888-4888-8888-888888888888", model.WorkerPreparing, current.CreatedAt)
	updated := current
	updated.Version, updated.UpdatedAt = 8, current.UpdatedAt.Add(time.Second)
	updated.Properties = sourceWorker(t, model.WorkerActive, sourceClaimID, "88888888-8888-4888-8888-888888888888", model.WorkerPaused, current.CreatedAt)
	database, record, ctx, calls := newSourceWrite(t, current, updated)
	result, err := NewTasks(database, record).UpdateWorker(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.UpdateWorker{Version: current.Version, ClaimID: sourceClaimID, Phase: sourcePointer(model.WorkerPaused)})
	if err != nil || len(database.scope.tasks.writes) != 1 {
		t.Fatalf("worker pause write: %#v %v", result, err)
	}
	worker, err := taskproperty.Worker(result.Properties)
	if err != nil || worker == nil || worker.Phase != model.WorkerPaused || len(record.facts) != 0 || len(record.calls) != 0 || !reflect.DeepEqual(*calls, []string{"update", "drain", "receipts"}) {
		t.Fatalf("Worker-local pause became a Task source fact: worker=%#v facts=%#v calls=%v err=%v", worker, record.facts, *calls, err)
	}
}

func TestTaskDeletionCapturesAuthoritativeTombstone(t *testing.T) {
	current := sourceTask(model.TaskTodo)
	db, record, ctx, calls := newSourceWrite(t, current, model.Task{})
	tombstone := model.TaskTombstone{ID: sourceTaskID, ProjectID: sourceProjectID, Version: 8, DeletedAt: current.UpdatedAt.Add(2 * time.Second)}
	db.scope.tasks.tombstone, db.scope.projects.invalidate = &tombstone, true
	if err := NewTasks(db, record).Delete(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.DeleteTask{Version: 7, RemoveDepends: true}); err != nil {
		t.Fatal(err)
	}
	if len(record.facts) != 1 || !reflect.DeepEqual(*calls, []string{"delete", "drain", "receipts", "invalidate", "capture"}) {
		t.Fatalf("deletion source order: %#v %v", record.facts, *calls)
	}
	f := record.facts[0]
	if f.Type != protocol.Deleted || f.ProjectID != tombstone.ProjectID || f.TaskID != tombstone.ID || f.TaskVersion != tombstone.Version || f.DeletedAt == nil || !f.DeletedAt.Equal(tombstone.DeletedAt) || !f.OccurredAt.Equal(tombstone.DeletedAt) {
		t.Fatalf("deletion did not capture authoritative tombstone: %#v", f)
	}
}

func sourcePointer[T any](v T) *T { return &v }

func TestStepSourcesUseMutationActionAndFinalRevision(t *testing.T) {
	for _, mode := range []string{"created", "updated", "in_progress", "done", "skipped", "todo", "moved", "deleted", "same title", "same status", "same position", "duplicate", "missing"} {
		t.Run(mode, func(t *testing.T) {
			current := sourceTask(model.TaskTodo)
			db, record, ctx, calls := newSourceWrite(t, current, model.Task{})
			dao := db.scope.tasks
			dao.allowClock = true
			dao.headers = []model.TaskHeader{{ProjectID: sourceProjectID, ID: sourceTaskID, Version: 7}, {ProjectID: sourceProjectID, ID: sourceTaskID, Version: 8}}
			dao.steps = []model.TaskStep{{ID: "abcdef01", Position: 0, Title: "First", Status: model.TaskStepTodo, CreatedAt: current.CreatedAt, UpdatedAt: current.UpdatedAt}, {ID: "12345678", Position: 1, Title: "Second", Status: model.TaskStepTodo, CreatedAt: current.CreatedAt, UpdatedAt: current.UpdatedAt}}
			dao.stepAction = mode
			s := NewTaskSteps(db, record)
			var result StepsWriteResult
			var err error
			wantAction, wantStep := mode, "abcdef01"
			switch mode {
			case "created", "duplicate":
				id := "87654321"
				if mode == "duplicate" {
					id = "abcdef01"
				}
				result, err = s.Add(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, AddTaskStep{Version: 7, ID: id, Title: "Added"})
				wantStep = id
			case "updated", "same title":
				title := "Changed"
				if mode == "same title" {
					title = "First"
				}
				result, err = s.Update(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, "abcdef01", UpdateTaskStep{Version: 7, Title: &title})
			case "moved", "same position":
				position := "first"
				id := "12345678"
				if mode == "same position" {
					id = "abcdef01"
				}
				result, err = s.Move(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, id, MoveTaskStep{Version: 7, Position: &position})
				wantStep = id
			case "deleted", "missing":
				id := "abcdef01"
				if mode == "missing" {
					id = "ffffffff"
				}
				result, err = s.Delete(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, id, DeleteTaskStep{Version: 7})
			default:
				status := model.TaskStepStatus(mode)
				if mode == "same status" {
					status = model.TaskStepTodo
				} else {
					dao.steps[0].Status = model.TaskStepSkipped
					if status == model.TaskStepSkipped {
						dao.steps[0].Status = model.TaskStepDone
					}
				}
				dao.stepAction, wantAction = "status_changed", "status_changed"
				result, err = s.SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, "abcdef01", SetTaskStepStatus{Version: 7, Status: status})
			}
			if mode == "duplicate" || mode == "missing" {
				want := "not_found"
				if mode == "duplicate" {
					want = "step_id_conflict"
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != want || len(record.calls) != 0 || len(*calls) != 0 {
					t.Fatalf("refused Step source captured or wrote: %#v %v", record.facts, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "same title" || mode == "same status" || mode == "same position" {
				if result.Changed || result.Resource.Version != 7 || len(record.calls) != 0 || len(*calls) != 0 || dao.headerCalls != 1 || dao.clockCalls != 0 {
					t.Fatalf("no-op Step source captured: %#v %v", record.facts, *calls)
				}
				return
			}
			if len(record.facts) != 1 || !reflect.DeepEqual(*calls, []string{"step", "touch", "capture"}) || dao.headerCalls != 2 || dao.clockCalls != 1 {
				t.Fatalf("Step source calls: %#v %v", record.facts, *calls)
			}
			f := record.facts[0]
			if f.Type != protocol.StepUpdated || f.Action != wantAction || f.StepID != wantStep || f.TaskVersion != 8 || f.ProjectID != sourceProjectID || f.TaskID != sourceTaskID || !f.OccurredAt.Equal(dao.clock) {
				t.Fatalf("Step source fact: %#v", f)
			}
			if mode == "moved" && (f.FromPosition == nil || *f.FromPosition != 1 || f.ToPosition == nil || *f.ToPosition != 0) {
				t.Fatalf("Step move source positions: %#v", f)
			}
			if mode == "updated" && !reflect.DeepEqual(f.ChangedFields, []string{"title"}) {
				t.Fatalf("Step update source fields: %#v", f)
			}
			if mode == "created" && (len(dao.stepWrites) != 1 || dao.stepWrites[0].Title != "Added") {
				t.Fatalf("Step creation write: %#v", dao.stepWrites)
			}
			if mode == "updated" && (len(dao.stepWrites) != 1 || dao.stepWrites[0].Title != "Changed") {
				t.Fatalf("Step update write: %#v", dao.stepWrites)
			}
			if wantAction == "status_changed" && (f.PreviousStatus != string(dao.steps[0].Status) || f.Status != mode) {
				t.Fatalf("Step status source: %#v", f)
			}
			if wantAction == "status_changed" && (len(dao.stepWrites) != 1 || string(dao.stepWrites[0].Status) != mode) {
				t.Fatalf("Step status write: %#v", dao.stepWrites)
			}
		})
	}
}

func TestSourceCaptureFailurePropagatesFromTaskAndStepWrites(t *testing.T) {
	for _, mode := range []string{"task", "step"} {
		t.Run(mode, func(t *testing.T) {
			current := sourceTask(model.TaskTodo)
			updated := current
			updated.Status, updated.Version, updated.UpdatedAt = model.TaskInProgress, 8, current.UpdatedAt.Add(time.Second)
			db, record, ctx, _ := newSourceWrite(t, current, updated)
			cause := errors.New("capture refused prepared responsibility")
			record.cause = cause
			var err error
			if mode == "task" {
				_, err = NewTasks(db, record).SetStatus(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, taskcore.SetTaskStatus{Version: 7, Status: model.TaskInProgress})
			} else {
				db.scope.tasks.allowClock = true
				db.scope.tasks.stepAction = "created"
				db.scope.tasks.headers = []model.TaskHeader{{ProjectID: sourceProjectID, ID: sourceTaskID, Version: 7}, {ProjectID: sourceProjectID, ID: sourceTaskID, Version: 8}}
				db.scope.tasks.steps = []model.TaskStep{}
				_, err = NewTaskSteps(db, record).Add(ctx, sourcePrincipal(), sourceProjectID, sourceTaskID, AddTaskStep{Version: 7, ID: "87654321", Title: "Source"})
			}
			if !errors.Is(err, cause) || len(record.facts) != 1 {
				t.Fatalf("source capture failure lost: %#v %v", record.facts, err)
			}
		})
	}
}
