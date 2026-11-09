package task

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type observationBatchStore struct {
	store.SnapshotReader
	snapshot store.SnapshotScope
}

func (s observationBatchStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	return run(s.snapshot)
}

type observationBatchScope struct {
	store.SnapshotScope
	sessions store.SessionReader
}

func (s observationBatchScope) SessionDAO() store.SessionReader       { return s.sessions }
func (s observationBatchScope) CredentialDAO() store.CredentialReader { return nil }
func (s observationBatchScope) ProjectDAO() store.ProjectReader       { return nil }

type observationBatchReader struct {
	store.SessionReader
	t      *testing.T
	calls  int
	fail   error
	change bool
}

func (r *observationBatchReader) TaskSessionSources(_ context.Context, project string, ids []string) ([]store.TaskSessionSource, error) {
	r.calls++
	if len(ids) > 200 {
		r.t.Fatalf("unbounded batch: %d", len(ids))
	}
	if r.fail != nil {
		return nil, r.fail
	}
	out := make([]store.TaskSessionSource, len(ids))
	for i, id := range ids {
		version := int64(1)
		if r.change && i == 0 {
			version = 2
		}
		out[i] = store.TaskSessionSource{ProjectID: project, TaskID: id, TaskVersion: version, TaskStatus: model.TaskInProgress}
	}
	return out, nil
}

type observationBatchEngine struct {
	after func()
	calls int
	fail  error
}

func (e *observationBatchEngine) ObserveTaskSessions(_ context.Context, _ model.Principal, sources []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error) {
	e.calls++
	if e.after != nil {
		e.after()
	}
	if e.fail != nil {
		return nil, e.fail
	}
	result := map[string]sp.TaskSessionObservation{}
	for _, source := range sources {
		result[source.TaskID] = sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "not_registered", Reason: "not_registered"}
	}
	return result, nil
}
func TestTaskObservationBatchBoundAndExecutionChange(t *testing.T) {
	reader := &observationBatchReader{t: t, change: true}
	engine := &observationBatchEngine{}
	service := NewObservations(observationBatchStore{snapshot: observationBatchScope{sessions: reader}}, engine)
	service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
	service.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, nil
	}
	tasks := make([]model.Task, 401)
	for i := range tasks {
		tasks[i] = model.Task{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), Version: 1}
	}
	got, partial, err := service.observeBatch(t.Context(), observationBatchScope{sessions: reader}, model.Principal{}, "project", tasks, time.Now())
	if err != nil || !partial || reader.calls != 6 || engine.calls != 3 || len(got) != 401 || got[tasks[0].ID].Reason != "execution_changed" || got[tasks[1].ID].Observation != "observed" {
		t.Fatalf("batch: calls=%d/%d partial=%v err=%v first=%#v", reader.calls, engine.calls, partial, err, got[tasks[0].ID])
	}
}
func TestTaskObservationFailurePreservesRowsButRejectsAuthorityFailure(t *testing.T) {
	tasks := []model.Task{{ID: "task", Version: 1}}
	engine := &observationBatchEngine{}
	service := NewObservations(observationBatchStore{}, engine)
	for _, failure := range []error{errors.New("private database detail"), &model.Fault{Code: "unauthorized", Message: "expired"}} {
		reader := &observationBatchReader{t: t, fail: failure}
		result, partial, err := service.observeBatch(t.Context(), observationBatchScope{sessions: reader}, model.Principal{}, "project", tasks, time.Now())
		var fault *model.Fault
		if errors.As(failure, &fault) {
			if err == nil || result != nil {
				t.Fatalf("authority failure hidden: %#v %v", result, err)
			}
		} else if err != nil || !partial || result["task"].Observation != "unavailable" || result["task"].Error.Message == failure.Error() {
			t.Fatalf("partial unavailable: %#v %v", result, err)
		}
	}
}

func TestTaskObservationRejectsTaskChangeDuringLiveSampling(t *testing.T) {
	initial := &observationBatchReader{t: t}
	latest := &observationBatchReader{t: t}
	engine := &observationBatchEngine{after: func() { latest.change = true }}
	service := NewObservations(observationBatchStore{snapshot: observationBatchScope{sessions: latest}}, engine)
	service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
	service.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, nil
	}
	result, partial, err := service.observeBatch(t.Context(), observationBatchScope{sessions: initial}, model.Principal{}, "project", []model.Task{{ID: "task", Version: 1}}, time.Now())
	if err != nil || !partial || result["task"].Reason != "execution_changed" || latest.calls != 1 {
		t.Fatalf("mixed selected Task and changed execution: %#v partial=%v err=%v checks=%d", result, partial, err, latest.calls)
	}
}

func TestTaskObservationFreshAuthorityFailurePreventsPublication(t *testing.T) {
	for _, failure := range []error{&model.Fault{Code: "unauthenticated", Message: "revoked"}, &model.Fault{Code: "forbidden", Message: "project membership revoked"}} {
		t.Run(failure.Error(), func(t *testing.T) {
			initial := &observationBatchReader{t: t}
			latest := &observationBatchReader{t: t}
			engine := &observationBatchEngine{}
			service := NewObservations(observationBatchStore{snapshot: observationBatchScope{sessions: latest}}, engine)
			service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return failure }
			result, _, err := service.observeBatch(t.Context(), observationBatchScope{sessions: initial}, model.Principal{}, "project", []model.Task{{ID: "task", Version: 1}}, time.Now())
			if !errors.Is(err, failure) || result != nil || latest.calls != 0 || engine.calls != 1 {
				t.Fatalf("published after authorization failure: %#v %v queries=%d", result, err, latest.calls)
			}
		})
	}
}

func TestTaskObservationBindingRecheckRejectsClaimAndSessionChanges(t *testing.T) {
	selected := store.TaskSessionSource{ProjectID: workProject, TaskID: workGroup, TaskVersion: 1, TaskStatus: model.TaskInProgress,
		Worker:  &model.WorkerClaim{ClaimID: workProject, UserID: workActor, State: model.WorkerActive},
		Session: &store.TaskSessionStateSource{SessionID: workGroup, Lifecycle: "active"}}
	changes := []func(*store.TaskSessionSource){
		func(v *store.TaskSessionSource) { v.TaskVersion++ },
		func(v *store.TaskSessionSource) { v.TaskStatus = model.TaskDone },
		func(v *store.TaskSessionSource) { worker := *v.Worker; worker.ClaimID = workGroup; v.Worker = &worker },
		func(v *store.TaskSessionSource) { worker := *v.Worker; worker.UserID = workProject; v.Worker = &worker },
		func(v *store.TaskSessionSource) { v.Worker = nil },
		func(v *store.TaskSessionSource) {
			session := *v.Session
			session.SessionID = workProject
			v.Session = &session
		},
		func(v *store.TaskSessionSource) {
			session := *v.Session
			session.Lifecycle = "archived"
			v.Session = &session
		},
		func(v *store.TaskSessionSource) { v.Session = nil },
	}
	if !sameObservedBinding(selected, selected) {
		t.Fatal("unchanged binding rejected")
	}
	for i, change := range changes {
		current := selected
		change(&current)
		if sameObservedBinding(selected, current) {
			t.Fatalf("accepted changed binding %d", i)
		}
	}
}
