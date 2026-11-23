package task

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type ordinaryDAO struct {
	taskDAO
	current     model.Task
	parent      model.Task
	parentErr   error
	childrenErr error
}

func (d *ordinaryDAO) Task(context.Context, string) (model.Task, error) { return d.current, nil }
func (d *ordinaryDAO) ParentTask(context.Context, string) (model.Task, error) {
	return d.parent, d.parentErr
}
func (d *ordinaryDAO) UnfinishedChildIDs(context.Context, string) ([]string, error) {
	return d.children, d.childrenErr
}

func TestOrdinaryCreationIntentAndParentAdmission(t *testing.T) {
	base := CreateTask{Title: "child", ParentTaskID: ptr(goalID)}
	candidate, err := CreateCandidate(childID, base)
	if err != nil || !candidate.OrdinaryParent || *candidate.ParentID != goalID {
		t.Fatalf("candidate %+v: %v", candidate, err)
	}
	both := base
	both.ParentID = ptr(goalID)
	_, err = CreateCandidate(childID, both)
	faultCode(t, err, "invalid_input")
	goal := base
	goal.Type = model.TaskTypeGoal
	_, err = CreateCandidate(childID, goal)
	faultCode(t, err, "invalid_input")
	for _, status := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		dao := &ordinaryDAO{parent: model.Task{ID: goalID, Type: model.TaskTypeTask, Status: status}}
		_, err = PrepareCreate(t.Context(), dao, childID, candidate)
		if status.IsTerminal() {
			faultCode(t, err, "task_parent_terminal")
		} else if err != nil {
			t.Fatalf("%s: %v", status, err)
		}
	}
	for _, readErr := range []error{model.ErrNotFound, model.ErrTaskDeleted} {
		dao := &ordinaryDAO{parentErr: readErr}
		_, err = PrepareCreate(t.Context(), dao, childID, candidate)
		faultCode(t, err, "invalid_input")
	}
	dao := &ordinaryDAO{parent: model.Task{Type: model.TaskTypeGoal}}
	_, err = PrepareCreate(t.Context(), dao, childID, candidate)
	faultCode(t, err, "invalid_input")
}

func TestOrdinaryParentCannotChange(t *testing.T) {
	current := model.Task{ID: childID, Type: model.TaskTypeTask, Title: "child", ParentID: ptr(goalID), ParentType: model.TaskTypeTask, Status: model.TaskTodo, Version: 1, Properties: model.TaskProperties{}}
	dao := &ordinaryDAO{current: current}
	_, err := PrepareUpdate(t.Context(), dao, childID, UpdateTask{Version: 1, ParentID: ptr[*string](nil)})
	faultCode(t, err, "task_parent_immutable")
	dao.current.ParentID = nil
	dao.current.ParentType = ""
	dao.parent = model.Task{Type: model.TaskTypeTask}
	_, err = PrepareUpdate(t.Context(), dao, childID, UpdateTask{Version: 1, ParentID: ptr(ptr(goalID))})
	faultCode(t, err, "task_parent_immutable")
}

func TestDescendantCancellationPresence(t *testing.T) {
	for _, confirmation := range []bool{false, true} {
		input := SetTaskStatus{Version: 1, Status: model.TaskCancelled, CancelDescendants: confirmation, CancelDescendantsPresent: true}
		if _, err := ValidateStatus(input); err != nil {
			t.Fatal(err)
		}
		for _, status := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone} {
			input.Status = status
			_, err := ValidateStatus(input)
			faultCode(t, err, "invalid_input")
		}
		input.Status = model.TaskCancelled
		for _, currentStatus := range []model.TaskStatus{model.TaskTodo, model.TaskCancelled} {
			goal := model.Task{Type: model.TaskTypeGoal, Status: currentStatus}
			_, changed, err := StatusCandidate(t.Context(), nil, model.Principal{}, goal, input, nil)
			faultCode(t, err, "invalid_input")
			if changed {
				t.Fatal("Goal cancellation with descendant input changed state")
			}
		}
	}
}

func TestOrdinaryLifecycleChildAndParentGates(t *testing.T) {
	current := model.Task{ID: childID, Type: model.TaskTypeTask, Status: model.TaskTodo, Properties: model.TaskProperties{}}
	dao := &ordinaryDAO{taskDAO: taskDAO{children: []string{"a", "b"}}}
	for _, status := range []model.TaskStatus{model.TaskDone, model.TaskCancelled} {
		_, changed, err := StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: status}, nil)
		fault := faultCode(t, err, "task_unfinished_children")
		if changed || !reflect.DeepEqual(fault.TaskIDs, dao.children) {
			t.Fatalf("changed %v fault %+v", changed, fault)
		}
	}
	faultCode(t, ValidateDelete(t.Context(), dao, current, true), "task_unfinished_children")
	_, changed, err := StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskCancelled, CancelDescendants: true}, nil)
	if err != nil || !changed {
		t.Fatalf("planned cancellation: %v %v", changed, err)
	}
	_, err = ValidateStatus(SetTaskStatus{Version: 1, Status: model.TaskDone, CancelDescendants: true})
	faultCode(t, err, "invalid_input")
	dao.children = nil
	dao.childrenErr = errors.New("read children")
	_, _, err = StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskDone}, nil)
	if !errors.Is(err, dao.childrenErr) {
		t.Fatalf("lost lookup error: %v", err)
	}
	current.Status = model.TaskDone
	current.ParentID = ptr(goalID)
	current.ParentType = model.TaskTypeTask
	dao.childrenErr = nil
	dao.parent = model.Task{ID: goalID, Type: model.TaskTypeTask, Status: model.TaskCancelled}
	_, _, err = StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskTodo}, nil)
	faultCode(t, err, "task_parent_terminal")
	dao.parent.Status = model.TaskTodo
	_, changed, err = StatusCandidate(t.Context(), dao, model.Principal{}, current, SetTaskStatus{Status: model.TaskTodo}, nil)
	if err != nil || !changed {
		t.Fatalf("open parent: %v %v", changed, err)
	}
}
