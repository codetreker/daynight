package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestCreateCoordinatesTagSetBeforeCompletion(t *testing.T) {
	const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, mode := range []string{"omitted", "empty", "tagged", "invalid", "missing", "resolve failure", "create failure", "association failure", "read failure", "mismatched receipt", "admission failure", "unknown completion", "not committed"} {
		t.Run(mode, func(t *testing.T) {
			_, current, _ := taskMockModels()
			current.Type, current.AssignedTo, current.Tags = model.TaskTypeTask, nil, nil
			f := newTagServiceFixture(t, current)
			f.dependencies(f.ctx, []string{}, []model.Task{})
			f.ids = []string{a, b}
			f.resolved = []model.Tag{{ID: a, Name: "A"}, {ID: b, Name: "B"}}
			f.after = current
			f.after.Tags = []model.TagReference{{ID: b, Name: "B"}, {ID: a, Name: "A"}}
			f.reads = 1
			failure := errors.New("controlled failure")
			var requested *[]string
			switch mode {
			case "omitted":
			case "empty":
				requested = &[]string{}
			case "invalid":
				requested = &[]string{"bad"}
			default:
				requested = &[]string{strings.ToUpper(b), a, b}
			}
			switch mode {
			case "missing":
				f.resolved = f.resolved[:1]
			case "resolve failure":
				f.resolveErr = failure
			case "association failure":
				f.replaceErr = failure
			case "read failure":
				f.readErr = failure
			case "mismatched receipt":
				f.after.Tags = f.after.Tags[:1]
			case "admission failure":
				f.after.Description = strings.Repeat("x", taskcore.MaxTaskResponseJSONBytes)
			case "unknown completion":
				f.outcome = store.TransactionUnknown
				f.completionErr = &store.TransactionError{Phase: "commit", Cause: failure, Outcome: store.TransactionUnknown, CommitAttempted: true}
			case "not committed":
				f.outcome = store.TransactionNotCommitted
			}
			f.writer.CreateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
				f.events = append(f.events, "create")
				if ctx != f.ctx || id == "" || values.Title != "Created" || values.AllowAgents || values.AssignedTo != nil {
					t.Fatalf("create arguments id=%s values=%+v", id, values)
				}
				f.current.ID, f.after.ID = id, id
				if mode == "create failure" {
					return model.Task{}, failure
				}
				row := f.current
				row.Title = "Created"
				f.after.Title = row.Title
				return row, nil
			}
			f.audience(f.ctx, "task.created")
			got, err := f.tasks.Create(f.ctx, f.principal, strings.ToUpper(f.project.ID), taskcore.CreateTask{Title: "Created", TagIDs: requested})
			switch mode {
			case "omitted", "empty":
				if err != nil || len(got.Tags) != 0 {
					t.Fatalf("empty create: %+v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "create")
			case "tagged":
				if err != nil || !reflect.DeepEqual(got, f.after) {
					t.Fatalf("tagged create: %+v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "resolve", "create", "replace", "task")
			default:
				if err == nil || !reflect.DeepEqual(got, model.Task{}) {
					t.Fatalf("failure returned a result: %+v %v", got, err)
				}
				if mode == "invalid" {
					assertTagFault(t, err, "invalid_input")
				}
				if mode == "missing" {
					assertTagFault(t, err, "tag_not_found")
				}
				if slices.Contains([]string{"resolve failure", "create failure", "association failure", "read failure", "unknown completion"}, mode) && !errors.Is(err, failure) {
					t.Fatalf("lost cause: %v", err)
				}
				if slices.Contains([]string{"mismatched receipt", "admission failure"}, mode) && f.callbackErr == nil {
					t.Fatal("refusal escaped callback")
				}
				if mode == "admission failure" {
					assertTagFault(t, err, "resource_limit_exceeded")
				}
				if mode == "unknown completion" && f.callbackErr != nil {
					t.Fatalf("unknown completion misreported as callback failure: %v", f.callbackErr)
				}
				if slices.Contains([]string{"invalid", "missing", "resolve failure"}, mode) && slices.Contains(f.events, "create") {
					t.Fatalf("invalid set created task: %v", f.events)
				}
			}
		})
	}
}

func TestCreateTaggedGoalKeepsIndependentOwnerAndProgress(t *testing.T) {
	const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	_, current, _ := taskMockModels()
	current.Type, current.Status, current.Ready = model.TaskTypeGoal, model.TaskTodo, false
	current.Tags = nil
	f := newTagServiceFixture(t, current)
	f.ids = []string{id}
	f.resolved = []model.Tag{{ID: id, Name: "actual"}}
	f.projectWriter.ProjectAccessFn = func(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
		if ctx != f.ctx || principal.UserID != f.principal.UserID {
			t.Fatal("goal access check changed principal or context")
		}
		if principal == f.principal {
			f.events = append(f.events, "authorize")
		} else {
			f.events = append(f.events, "assignee")
		}
		return taskMockAccess(f.project, principal), nil
	}
	f.after = current
	f.after.Tags = []model.TagReference{{ID: id, Name: "actual"}}
	f.reads = 1
	f.writer.CreateTaskFn = func(ctx context.Context, taskID string, values store.TaskWrite) (model.Task, error) {
		f.events = append(f.events, "create")
		if ctx != f.ctx || values.Type != model.TaskTypeGoal || values.AssignedTo == nil || *values.AssignedTo != f.principal.UserID || values.ParentID != nil {
			t.Fatalf("goal candidate changed: %+v", values)
		}
		f.current.ID, f.after.ID = taskID, taskID
		f.current.AssignedTo, f.after.AssignedTo = values.AssignedTo, values.AssignedTo
		return f.current, nil
	}
	got, err := f.tasks.Create(f.ctx, f.principal, f.project.ID, taskcore.CreateTask{Type: model.TaskTypeGoal, Title: "Goal", TagIDs: &[]string{id}})
	if err != nil || got.ID != f.current.ID || got.AssignedTo == nil || *got.AssignedTo != f.principal.UserID || !reflect.DeepEqual(got.Tags, f.after.Tags) || got.Progress == nil || *got.Progress != (model.GoalProgress{Total: 2, Done: 1, Unfinished: 1}) {
		t.Fatalf("goal result: %+v %v", got, err)
	}
	assertTagEvents(t, f.events, "authorize", "clock", "resolve", "assignee", "create", "replace", "task", "progress")
}
