package task

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const workProject = "10000000-0000-4000-8000-000000000001"
const workActor = "10000000-0000-4000-8000-000000000002"
const workGroup = "10000000-0000-4000-8000-000000000003"

var workTime = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

type workServiceReader struct {
	store.TaskReader
	bodies  func(context.Context, string, []string) ([]model.Task, error)
	fence   store.TaskListFence
	groups  func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error)
	targets func(context.Context, string, []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error)
}

func (r *workServiceReader) TaskBodies(ctx context.Context, project string, ids []string) ([]model.Task, error) {
	if r.bodies == nil {
		panic("unexpected TaskBodies")
	}
	return r.bodies(ctx, project, ids)
}
func (r *workServiceReader) TaskCacheEpoch(context.Context, string) (string, error) {
	return workProject, nil
}
func (r *workServiceReader) TaskListFence(context.Context, string) (store.TaskListFence, error) {
	return r.fence, nil
}
func (r *workServiceReader) TaskWorkGroups(ctx context.Context, p string, q store.TaskWorkQuery) (store.TaskWorkGroups, error) {
	return r.groups(ctx, p, q)
}
func (r *workServiceReader) TaskWorkTargets(ctx context.Context, p string, keys []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
	return r.targets(ctx, p, keys)
}

type workServiceSnapshot struct {
	store.SnapshotScope
	tasks      store.TaskReader
	sessions   store.SessionReader
	project    store.ProjectReader
	observedAt time.Time
	clockErr   error
}

func (s workServiceSnapshot) TaskDAO() store.TaskReader             { return s.tasks }
func (s workServiceSnapshot) SessionDAO() store.SessionReader       { return s.sessions }
func (s workServiceSnapshot) ProjectDAO() store.ProjectReader       { return s.project }
func (s workServiceSnapshot) CredentialDAO() store.CredentialReader { return nil }
func (s workServiceSnapshot) ObservedAt(context.Context) (time.Time, error) {
	if !s.observedAt.IsZero() {
		return s.observedAt, s.clockErr
	}
	return workTime, s.clockErr
}

type workServiceStore struct {
	snapshot   store.SnapshotScope
	completion error
	active     bool
}

func (s *workServiceStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	if s.active {
		return errors.New("nested snapshot acquisition")
	}
	s.active = true
	defer func() { s.active = false }()
	if err := run(s.snapshot); err != nil {
		return err
	}
	return s.completion
}

type workServiceObserver struct {
	after     func()
	indicator string
	calls     int
}

func (o *workServiceObserver) ObserveTaskSessions(_ context.Context, _ model.Principal, sources []store.TaskSessionSource) (map[string]sp.TaskSessionObservation, error) {
	o.calls++
	if o.after != nil {
		o.after()
	}
	out := map[string]sp.TaskSessionObservation{}
	for _, source := range sources {
		indicator := o.indicator
		out[source.TaskID] = sp.TaskSessionObservation{SchemaVersion: 1, Observation: "observed", Registration: "registered", Indicator: &indicator, Reason: indicator}
	}
	return out, nil
}
func workServiceFixture(t *testing.T) (*Observations, *workServiceReader, *workServiceObserver, *workServiceStore) {
	t.Helper()
	reader := &workServiceReader{fence: store.TaskListFence{Count: "22", VersionSum: "22"}}
	observer := &workServiceObserver{indicator: "working"}
	database := &workServiceStore{snapshot: workServiceSnapshot{tasks: reader, sessions: &observationBatchReader{t: t}}}
	service := NewObservations(database, observer)
	service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
	service.operations.access = func(_ context.Context, _ projectcore.ProjectAccessReader, p model.Principal, pid string) (model.ProjectAccess, error) {
		if p.UserID != workActor || pid != workProject {
			t.Fatal("wrong authorization identity")
		}
		return model.ProjectAccess{}, nil
	}
	return service, reader, observer, database
}
func TestWorkTargetCursorIgnoresLiveChangesAndResetsForTaskChanges(t *testing.T) {
	service, reader, observer, database := workServiceFixture(t)
	reader.groups = func(_ context.Context, p string, q store.TaskWorkQuery) (store.TaskWorkGroups, error) {
		if p != workProject || q.AssignedTo != workActor {
			t.Fatal("wrong work filter")
		}
		return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, MemberCount: 22, MatchedCount: 21, InProgressCount: 21, RootCount: 1, Roots: []store.TaskWorkRoot{{ID: workGroup}}, StartedAt: workTime}}, Targets: workKeys(workGroup, 21)}, nil
	}
	reader.targets = func(_ context.Context, p string, keys []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
		if p != workProject || len(keys) != 21 || keys[0].GroupID != workGroup || keys[0].TaskID != taskReadScopeID(0) {
			t.Fatal("wrong target batch")
		}
		items := make([]store.TaskWorkTarget, 21)
		for i := range items {
			id := fmt.Sprintf("20000000-0000-4000-8000-%012d", i)
			items[i] = store.TaskWorkTarget{GroupID: workGroup, Task: model.Task{ID: id, ProjectID: workProject, Version: 1, Status: model.TaskInProgress, AssignedTo: ptrWork(workActor)}}
		}
		return store.TaskWorkTargets{Items: items}, nil
	}
	actor := model.Principal{UserID: workActor, CredentialID: workProject, Kind: model.PATCredential}
	first, err := service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{})
	if err != nil || len(first.Groups) != 1 || len(first.Groups[0].Targets) != 20 || first.Groups[0].ContributorCursor == nil || first.Groups[0].Summary.WorkingCount != 21 {
		t.Fatalf("first page %#v %v", first, err)
	}
	if first.ObservedAt != workTime || first.Groups[0].ObservedAt != workTime || first.Groups[0].Summary.ObservedAt != workTime {
		t.Fatalf("first page observation clocks: %#v", first)
	}
	secondTime := workTime.Add(time.Minute)
	snapshot := database.snapshot.(workServiceSnapshot)
	snapshot.observedAt = secondTime
	database.snapshot = snapshot
	observer.indicator = "warning"
	second, err := service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{GroupID: ptrWork(workGroup), TargetsCursor: first.Groups[0].ContributorCursor})
	if err != nil || len(second.Groups[0].Targets) != 1 || second.Groups[0].Targets[0].TaskID <= first.Groups[0].Targets[19].TaskID || second.Groups[0].ContributorCursor != nil || second.Groups[0].Summary.WarningCount != 21 {
		t.Fatalf("second page %#v %v", second, err)
	}
	if second.ObservedAt != secondTime || second.Groups[0].ObservedAt != secondTime || second.Groups[0].Summary.ObservedAt != secondTime || first.ObservedAt != workTime || first.Groups[0].Summary.ObservedAt != workTime {
		t.Fatalf("continuation reused or overwrote observation clocks: first=%#v second=%#v", first, second)
	}
	reader.fence.VersionSum = "23"
	_, err = service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{GroupID: ptrWork(workGroup), TargetsCursor: first.Groups[0].ContributorCursor})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "reset_required" {
		t.Fatalf("changed graph: %v", err)
	}
}
func ptrWork[T any](v T) *T { return &v }

func workKeys(group string, count int) []store.TaskWorkTargetPosition {
	keys := make([]store.TaskWorkTargetPosition, count)
	for i := range keys {
		keys[i] = store.TaskWorkTargetPosition{GroupID: group, TaskID: taskReadScopeID(i)}
	}
	return keys
}
func TestWorkReadRejectsAuthorityAndSnapshotCompletionFailures(t *testing.T) {
	service, reader, _, database := workServiceFixture(t)
	actor := model.Principal{UserID: workActor, CredentialID: workProject, Kind: model.PATCredential}
	denied := &model.Fault{Code: "unauthenticated", Message: "expired"}
	service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return denied }
	if _, err := service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{}); !errors.Is(err, denied) {
		t.Fatalf("credential failure: %v", err)
	}
	service.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
	reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
		return store.TaskWorkGroups{Items: []store.TaskWorkGroup{}}, nil
	}
	database.completion = errors.New("completion failed")
	page, err := service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{})
	if !errors.Is(err, database.completion) || page.Groups != nil {
		t.Fatalf("published failed snapshot: %#v %v", page, err)
	}
	if _, err := service.WorkList(t.Context(), actor, workProject, taskcore.WorkRequest{ResponseOverhead: 256 << 10}); err == nil {
		t.Fatal("accepted oversized envelope")
	}
}

func TestWorkBatchTraversalReleasesSnapshotsAndRejectsChangedGraph(t *testing.T) {
	service, reader, observer, database := workServiceFixture(t)
	reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
		return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, MemberCount: 401, MatchedCount: 401, InProgressCount: 401, StartedAt: workTime}}, Targets: workKeys(workGroup, 401)}, nil
	}
	calls := 0
	reader.targets = func(_ context.Context, _ string, keys []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
		calls++
		if !database.active || len(keys) != min(200, 401-(calls-1)*200) {
			t.Fatal("target read escaped bounded snapshot")
		}
		start := (calls - 1) * 200
		if keys[0].TaskID != taskReadScopeID(start) {
			t.Fatal("incorrect continuation")
		}
		items := make([]store.TaskWorkTarget, min(200, 401-start))
		for i := range items {
			items[i] = store.TaskWorkTarget{GroupID: workGroup, Task: model.Task{ID: fmt.Sprintf("20000000-0000-4000-8000-%012d", start+i), ProjectID: workProject, Version: 1, Status: model.TaskInProgress}}
		}
		return store.TaskWorkTargets{Items: items}, nil
	}
	observer.after = func() {
		if database.active {
			t.Fatal("live sampling retained database snapshot")
		}
	}
	page, err := service.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
	if err != nil || calls != 3 || observer.calls != 3 || page.Groups[0].Summary.WorkingCount != 401 || len(page.Groups[0].Targets) != 20 || page.Groups[0].ContributorCursor == nil {
		t.Fatalf("batch traversal: %#v %v calls=%d/%d", page, err, calls, observer.calls)
	}
	calls = 0
	observer.after = func() { reader.fence.VersionSum = "changed" }
	page, err = service.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "reset_required" || page.Groups != nil || calls != 1 {
		t.Fatalf("published changed graph: %#v %v calls=%d", page, err, calls)
	}
}

func TestWorkTargetsCoverTwoGroupsOnceAcrossBoundedSnapshots(t *testing.T) {
	service, reader, observer, database := workServiceFixture(t)
	secondGroup := "10000000-0000-4000-8000-000000000004"
	keys := append(workKeys(workGroup, 205), workKeys(secondGroup, 205)...)
	for i := 205; i < len(keys); i++ {
		keys[i].TaskID = fmt.Sprintf("30000000-0000-4000-8000-%012d", i-205)
	}
	groupCalls, targetCalls := 0, 0
	reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
		groupCalls++
		return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, InProgressCount: 205, StartedAt: workTime}, {ID: secondGroup, DisplayTaskID: secondGroup, InProgressCount: 205, StartedAt: workTime}}, Targets: keys}, nil
	}
	var seen []store.TaskWorkTargetPosition
	reader.targets = func(_ context.Context, p string, batch []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
		if !database.active || p != workProject || len(batch) > 200 {
			t.Fatal("unbounded or unauthorized target read")
		}
		targetCalls++
		start := len(seen)
		if !slices.Equal(batch, keys[start:min(start+200, len(keys))]) {
			t.Fatalf("unexpected keys: %v", batch)
		}
		seen = append(seen, batch...)
		items := make([]store.TaskWorkTarget, len(batch))
		for i, key := range batch {
			items[i] = store.TaskWorkTarget{GroupID: key.GroupID, Task: model.Task{ID: key.TaskID, ProjectID: workProject, Version: 1, Status: model.TaskInProgress}}
		}
		return store.TaskWorkTargets{Items: items}, nil
	}
	observer.after = func() {
		if database.active {
			t.Fatal("sampling retained snapshot")
		}
	}
	page, err := service.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
	if err != nil || groupCalls != 1 || targetCalls != 3 || observer.calls != 3 || !slices.Equal(seen, keys) || len(page.Groups) != 2 {
		t.Fatalf("two-group traversal: %#v err=%v groups=%d targets=%d observations=%d", page, err, groupCalls, targetCalls, observer.calls)
	}
	for _, group := range page.Groups {
		if group.Summary.WorkingCount != 205 || len(group.Targets) != 20 || group.ContributorCursor == nil {
			t.Fatalf("incomplete group: %#v", group)
		}
	}
}

func TestWorkRejectsIncompleteOrMisidentifiedTargetResults(t *testing.T) {
	for _, scenario := range []string{"missing", "wrong_task", "wrong_group", "wrong_project", "wrong_status", "target_error"} {
		t.Run(scenario, func(t *testing.T) {
			service, reader, observer, _ := workServiceFixture(t)
			reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
				return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, InProgressCount: 1, StartedAt: workTime}}, Targets: workKeys(workGroup, 1)}, nil
			}
			expectedErr := errors.New("target read failed")
			reader.targets = func(context.Context, string, []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
				if scenario == "target_error" {
					return store.TaskWorkTargets{}, expectedErr
				}
				item := store.TaskWorkTarget{GroupID: workGroup, Task: model.Task{ID: taskReadScopeID(0), ProjectID: workProject, Status: model.TaskInProgress}}
				switch scenario {
				case "missing":
					return store.TaskWorkTargets{}, nil
				case "wrong_task":
					item.Task.ID = workActor
				case "wrong_group":
					item.GroupID = workActor
				case "wrong_project":
					item.Task.ProjectID = workActor
				case "wrong_status":
					item.Task.Status = model.TaskDone
				}
				return store.TaskWorkTargets{Items: []store.TaskWorkTarget{item}}, nil
			}

			page, err := service.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
			if err == nil || page.Groups != nil || observer.calls != 0 {
				t.Fatalf("published inconsistent target: %#v %v calls=%d", page, err, observer.calls)
			}
			if scenario == "target_error" && !errors.Is(err, expectedErr) {
				t.Fatalf("lost target error: %v", err)
			}
		})
	}
}

func TestWorkRejectsIncompleteOrUnorderedInitialKeys(t *testing.T) {
	for _, scenario := range []string{"missing", "duplicate", "wrong_group", "reverse"} {
		t.Run(scenario, func(t *testing.T) {
			service, reader, observer, _ := workServiceFixture(t)
			keys := workKeys(workGroup, 2)
			switch scenario {
			case "missing":
				keys = keys[:1]
			case "duplicate":
				keys[1] = keys[0]
			case "wrong_group":
				keys[0].GroupID = workActor
			case "reverse":
				keys[0], keys[1] = keys[1], keys[0]
			}
			reader.groups = func(context.Context, string, store.TaskWorkQuery) (store.TaskWorkGroups, error) {
				return store.TaskWorkGroups{Items: []store.TaskWorkGroup{{ID: workGroup, DisplayTaskID: workGroup, InProgressCount: 2, StartedAt: workTime}}, Targets: keys}, nil
			}
			reader.targets = func(context.Context, string, []store.TaskWorkTargetPosition) (store.TaskWorkTargets, error) {
				t.Fatal("invalid keys reached target query")
				return store.TaskWorkTargets{}, nil
			}
			page, err := service.WorkList(t.Context(), observationActor(), workProject, taskcore.WorkRequest{})
			if err == nil || page.Groups != nil || observer.calls != 0 {
				t.Fatalf("published invalid keys: %#v %v", page, err)
			}
		})
	}
}
