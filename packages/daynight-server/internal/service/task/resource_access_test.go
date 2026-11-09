package task_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func taskResourceCall(f *taskRuleFixture, ctx context.Context, principal model.Principal, operation string) error {
	switch operation {
	case "create":
		_, err := f.tasks.Create(ctx, principal, f.project.ID, taskcore.CreateTask{Title: "Attempt"})
		return err
	case "update":
		_, err := f.tasks.Update(ctx, principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, Title: &f.target.Title})
		return err
	case "get":
		_, err := f.tasks.Get(ctx, principal, f.project.ID, f.target.ID)
		return err
	case "list":
		_, err := f.tasks.List(ctx, principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}})
		return err
	case "graph":
		_, err := f.tasks.Graph(ctx, principal, f.project.ID, f.target.ID)
		return err
	case "status/todo", "status/in_progress", "status/done":
		_, err := f.tasks.SetStatus(ctx, principal, f.project.ID, f.target.ID, taskcore.SetTaskStatus{Version: f.target.Version, Status: model.TaskStatus(strings.TrimPrefix(operation, "status/"))})
		return err
	default:
		panic("unknown task access operation")
	}
}

func TestTaskResourceOperationsRejectAbsentPrincipals(t *testing.T) {
	project, target, principal := taskMockModels()
	for _, actor := range []model.Principal{{}, {UserID: principal.UserID, CredentialID: principal.CredentialID, Kind: "unknown"}} {
		for _, operation := range []string{"create", "update", "get", "list", "graph", "status/todo"} {
			f := &taskRuleFixture{project: project, target: target, tasks: taskservice.NewTasks(&taskStoreMock{taskMockBase: newTaskMockBase(t, "unadmitted")})}
			requireFault(t, taskResourceCall(f, t.Context(), actor, operation), "unauthenticated")
		}
	}
}

func prepareTaskResourceSuccess(t *testing.T, f *taskRuleFixture, ctx context.Context, operation string) {
	t.Helper()
	if operation == "create" || operation == "update" {
		f.dependencies(ctx, []string{}, []model.Task{})
	}
	switch operation {
	case "get":
		f.reader.TaskFn = func(actual context.Context, projectID, id string) (model.Task, error) {
			if actual != ctx || projectID != f.project.ID || id != f.target.ID {
				t.Fatal("member read scope changed")
			}
			return f.target, nil
		}
	case "list":
		f.reader.TasksFn = func(actual context.Context, projectID string, q store.TaskQuery) (store.TaskPage, error) {
			if actual != ctx || projectID != f.project.ID || q.Page.Limit != 1 {
				t.Fatal("member list scope changed")
			}
			return store.TaskPage{Items: []model.Task{f.target}}, nil
		}
	case "graph":
		f.projectReader.ProjectFn = func(actual context.Context, projectID string) (model.Project, error) {
			if actual != ctx || projectID != f.project.ID {
				t.Fatal("member graph Project scope changed")
			}
			return f.project, nil
		}
		f.snapshot.ObservedAtFn = func(actual context.Context) (time.Time, error) {
			if actual != ctx {
				t.Fatal("member graph clock context changed")
			}
			return f.target.UpdatedAt, nil
		}
		f.reader.TaskPresenceFn = func(actual context.Context, projectID, id string) (store.TaskPresence, error) {
			if actual != ctx || projectID != f.project.ID || id != f.target.ID {
				t.Fatal("member graph root scope changed")
			}
			return store.TaskPresence{Found: true}, nil
		}
		f.reader.TaskGraphTasksFn = func(actual context.Context, projectID, id string, _ store.TaskGraphSelection, _ int) ([]model.GraphTask, error) {
			if actual != ctx || projectID != f.project.ID || id != f.target.ID {
				t.Fatal("member graph rows scope changed")
			}
			return []model.GraphTask{taskReadGraphTask(f.target.ID, f.target.Title, model.TaskTodo)}, nil
		}
	case "create":
		f.writer.CreateTaskFn = func(actual context.Context, id string, values store.TaskWrite) (model.Task, error) {
			if actual != ctx || id == "" || values.Title != "Attempt" {
				t.Fatal("member creation changed input")
			}
			created := f.target
			created.ID, created.Title = id, values.Title
			return created, nil
		}
		f.audience(ctx, "task.created")
	case "update":
		f.current(ctx, f.target)
	}
}

func TestTaskResourceOperationsRequireCurrentMembership(t *testing.T) {
	for _, actorState := range []string{"outsider", "removed member"} {
		for _, operation := range []string{"get", "list", "graph", "create", "update", "status/todo", "status/in_progress", "status/done"} {
			t.Run(actorState+"/"+operation, func(t *testing.T) {
				f := newTaskRuleFixture(t)
				ctx := t.Context()
				actor := f.principal
				if actorState == "outsider" {
					actor.UserID = "99999999-9999-4999-8999-999999999999"
				}
				access := model.ProjectAccess{ProjectID: f.project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, DirectGrant: &model.ProjectGrant{ProjectID: f.project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: f.project.CreatedAt, UpdatedAt: f.project.UpdatedAt}}
				var accessErr error
				f.projectReader.ProjectAccessFn = func(actual context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
					if actual != ctx || p != actor || id != f.project.ID {
						t.Fatal("current read authorization changed actor or scope")
					}
					return access, accessErr
				}
				f.projectWriter.ProjectAccessFn = func(actual context.Context, p model.Principal) (model.ProjectAccess, error) {
					if actual != ctx || p != actor {
						t.Fatal("current write authorization changed actor or scope")
					}
					return access, accessErr
				}
				f.read(ctx)
				f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
				if actorState == "removed member" && !strings.HasPrefix(operation, "status/") {
					prepareTaskResourceSuccess(t, f, ctx, operation)
					if err := taskResourceCall(f, ctx, actor, operation); err != nil {
						t.Fatalf("current member was refused: %v", err)
					}
				}
				access, accessErr = model.ProjectAccess{}, model.ErrNotFound
				f.reader = &taskReaderMock{taskMockBase: f.reader.taskMockBase}
				f.writer = &taskWriterMock{taskMockBase: f.writer.taskMockBase}
				f.projectReader.ProjectFn = nil
				requireFault(t, taskResourceCall(f, ctx, actor, operation), "not_found")
			})
		}
	}
}

func TestMemberTaskStatusProgressionKeepsVersionSequence(t *testing.T) {
	for index, transition := range [][2]model.TaskStatus{{model.TaskTodo, model.TaskInProgress}, {model.TaskInProgress, model.TaskDone}, {model.TaskDone, model.TaskTodo}, {model.TaskTodo, model.TaskDone}} {
		f := newTaskRuleFixture(t)
		ctx := t.Context()
		current := f.target
		current.Status, current.Version = transition[0], int64(index+1)
		current.Ready = current.Status == model.TaskTodo
		if current.Status != model.TaskTodo {
			current.StartedAt = &current.CreatedAt
		}
		if current.Status == model.TaskDone {
			current.CompletedAt = &current.UpdatedAt
		}
		f.current(ctx, current)
		f.projectWriter.ProjectAccessFn = func(actual context.Context, p model.Principal) (model.ProjectAccess, error) {
			if actual != ctx || p != f.principal {
				t.Fatal("member status authorization scope changed")
			}
			return model.ProjectAccess{ProjectID: f.project.ID, UserID: p.UserID, Role: model.ProjectMemberRole, DirectGrant: &model.ProjectGrant{ProjectID: f.project.ID, UserID: p.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: f.project.CreatedAt, UpdatedAt: f.project.UpdatedAt}}, nil
		}
		f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
		if current.Status == model.TaskDone {
			f.writer.ActiveDependentIDsFn = func(actual context.Context, id string) ([]string, error) {
				if actual != ctx || id != current.ID {
					t.Fatal("member reopen queried another task")
				}
				return []string{}, nil
			}
		}
		after := current
		after.Status, after.Version, after.UpdatedAt = transition[1], int64(index+2), current.UpdatedAt.Add(time.Second)
		after.Ready = after.Status == model.TaskTodo
		switch after.Status {
		case model.TaskTodo:
			after.StartedAt, after.CompletedAt = nil, nil
		case model.TaskInProgress:
			after.StartedAt, after.CompletedAt = &after.UpdatedAt, nil
		case model.TaskDone:
			after.CompletedAt = &after.UpdatedAt
		}
		f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Properties: current.Properties, Status: transition[1], DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn}, after)
		f.audience(ctx, "task.status_changed")
		got, err := f.tasks.SetStatus(ctx, f.principal, f.project.ID, current.ID, taskcore.SetTaskStatus{Version: current.Version, Status: transition[1]})
		if err != nil || !reflect.DeepEqual(got, after) {
			t.Fatalf("member status step %d: %#v %v", index, got, err)
		}
	}
}

func TestDeletedTaskRefusalsPrecedeFurtherOperations(t *testing.T) {
	for _, operation := range []string{"get", "update", "status/done", "delete", "claim"} {
		t.Run(operation, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			f.target.Version++
			f.read(ctx)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.reader.TaskFn = func(actual context.Context, projectID, id string) (model.Task, error) {
				if actual != ctx || projectID != f.project.ID || id != f.target.ID {
					t.Fatal("deleted read changed context or Task scope")
				}
				return model.Task{}, model.ErrTaskDeleted
			}
			f.writer.TaskFn = func(actual context.Context, id string) (model.Task, error) {
				if actual != ctx || id != f.target.ID {
					t.Fatal("deleted mutation changed context or Task identity")
				}
				return model.Task{}, model.ErrTaskDeleted
			}
			var err error
			switch operation {
			case "delete":
				err = f.tasks.Delete(ctx, f.principal, f.project.ID, f.target.ID, taskcore.DeleteTask{Version: f.target.Version})
			case "claim":
				_, err = f.tasks.ClaimWorker(ctx, f.principal, f.project.ID, f.target.ID, taskcore.ClaimWorker{Version: f.target.Version, WorkerDescriptor: workerDescriptor()})
			default:
				err = taskResourceCall(f, ctx, f.principal, operation)
			}
			fault := requireFault(t, err, "task_deleted")
			if operation == "get" && !errors.Is(fault, model.ErrTaskDeleted) {
				t.Fatal("deleted Task read lost its original cause")
			}
		})
	}
}
