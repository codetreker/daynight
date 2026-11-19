package task

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

const relationTestProject = "11111111-1111-4111-8111-111111111111"
const relationTestGoal = "22222222-2222-4222-8222-222222222222"
const relationTestOther = "33333333-3333-4333-8333-333333333333"
const relationTestEdge = "44444444-4444-4444-8444-444444444444"

var relationTestActor = model.Principal{UserID: "55555555-5555-4555-8555-555555555555", CredentialID: "66666666-6666-4666-8666-666666666666", Kind: model.PATCredential}

type relationServiceStore struct {
	read  func(context.Context, func(store.SnapshotScope) error) error
	write func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
}

func (s relationServiceStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	return s.read(ctx, run)
}
func (s relationServiceStore) WriteProject(ctx context.Context, id string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.write(ctx, id, run)
}

type relationSnapshot struct {
	store.SnapshotScope
	dao store.GoalRelationReader
}

func (s relationSnapshot) GoalRelationDAO() store.GoalRelationReader { return s.dao }

type relationWriteScope struct {
	store.ProjectWriteScope
	dao store.GoalRelationEditor
}

func (s relationWriteScope) GoalRelationDAO() store.GoalRelationEditor { return s.dao }

type relationReader struct {
	store.GoalRelationReader
	source        func(context.Context, string, string, string) (store.GoalRelationSource, error)
	prerequisites func(context.Context, string, string, string) ([]store.GoalRelationEdge, error)
	successors    func(context.Context, string, string, string, string, int) ([]store.GoalRelationTarget, error)
}

func (d relationReader) Source(c context.Context, p, g, u string) (store.GoalRelationSource, error) {
	return d.source(c, p, g, u)
}
func (d relationReader) Prerequisites(c context.Context, p, g, u string) ([]store.GoalRelationEdge, error) {
	return d.prerequisites(c, p, g, u)
}
func (d relationReader) Successors(c context.Context, p, g, u, a string, l int) ([]store.GoalRelationTarget, error) {
	return d.successors(c, p, g, u, a, l)
}
func relationSource() store.GoalRelationSource {
	return store.GoalRelationSource{Type: model.TaskTypeGoal, Status: model.TaskTodo, CanRead: true, CanEdit: true, TeamID: relationTestProject, Revision: 9007199254740993}
}

func TestGoalRelationsReadProjectionAndCursor(t *testing.T) {
	for _, editable := range []bool{false, true} {
		t.Run(map[bool]string{false: "reader", true: "editor"}[editable], func(t *testing.T) {
			ctx := t.Context()
			source := relationSource()
			source.CanEdit = editable
			visible := &store.GoalRelationTarget{ProjectID: relationTestProject, GoalID: relationTestOther, Title: "Visible", Status: model.TaskDone, Kind: "internal"}
			calls := 0
			dao := relationReader{
				source: func(actual context.Context, p, g, u string) (store.GoalRelationSource, error) {
					if actual != ctx || p != relationTestProject || g != relationTestGoal || u != relationTestActor.UserID {
						t.Fatal("wrong source arguments")
					}
					return source, nil
				},
				prerequisites: func(context.Context, string, string, string) ([]store.GoalRelationEdge, error) {
					return []store.GoalRelationEdge{{ID: relationTestEdge, Status: model.TaskTodo}, {ID: relationTestOther, Status: model.TaskDone, Target: visible}}, nil
				},
				successors: func(actual context.Context, p, g, u, after string, limit int) ([]store.GoalRelationTarget, error) {
					calls++
					if actual != ctx || p != relationTestProject || g != relationTestGoal || u != relationTestActor.UserID || limit != 2 {
						t.Fatal("wrong successor arguments")
					}
					if calls == 1 {
						if after != "" {
							t.Fatal("first page had position")
						}
						return []store.GoalRelationTarget{{GoalID: relationTestOther}, {GoalID: relationTestEdge}}, nil
					}
					if after != relationTestOther {
						t.Fatal("continuation lost ordering")
					}
					return []store.GoalRelationTarget{}, nil
				},
			}
			svc := NewTasks(relationServiceStore{read: func(actual context.Context, run func(store.SnapshotScope) error) error {
				if actual != ctx {
					t.Fatal("read context changed")
				}
				return run(relationSnapshot{dao: dao})
			}})
			result, err := svc.ShowGoalDependencies(ctx, relationTestActor, relationTestProject, relationTestGoal, model.PageRequest{Limit: 1})
			if err != nil || result.GoalID != relationTestGoal || result.CanEdit != editable || !result.CompletionBlocked || len(result.Prerequisites) != 2 || result.Prerequisites[0].Target != nil || result.Prerequisites[1].Target != visible || len(result.Successors) != 1 || result.NextCursor == nil {
				t.Fatalf("projection %+v err=%v", result, err)
			}
			if editable {
				if result.Revision == nil || *result.Revision != source.Revision || result.Prerequisites[0].EdgeID == nil || *result.Prerequisites[0].EdgeID != relationTestEdge {
					t.Fatal("editor lost opaque edge/revision")
				}
			} else {
				if result.Revision != nil || result.Prerequisites[0].EdgeID != nil || result.Prerequisites[1].EdgeID != nil {
					t.Fatal("reader received edit identifiers")
				}
			}
			next, err := svc.ShowGoalDependencies(ctx, relationTestActor, relationTestProject, relationTestGoal, model.PageRequest{Limit: 1, Cursor: result.NextCursor})
			if err != nil || next.NextCursor != nil || len(next.Successors) != 0 {
				t.Fatalf("next %+v %v", next, err)
			}
		})
	}
}

func TestGoalRelationsReadRefusalsAndFailures(t *testing.T) {
	sentinel := errors.New("read failed")
	for _, stage := range []string{"source", "permission", "prerequisites", "successors", "snapshot", "overflow"} {
		t.Run(stage, func(t *testing.T) {
			dao := relationReader{source: func(context.Context, string, string, string) (store.GoalRelationSource, error) {
				if stage == "source" {
					return store.GoalRelationSource{}, sentinel
				}
				s := relationSource()
				if stage == "permission" {
					s.CanRead = false
				}
				return s, nil
			}, prerequisites: func(context.Context, string, string, string) ([]store.GoalRelationEdge, error) {
				if stage == "prerequisites" {
					return nil, sentinel
				}
				if stage == "overflow" {
					return make([]store.GoalRelationEdge, 31), nil
				}
				return []store.GoalRelationEdge{}, nil
			}, successors: func(context.Context, string, string, string, string, int) ([]store.GoalRelationTarget, error) {
				if stage == "successors" {
					return nil, sentinel
				}
				return []store.GoalRelationTarget{}, nil
			}}
			svc := NewTasks(relationServiceStore{read: func(_ context.Context, run func(store.SnapshotScope) error) error {
				if err := run(relationSnapshot{dao: dao}); err != nil {
					return err
				}
				if stage == "snapshot" {
					return sentinel
				}
				return nil
			}})
			result, err := svc.ShowGoalDependencies(t.Context(), relationTestActor, relationTestProject, relationTestGoal, model.PageRequest{})
			if err == nil || !reflect.DeepEqual(result, taskcore.GoalDependencies{}) {
				t.Fatalf("failure returned data %+v %v", result, err)
			}
			if stage != "permission" && stage != "overflow" && !errors.Is(err, sentinel) {
				t.Fatalf("lost cause %v", err)
			}
		})
	}
}

type relationEditor struct {
	store.GoalRelationEditor
	lock      func(context.Context) error
	admission func(context.Context, string, string, []store.GoalEndpoint) (store.GoalRelationAdmission, error)
	edges     func(context.Context, string) ([]store.GoalRelationEdge, error)
	save      func(context.Context, string, int64, []store.GoalRelationEdge) error
}

func (d relationEditor) LockTeam(c context.Context) error { return d.lock(c) }
func (d relationEditor) Admission(c context.Context, g, u string, e []store.GoalEndpoint) (store.GoalRelationAdmission, error) {
	return d.admission(c, g, u, e)
}
func (d relationEditor) Edges(c context.Context, g string) ([]store.GoalRelationEdge, error) {
	return d.edges(c, g)
}
func (d relationEditor) Save(c context.Context, g string, r int64, e []store.GoalRelationEdge) error {
	return d.save(c, g, r, e)
}

func TestGoalRelationsEditTransactionAndFailures(t *testing.T) {
	for _, stage := range []string{"success", "noop", "lock", "admission", "edges", "save", "unknown", "completion"} {
		t.Run(stage, func(t *testing.T) {
			sentinel := errors.New("transaction failed")
			calls := []string{}
			source := relationSource()
			source.Revision = 2
			edge := store.GoalRelationEdge{ID: relationTestEdge, Endpoint: store.GoalEndpoint{ProjectID: relationTestProject, GoalID: relationTestOther}, Status: model.TaskTodo}
			var bounded context.Context
			dao := relationEditor{lock: func(ctx context.Context) error {
				calls = append(calls, "lock")
				if ctx != bounded {
					t.Fatal("lock context changed")
				}
				if stage == "lock" {
					return sentinel
				}
				return nil
			}, admission: func(ctx context.Context, g, u string, e []store.GoalEndpoint) (store.GoalRelationAdmission, error) {
				calls = append(calls, "admission")
				if ctx != bounded || g != relationTestGoal || u != relationTestActor.UserID || len(e) != 0 {
					t.Fatal("wrong admission arguments")
				}
				if stage == "admission" {
					return store.GoalRelationAdmission{}, sentinel
				}
				return store.GoalRelationAdmission{Source: source}, nil
			}, edges: func(ctx context.Context, g string) ([]store.GoalRelationEdge, error) {
				calls = append(calls, "edges")
				if stage == "edges" {
					return nil, sentinel
				}
				if stage == "noop" {
					return []store.GoalRelationEdge{}, nil
				}
				return []store.GoalRelationEdge{edge}, nil
			}, save: func(ctx context.Context, g string, r int64, e []store.GoalRelationEdge) error {
				calls = append(calls, "save")
				if ctx != bounded || g != relationTestGoal || r != 2 || len(e) != 0 {
					t.Fatal("wrong saved replacement")
				}
				if stage == "save" {
					return sentinel
				}
				return nil
			}}
			svc := NewTasks(relationServiceStore{write: func(ctx context.Context, p string, run func(store.ProjectWriteScope) error) (store.Completion, error) {
				bounded = ctx
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > goalLifecycleTimeout || p != relationTestProject {
					t.Fatal("write identity/budget missing")
				}
				err := run(relationWriteScope{dao: dao})
				if err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, err
				}
				if stage == "unknown" {
					return store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: sentinel}
				}
				if stage == "completion" {
					return store.Completion{Outcome: store.TransactionNotCommitted}, nil
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}})
			result, err := svc.EditGoalDependencies(t.Context(), relationTestActor, relationTestProject, relationTestGoal, taskcore.GoalDependencyEdit{IfRevision: 2, Mode: "replace", Prerequisites: []taskcore.GoalDependencyReference{}})
			if stage == "success" || stage == "noop" {
				want := int64(3)
				if stage == "noop" {
					want = 2
				}
				if err != nil || result.GoalID != relationTestGoal || result.Revision != want || result.Changed != (stage == "success") {
					t.Fatalf("receipt %+v %v", result, err)
				}
				if stage == "noop" && len(calls) != 3 {
					t.Fatal("noop performed save")
				}
				return
			}
			if err == nil || result != (taskcore.GoalDependencyReceipt{}) {
				t.Fatalf("unconfirmed receipt %+v %v", result, err)
			}
			if stage != "completion" && !errors.Is(err, sentinel) {
				t.Fatalf("lost cause %v", err)
			}
			if stage == "unknown" {
				var unknown *GoalWriteUnknown
				if !errors.As(err, &unknown) {
					t.Fatalf("unknown not identified: %v", err)
				}
			}
			wantCalls := map[string]int{"lock": 1, "admission": 2, "edges": 3, "save": 4, "unknown": 4, "completion": 4}[stage]
			if len(calls) != wantCalls {
				t.Fatalf("unexpected calls %v", calls)
			}
		})
	}
}

func TestGoalRelationsRejectBeforeStore(t *testing.T) {
	svc := NewTasks(relationServiceStore{})
	for _, id := range []string{"bad", relationTestGoal} {
		actor := relationTestActor
		if id == relationTestGoal {
			actor = model.Principal{}
		}
		if _, err := svc.ShowGoalDependencies(t.Context(), actor, relationTestProject, id, model.PageRequest{}); err == nil {
			t.Fatal("invalid read identity accepted")
		}
		if _, err := svc.EditGoalDependencies(t.Context(), actor, relationTestProject, id, taskcore.GoalDependencyEdit{}); err == nil {
			t.Fatal("invalid edit identity accepted")
		}
	}
	for _, request := range []model.PageRequest{{Limit: -1}, {Limit: 51}, {Cursor: func() *string { s := "bad"; return &s }()}} {
		if _, err := svc.ShowGoalDependencies(t.Context(), relationTestActor, relationTestProject, relationTestGoal, request); err == nil {
			t.Fatal("invalid page accepted")
		}
	}
	if _, err := svc.EditGoalDependencies(t.Context(), relationTestActor, relationTestProject, relationTestGoal, taskcore.GoalDependencyEdit{}); err == nil {
		t.Fatal("invalid edit accepted")
	}
	cursor, _ := query.EncodeGoalCursor(query.GoalPageScope{ProjectID: relationTestProject, GoalID: relationTestOther, UserID: relationTestActor.UserID, Limit: 20}, relationTestEdge)
	if _, err := svc.ShowGoalDependencies(t.Context(), relationTestActor, relationTestProject, relationTestGoal, model.PageRequest{Cursor: &cursor}); err == nil {
		t.Fatal("cursor crossed Goal")
	}
}
