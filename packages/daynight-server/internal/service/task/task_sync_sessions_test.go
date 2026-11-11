package task

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type syncProjectReader struct {
	store.ProjectReader
	access  func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	project func(context.Context, string) (model.Project, error)
}

func (r syncProjectReader) ProjectAccess(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
	return r.access(ctx, principal, id)
}
func (r syncProjectReader) Project(ctx context.Context, id string) (model.Project, error) {
	return r.project(ctx, id)
}

type syncTaskReader struct {
	store.TaskReader
	epoch        func(context.Context, string) (string, error)
	tasks        func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error)
	dependencies func(context.Context, string, *time.Time) (map[string]model.TaskDependencyState, error)
	people       func(context.Context, string) ([]model.TaskAssigneeFact, error)
}

func (r syncTaskReader) TaskCacheEpoch(ctx context.Context, id string) (string, error) {
	return r.epoch(ctx, id)
}
func (r syncTaskReader) TaskSyncTasks(ctx context.Context, id string, since *time.Time, limit int) ([]model.TaskViewRecord, error) {
	return r.tasks(ctx, id, since, limit)
}
func (r syncTaskReader) TaskSyncDependencyStates(ctx context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
	return r.dependencies(ctx, id, lower)
}
func (r syncTaskReader) TaskAssignees(ctx context.Context, id string) ([]model.TaskAssigneeFact, error) {
	return r.people(ctx, id)
}

type syncSessionReader struct {
	read func(context.Context, string) ([]store.TaskSessionSource, error)
}

func (r syncSessionReader) CurrentTaskSessionSources(ctx context.Context, id string) ([]store.TaskSessionSource, error) {
	return r.read(ctx, id)
}

type syncStateReader struct {
	read func(context.Context, []store.TaskSessionSource) (map[string]model.SessionListState, error)
}

func (r syncStateReader) TaskListSessionStates(ctx context.Context, sources []store.TaskSessionSource) (map[string]model.SessionListState, error) {
	return r.read(ctx, sources)
}

type syncSnapshot struct {
	store.SnapshotScope
	project syncProjectReader
	task    syncTaskReader
	session syncSessionReader
	clock   func(context.Context) (time.Time, error)
}

func (s syncSnapshot) ProjectDAO() store.ProjectReader                   { return s.project }
func (s syncSnapshot) TaskDAO() store.TaskReader                         { return s.task }
func (s syncSnapshot) SessionDAO() store.SessionReader                   { return s.session }
func (s syncSnapshot) ObservedAt(ctx context.Context) (time.Time, error) { return s.clock(ctx) }

type syncStore struct {
	read func(context.Context, func(store.SnapshotScope) error) error
}

func (s syncStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	return s.read(ctx, run)
}

func TestTaskSyncSessionReadFollowsTaskReadAndSnapshotCompletion(t *testing.T) {
	projectID := "33333333-3333-4333-8333-333333333333"
	epoch := "44444444-4444-4444-8444-444444444444"
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	cause := errors.New("read failed")
	completion := errors.New("snapshot commit failed")
	full := []string{"access", "project", "epoch", "tasks", "dependencies", "people", "clock", "sessions", "completion"}
	for _, test := range []struct {
		name, stage, code string
		wantErr           error
		want              []string
		stopEngine        bool
		engineFailure     bool
		completionErr     error
	}{
		{name: "success", want: full},
		{name: "permission refusal", stage: "access", code: "not_found", want: []string{"access", "completion"}},
		{name: "permission error", stage: "access", wantErr: cause, want: []string{"access"}},
		{name: "missing project", stage: "project", code: "not_found", want: []string{"access", "project", "completion"}},
		{name: "project error", stage: "project", wantErr: cause, want: []string{"access", "project"}},
		{name: "epoch error", stage: "epoch", wantErr: cause, want: full[:3]},
		{name: "task read error", stage: "tasks", wantErr: cause, want: full[:4]},
		{name: "dependency read error", stage: "dependencies", wantErr: cause, want: full[:5]},
		{name: "people read error", stage: "people", wantErr: cause, want: full[:6]},
		{name: "clock read error", stage: "clock", wantErr: cause, want: full[:7]},
		{name: "session read error", stage: "sessions", wantErr: cause, want: full[:8]},
		{name: "engine read cause", engineFailure: true, wantErr: cause, want: full[:8]},
		{name: "shared engine stopped", stopEngine: true, code: "service_unavailable", want: full[:8]},
		{name: "success commit error", completionErr: completion, wantErr: completion, want: full},
		{name: "refusal commit error", stage: "access", code: "not_found", completionErr: completion, wantErr: completion, want: []string{"access", "completion"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls []string
			phase := func(name string) error {
				calls = append(calls, name)
				if name != test.stage {
					return nil
				}
				if test.code == "not_found" {
					return model.ErrNotFound
				}
				if test.code != "" {
					return &model.Fault{Code: test.code}
				}
				return cause
			}
			snapshot := syncSnapshot{
				project: syncProjectReader{
					access: func(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
						if p != principal || id != projectID {
							t.Fatal("access identity changed")
						}
						return model.ProjectAccess{Role: model.ProjectMemberRole}, phase("access")
					},
					project: func(_ context.Context, id string) (model.Project, error) {
						if id != projectID {
							t.Fatal("project changed")
						}
						return model.Project{ID: id}, phase("project")
					},
				},
				task: syncTaskReader{
					epoch: func(context.Context, string) (string, error) { return epoch, phase("epoch") },
					tasks: func(context.Context, string, *time.Time, int) ([]model.TaskViewRecord, error) {
						return []model.TaskViewRecord{}, phase("tasks")
					},
					dependencies: func(_ context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
						if id != projectID || lower != nil {
							t.Fatal("dependency arguments changed")
						}
						return map[string]model.TaskDependencyState{}, phase("dependencies")
					},
					people: func(context.Context, string) ([]model.TaskAssigneeFact, error) {
						return []model.TaskAssigneeFact{}, phase("people")
					},
				},
				clock: func(context.Context) (time.Time, error) { return time.Unix(1, 0).UTC(), phase("clock") },
				session: syncSessionReader{read: func(_ context.Context, id string) ([]store.TaskSessionSource, error) {
					if id != projectID {
						t.Fatal("session project changed")
					}
					return []store.TaskSessionSource{}, phase("sessions")
				}},
			}
			reader := syncStore{read: func(_ context.Context, run func(store.SnapshotScope) error) error {
				if err := run(snapshot); err != nil {
					return err
				}
				calls = append(calls, "completion")
				return test.completionErr
			}}
			engine := sessioncore.NewEngine(nil)
			if test.stopEngine {
				if err := engine.Stop(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			var stateReader SessionStateReader = engine
			if test.engineFailure {
				stateReader = syncStateReader{read: func(_ context.Context, sources []store.TaskSessionSource) (map[string]model.SessionListState, error) {
					if len(sources) != 0 {
						t.Fatal("source input changed")
					}
					return nil, cause
				}}
			}
			got, err := NewTaskSync(reader, stateReader, time.Second).Get(t.Context(), principal, projectID, TaskSyncRequest{})
			if !slices.Equal(calls, test.want) {
				t.Fatalf("read order: %v, want %v", calls, test.want)
			}
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("cause lost: %v", err)
				}
			} else if test.code != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.code {
					t.Fatalf("fault: %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if err != nil {
				if !reflect.DeepEqual(got, model.TaskSync{}) {
					t.Fatalf("partial sync published: %#v", got)
				}
			} else if got.Sessions == nil || len(got.Sessions) != 0 || got.Tasks == nil {
				t.Fatalf("empty snapshot: %#v", got)
			}
		})
	}
}

func TestTaskSyncReplacesWholeSessionCollectionWhenTaskDeltaIsEmpty(t *testing.T) {
	projectID, taskID, claimID, sessionID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	worker := &model.WorkerClaim{ClaimID: claimID, State: model.WorkerActive, AgentControlMode: model.AgentControlModeWeb, WorkerID: "77777777-7777-4777-8777-777777777777", WorktreeID: "88888888-8888-4888-8888-888888888888"}
	state := &store.TaskSessionStateSource{SessionID: sessionID, ProjectID: projectID, TaskID: taskID, ClaimID: claimID, Fence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, ClaimID: claimID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Identity: sp.Identity{ProjectID: projectID, TaskID: taskID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID, AgentControlMode: "web"}, Lifecycle: "active"}
	sources := []store.TaskSessionSource{{TaskID: taskID, TaskStatus: model.TaskInProgress, Worker: worker, Session: state}}
	reads := 0
	snapshot := syncSnapshot{
		project: syncProjectReader{access: func(context.Context, model.Principal, string) (model.ProjectAccess, error) {
			return model.ProjectAccess{Role: model.ProjectMemberRole}, nil
		}, project: func(context.Context, string) (model.Project, error) { return model.Project{ID: projectID}, nil }},
		task: syncTaskReader{epoch: func(context.Context, string) (string, error) { return projectID, nil }, tasks: func(_ context.Context, _ string, lower *time.Time, _ int) ([]model.TaskViewRecord, error) {
			if lower == nil {
				t.Fatal("delta lost lower boundary")
			}
			return []model.TaskViewRecord{}, nil
		}, dependencies: func(_ context.Context, id string, lower *time.Time) (map[string]model.TaskDependencyState, error) {
			if id != projectID || lower == nil {
				t.Fatal("dependency delta arguments changed")
			}
			return map[string]model.TaskDependencyState{}, nil
		}, people: func(context.Context, string) ([]model.TaskAssigneeFact, error) {
			return []model.TaskAssigneeFact{}, nil
		}},
		clock:   func(context.Context) (time.Time, error) { return time.Unix(1, 0).UTC(), nil },
		session: syncSessionReader{read: func(context.Context, string) ([]store.TaskSessionSource, error) { reads++; return sources, nil }},
	}
	sync := NewTaskSync(syncStore{read: func(_ context.Context, run func(store.SnapshotScope) error) error { return run(snapshot) }}, sessioncore.NewEngine(nil), time.Second)
	since := time.Unix(100, 0).UTC()
	first, err := sync.Get(t.Context(), principal, projectID, TaskSyncRequest{Epoch: projectID, Since: &since})
	if err != nil || first.Mode != "delta" || len(first.Tasks) != 0 || len(first.Sessions) != 1 || string(first.Sessions[taskID]) != "warning" {
		t.Fatalf("first delta: %#v, %v", first, err)
	}
	sources = []store.TaskSessionSource{}
	second, err := sync.Get(t.Context(), principal, projectID, TaskSyncRequest{Epoch: projectID, Since: &since})
	if err != nil || second.Sessions == nil || len(second.Sessions) != 0 || reads != 2 {
		t.Fatalf("whole replacement: %#v, reads %d, %v", second, reads, err)
	}
	if string(first.Sessions[taskID]) != "warning" {
		t.Fatal("later read mutated previous response")
	}
}

func (r syncSessionReader) TaskSessionSources(context.Context, string, []string) ([]store.TaskSessionSource, error) {
	panic("unexpected task observation")
}
func (r syncSessionReader) TaskSessionInspectionSource(context.Context, string, string, string) (store.TaskSessionSource, error) {
	panic("unexpected task inspection")
}
