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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const syncProjectID = "33333333-3333-4333-8333-333333333333"
const syncEpoch = "44444444-4444-4444-8444-444444444444"

var syncPrincipal = model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}

type syncFixture struct {
	t *testing.T
	store.SnapshotScope
	store.ProjectReader
	store.TaskReader
	store.SessionReader
	store.CredentialReader
	ctx             context.Context
	active          bool
	snapshot        int
	calls           []string
	tasks           []store.TaskSyncTaskIdentity
	selected        map[string]store.TaskSessionSource
	current         map[string]store.TaskSessionSource
	failureStage    string
	failure         error
	cancel          context.CancelFunc
	failSample      bool
	zeroDBClock     bool
	zeroEngineClock bool
}

func newSyncFixture(t *testing.T, count int) *syncFixture {
	f := &syncFixture{t: t, ctx: t.Context(), selected: map[string]store.TaskSessionSource{}, current: map[string]store.TaskSessionSource{}}
	for i := 0; i < count; i++ {
		id := fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1)
		worker := &model.WorkerClaim{ClaimID: fmt.Sprintf("10000000-0000-4000-8000-%012x", i+1), State: model.WorkerActive, UserID: syncPrincipal.UserID}
		source := store.TaskSessionSource{ProjectID: syncProjectID, TaskID: id, TaskVersion: int64(9007199254740993 + i), TaskStatus: model.TaskInProgress, Worker: worker}
		f.tasks = append(f.tasks, store.TaskSyncTaskIdentity{ID: id, Version: source.TaskVersion})
		f.selected[id], f.current[id] = source, source
	}
	return f
}

func (f *syncFixture) phase(name string) error {
	f.calls = append(f.calls, name)
	if name == f.failureStage {
		return f.failure
	}
	return nil
}
func (f *syncFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	if ctx != f.ctx || f.active {
		f.t.Fatal("snapshot context or lifetime changed")
	}
	f.snapshot++
	if f.snapshot > 2 {
		f.t.Fatal("unexpected snapshot")
	}
	f.active = true
	if err := f.phase(fmt.Sprintf("begin%d", f.snapshot)); err != nil {
		f.active = false
		return err
	}
	err := fn(f)
	f.active = false
	if err != nil {
		return err
	}
	return f.phase(fmt.Sprintf("end%d", f.snapshot))
}
func (f *syncFixture) ProjectDAO() store.ProjectReader       { return f }
func (f *syncFixture) TaskDAO() store.TaskReader             { return f }
func (f *syncFixture) SessionDAO() store.SessionReader       { return f }
func (f *syncFixture) CredentialDAO() store.CredentialReader { return f }
func (f *syncFixture) ProjectAccess(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	if !f.active || ctx != f.ctx || p != syncPrincipal || project != syncProjectID {
		f.t.Fatal("project authorization identity changed")
	}
	return model.ProjectAccess{Role: model.ProjectMemberRole}, f.phase(fmt.Sprintf("access%d", f.snapshot))
}
func (f *syncFixture) Project(ctx context.Context, project string) (model.Project, error) {
	if !f.active || ctx != f.ctx || project != syncProjectID {
		f.t.Fatal("project identity changed")
	}
	return model.Project{ID: project}, f.phase("project")
}
func (f *syncFixture) Credential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	if !f.active || f.snapshot != 2 || ctx != f.ctx || p != syncPrincipal {
		f.t.Fatal("credential identity changed")
	}
	return store.ThreadCredential{}, f.phase("credential")
}
func (f *syncFixture) TaskCacheEpoch(context.Context, string) (string, error) {
	return syncEpoch, f.phase("epoch")
}
func (f *syncFixture) TaskSyncTasks(_ context.Context, _ string, lower *time.Time, _ int) ([]model.TaskViewRecord, error) {
	if lower == nil {
		f.t.Fatal("delta window missing")
	}
	return []model.TaskViewRecord{}, f.phase("tasks")
}
func (f *syncFixture) TaskSyncDependencyStates(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error) {
	return map[string]model.TaskDependencyState{}, f.phase("dependencies")
}
func (f *syncFixture) TaskAssignees(context.Context, string) ([]model.TaskAssigneeFact, error) {
	return []model.TaskAssigneeFact{}, f.phase("people")
}
func (f *syncFixture) TaskSyncActiveTasks(ctx context.Context, project string) ([]store.TaskSyncTaskIdentity, error) {
	if !f.active || f.snapshot != 1 || ctx != f.ctx || project != syncProjectID {
		f.t.Fatal("inventory snapshot changed")
	}
	return f.tasks, f.phase("inventory")
}
func (f *syncFixture) TaskSessionSources(ctx context.Context, project string, ids []string) ([]store.TaskSessionSource, error) {
	if !f.active || ctx != f.ctx || project != syncProjectID || len(ids) == 0 || len(ids) > 200 {
		f.t.Fatal("source snapshot or batch changed")
	}
	if err := f.phase(fmt.Sprintf("sources%d:%d", f.snapshot, len(ids))); err != nil {
		return nil, err
	}
	from := f.selected
	if f.snapshot == 2 {
		from = f.current
	}
	out := make([]store.TaskSessionSource, 0, len(ids))
	for _, id := range ids {
		if source, ok := from[id]; ok {
			out = append(out, source)
		}
	}
	return out, nil
}
func (f *syncFixture) ObservedAt(ctx context.Context) (time.Time, error) {
	if !f.active || ctx != f.ctx {
		f.t.Fatal("database clock outside snapshot")
	}
	err := f.phase(fmt.Sprintf("dbclock%d", f.snapshot))
	if f.snapshot == 2 && f.zeroDBClock {
		return time.Time{}, err
	}
	return time.Unix(int64(100+f.snapshot), 0).UTC(), err
}
func (f *syncFixture) TaskSyncSessions(ctx context.Context, p model.Principal, sources []store.TaskSessionSource) (map[string]model.TaskSyncObservation, map[string]model.SessionListState, error) {
	if f.active || f.snapshot != 1 || ctx != f.ctx || p != syncPrincipal || len(sources) > 200 {
		f.t.Fatal("sampling held snapshot or changed identity")
	}
	if err := f.phase(fmt.Sprintf("sample:%d", len(sources))); err != nil {
		return nil, nil, err
	}
	if f.cancel != nil {
		f.cancel()
	}
	if f.failSample {
		return nil, nil, errors.New("sample failed")
	}
	observations := map[string]model.TaskSyncObservation{}
	legacy := map[string]model.SessionListState{}
	at := time.Unix(1000, 0).UTC()
	if len(sources) == 1 {
		at = at.Add(25 * time.Second)
	}
	for _, source := range sources {
		observations[source.TaskID] = model.TaskSyncObservation{TaskVersion: source.TaskVersion, State: "working", ObservedAt: &at}
		legacy[source.TaskID] = model.SessionListWorking
	}
	return observations, legacy, nil
}
func (f *syncFixture) TaskSyncObservedAt(ctx context.Context) (time.Time, error) {
	if f.active || f.snapshot != 2 || ctx != f.ctx {
		f.t.Fatal("session clock sampled before recheck")
	}
	err := f.phase("sessionclock")
	if f.zeroEngineClock {
		return time.Time{}, err
	}
	return time.Unix(1100, 0).UTC(), err
}
func (f *syncFixture) get() (model.TaskSync, error) {
	since := time.Unix(20, 0).UTC()
	return NewTaskSync(f, f, time.Second).Get(f.ctx, syncPrincipal, syncProjectID, TaskSyncRequest{Epoch: syncEpoch, Since: &since})
}

func TestTaskSyncBatchRecheckAndSeparateClocks(t *testing.T) {
	f := newSyncFixture(t, 201)
	result, err := f.get()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"begin1", "access1", "project", "epoch", "tasks", "dependencies", "people", "dbclock1", "inventory", "sources1:200", "sources1:1", "end1", "sample:200", "sample:1", "begin2", "credential", "access2", "sources2:200", "sources2:1", "dbclock2", "end2", "sessionclock"}
	if !slices.Equal(f.calls, want) {
		t.Fatalf("phase order: %v", f.calls)
	}
	if result.Mode != "delta" || len(result.Tasks) != 0 || len(result.TaskObservations) != 201 || len(result.Sessions) != 201 || result.SessionPartial {
		t.Fatalf("delta inventory: %#v", result)
	}
	if !result.ObservedAt.Equal(time.Unix(101, 0)) || !result.ResponseTaskAt.Equal(time.Unix(102, 0)) || !result.ResponseSessionAt.Equal(time.Unix(1100, 0)) {
		t.Fatalf("clock domains: %#v", result)
	}
	first, last := result.TaskObservations[f.tasks[0].ID], result.TaskObservations[f.tasks[200].ID]
	if first.TaskVersion != 9007199254740993 || first.ObservedAt == nil || last.ObservedAt == nil || last.ObservedAt.Sub(*first.ObservedAt) != 25*time.Second || result.ResponseSessionAt.Sub(*first.ObservedAt) <= 30*time.Second {
		t.Fatalf("batch ages or precision: %#v %#v", first, last)
	}
}

func TestTaskSyncInvalidatesChangedBinding(t *testing.T) {
	for _, change := range []string{"claim", "version", "status", "session", "missing"} {
		t.Run(change, func(t *testing.T) {
			f := newSyncFixture(t, 2)
			id := f.tasks[0].ID
			s := f.current[id]
			switch change {
			case "claim":
				worker := *s.Worker
				worker.ClaimID = "55555555-5555-4555-8555-555555555555"
				s.Worker = &worker
				f.current[id] = s
			case "version":
				s.TaskVersion++
				f.current[id] = s
			case "status":
				s.TaskStatus = model.TaskDone
				f.current[id] = s
			case "session":
				original := s
				original.Session = &store.TaskSessionStateSource{SessionID: "55555555-5555-4555-8555-555555555555"}
				f.selected[id] = original
				s.Session = &store.TaskSessionStateSource{SessionID: "66666666-6666-4666-8666-666666666666"}
				f.current[id] = s
			case "missing":
				delete(f.current, id)
			}
			result, err := f.get()
			if err != nil {
				t.Fatal(err)
			}
			if result.TaskObservations[id].State != "unavailable" || result.TaskObservations[id].CanOpen || !result.SessionPartial {
				t.Fatalf("changed binding retained: %#v", result.TaskObservations[id])
			}
			if _, ok := result.Sessions[id]; ok {
				t.Fatal("old legacy sample retained")
			}
			if result.TaskObservations[f.tasks[1].ID].State != "working" {
				t.Fatal("unaffected sample lost")
			}
		})
	}
}

func TestTaskSyncFailuresAndCancellation(t *testing.T) {
	cause := errors.New("storage failure")
	for _, phase := range []string{"begin1", "access1", "project", "epoch", "tasks", "dependencies", "people", "dbclock1", "inventory", "sources1:2", "end1", "begin2", "credential", "access2", "sources2:2", "dbclock2", "end2", "sessionclock"} {
		t.Run(phase, func(t *testing.T) {
			f := newSyncFixture(t, 2)
			f.failureStage, f.failure = phase, cause
			result, err := f.get()
			if !errors.Is(err, cause) || !reflect.DeepEqual(result, model.TaskSync{}) {
				t.Fatalf("failure lost: %#v %v", result, err)
			}
		})
	}
	t.Run("sample failure is partial", func(t *testing.T) {
		f := newSyncFixture(t, 2)
		f.failSample = true
		result, err := f.get()
		if err != nil || !result.SessionPartial || len(result.TaskObservations) != 2 || len(result.Sessions) != 0 {
			t.Fatalf("sample failure: %#v %v", result, err)
		}
		for _, value := range result.TaskObservations {
			if value.State != "unavailable" || value.CanOpen {
				t.Fatalf("bad unavailable: %#v", value)
			}
		}
	})
	for _, stage := range []string{"credential", "access2", "sample:2"} {
		t.Run("authority "+stage, func(t *testing.T) {
			f := newSyncFixture(t, 2)
			f.failureStage = stage
			f.failure = &model.Fault{Code: "unauthenticated", Message: "revoked"}
			result, err := f.get()
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" || !reflect.DeepEqual(result, model.TaskSync{}) {
				t.Fatalf("authority failure: %#v %v", result, err)
			}
		})
	}
	for _, clock := range []string{"database", "engine"} {
		t.Run("invalid "+clock+" clock", func(t *testing.T) {
			f := newSyncFixture(t, 2)
			f.zeroDBClock = clock == "database"
			f.zeroEngineClock = clock == "engine"
			result, err := f.get()
			if err == nil || !reflect.DeepEqual(result, model.TaskSync{}) {
				t.Fatalf("invalid clock published response: %#v %v", result, err)
			}
		})
	}
	t.Run("cancel sample", func(t *testing.T) {
		f := newSyncFixture(t, 201)
		f.ctx, f.cancel = context.WithCancel(t.Context())
		defer f.cancel()
		result, err := f.get()
		if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(result, model.TaskSync{}) || f.snapshot != 1 || slices.Contains(f.calls, "sample:1") {
			t.Fatalf("cancellation: %#v %v %v", result, err, f.calls)
		}
	})
}

func TestSyncBindingEqualRejectsExecutionChanges(t *testing.T) {
	finalization := "finalization"
	original := store.TaskSessionSource{
		ProjectID: syncProjectID, TaskID: "task", TaskVersion: 7, TaskStatus: model.TaskInProgress,
		Worker:  &model.WorkerClaim{ClaimID: "claim", State: model.WorkerActive, UserID: "owner", WorkerID: "worker", WorktreeID: "worktree", AgentControlMode: model.AgentControlModeWeb, Agent: model.AgentCodex},
		Session: &store.TaskSessionStateSource{SessionID: "session", Backend: "web", OwnerID: "owner", ServerInstance: "server", ArchiveState: "ready", TerminalFinalizationID: &finalization, Lifecycle: "active"},
	}
	tests := []struct {
		name   string
		change func(*store.TaskSessionSource)
	}{
		{"project", func(s *store.TaskSessionSource) { s.ProjectID = "other" }},
		{"task", func(s *store.TaskSessionSource) { s.TaskID = "other" }},
		{"version", func(s *store.TaskSessionSource) { s.TaskVersion++ }},
		{"status", func(s *store.TaskSessionSource) { s.TaskStatus = model.TaskDone }},
		{"missing worker", func(s *store.TaskSessionSource) { s.Worker = nil }},
		{"claim", func(s *store.TaskSessionSource) { s.Worker.ClaimID = "other" }},
		{"worker state", func(s *store.TaskSessionSource) { s.Worker.State = model.WorkerCompleted }},
		{"worker user", func(s *store.TaskSessionSource) { s.Worker.UserID = "other" }},
		{"worker id", func(s *store.TaskSessionSource) { s.Worker.WorkerID = "other" }},
		{"worktree", func(s *store.TaskSessionSource) { s.Worker.WorktreeID = "other" }},
		{"mode", func(s *store.TaskSessionSource) { s.Worker.AgentControlMode = model.AgentControlModeHerdr }},
		{"agent", func(s *store.TaskSessionSource) { s.Worker.Agent = model.AgentClaude }},
		{"missing session", func(s *store.TaskSessionSource) { s.Session = nil }},
		{"session id", func(s *store.TaskSessionSource) { s.Session.SessionID = "other" }},
		{"fence", func(s *store.TaskSessionSource) { s.Session.Fence.ConnectionEpoch = "2" }},
		{"lifecycle", func(s *store.TaskSessionSource) { s.Session.Lifecycle = "archived" }},
		{"backend", func(s *store.TaskSessionSource) { s.Session.Backend = "herdr" }},
		{"owner", func(s *store.TaskSessionSource) { s.Session.OwnerID = "other" }},
		{"instance", func(s *store.TaskSessionSource) { s.Session.ServerInstance = "other" }},
		{"archive", func(s *store.TaskSessionSource) { s.Session.ArchiveState = "pending" }},
		{"finalization", func(s *store.TaskSessionSource) { s.Session.TerminalFinalizationID = nil }},
		{"identity", func(s *store.TaskSessionSource) { s.Session.Identity.WorkerID = "other" }},
	}
	if !syncBindingEqual(original, original) {
		t.Fatal("identical binding rejected")
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			changed := original
			worker, session := *original.Worker, *original.Session
			changed.Worker, changed.Session = &worker, &session
			tc.change(&changed)
			if syncBindingEqual(original, changed) {
				t.Fatal("changed binding accepted")
			}
		})
	}
	withoutWorker := original
	withoutWorker.Worker, withoutWorker.Session = nil, nil
	if !syncBindingEqual(withoutWorker, withoutWorker) {
		t.Fatal("matching unassigned binding rejected")
	}
}

func TestValidateSyncObservation(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	fresh := now.Add(30 * time.Second)
	zero := time.Time{}
	outOfRange := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	valid := model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &now, FreshUntil: &fresh, CanOpen: true}
	for _, state := range []string{"no_session", "not_registered", "pending", "working", "notice", "warning", "unavailable"} {
		t.Run("valid "+state, func(t *testing.T) {
			v := valid
			v.State = state
			v.CanOpen = false
			if err := validateSyncObservation(v, 7); err != nil {
				t.Fatal(err)
			}
		})
	}
	tests := []struct {
		name        string
		observation model.TaskSyncObservation
		version     int64
		valid       bool
	}{
		{"no anchor unavailable", model.TaskSyncObservation{TaskVersion: 7, State: "unavailable"}, 7, true},
		{"unknown freshness", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &now}, 7, true},
		{"zero task version", valid, 0, false},
		{"mismatched version", valid, 8, false},
		{"invalid state", model.TaskSyncObservation{TaskVersion: 7, State: "unknown", ObservedAt: &now}, 7, false},
		{"missing observed", model.TaskSyncObservation{TaskVersion: 7, State: "working"}, 7, false},
		{"zero observed", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &zero}, 7, false},
		{"out of range observed", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &outOfRange}, 7, false},
		{"zero freshness", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &now, FreshUntil: &zero}, 7, false},
		{"out of range freshness", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &now, FreshUntil: &outOfRange}, 7, false},
		{"open without observed", model.TaskSyncObservation{TaskVersion: 7, State: "unavailable", FreshUntil: &fresh, CanOpen: true}, 7, false},
		{"open without freshness", model.TaskSyncObservation{TaskVersion: 7, State: "working", ObservedAt: &now, CanOpen: true}, 7, false},
		{"open unavailable with anchors", model.TaskSyncObservation{TaskVersion: 7, State: "unavailable", ObservedAt: &now, FreshUntil: &fresh, CanOpen: true}, 7, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateSyncObservation(tc.observation, tc.version)
			if (err == nil) != tc.valid {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}
