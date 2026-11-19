package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type goalFacts struct {
	unsatisfied, doneSuccessor, incoming bool
	err                                  error
	calls                                []string
}

func (f *goalFacts) UnsatisfiedPrerequisites(_ context.Context, id string) (bool, error) {
	f.calls = append(f.calls, "prerequisites:"+id)
	return f.unsatisfied, f.err
}
func (f *goalFacts) DoneSuccessors(_ context.Context, id string) (bool, error) {
	f.calls = append(f.calls, "successors:"+id)
	return f.doneSuccessor, f.err
}
func (f *goalFacts) HasIncoming(_ context.Context, id string) (bool, error) {
	f.calls = append(f.calls, "incoming:"+id)
	return f.incoming, f.err
}

func TestGoalDependencyLifecycle(t *testing.T) {
	for _, test := range []struct {
		name       string
		from, to   model.TaskStatus
		facts      goalFacts
		code, call string
	}{
		{"same done", model.TaskDone, model.TaskDone, goalFacts{unsatisfied: true, doneSuccessor: true}, "", ""},
		{"start", model.TaskTodo, model.TaskInProgress, goalFacts{unsatisfied: true}, "", ""},
		{"complete blocked", model.TaskInProgress, model.TaskDone, goalFacts{unsatisfied: true}, "goal_dependency_unsatisfied", "prerequisites:goal"},
		{"complete allowed", model.TaskCancelled, model.TaskDone, goalFacts{}, "", "prerequisites:goal"},
		{"reopen blocked", model.TaskDone, model.TaskTodo, goalFacts{doneSuccessor: true}, "goal_dependency_done_successor", "successors:goal"},
		{"cancel blocked", model.TaskDone, model.TaskCancelled, goalFacts{doneSuccessor: true}, "goal_dependency_done_successor", "successors:goal"},
		{"reopen allowed", model.TaskDone, model.TaskInProgress, goalFacts{}, "", "successors:goal"},
	} {
		t.Run(test.name, func(t *testing.T) {
			current := model.Task{ID: "goal", Type: model.TaskTypeGoal, Status: test.from}
			err := ValidateGoalStatus(t.Context(), &test.facts, current, test.to)
			if test.code != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.code || len(fault.TaskIDs) != 0 {
					t.Fatalf("fault exposed or changed: %#v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			if test.call == "" && len(test.facts.calls) != 0 || test.call != "" && (len(test.facts.calls) != 1 || test.facts.calls[0] != test.call) {
				t.Fatalf("calls: %v", test.facts.calls)
			}
		})
	}
	sentinel := errors.New("storage failed")
	facts := &goalFacts{err: sentinel}
	if err := ValidateGoalStatus(t.Context(), facts, model.Task{ID: "goal", Status: model.TaskTodo}, model.TaskDone); !errors.Is(err, sentinel) {
		t.Fatalf("lost storage failure: %v", err)
	}
	facts = &goalFacts{incoming: true}
	var fault *model.Fault
	if err := ValidateGoalDeletion(t.Context(), facts, "goal"); !errors.As(err, &fault) || fault.Code != "goal_dependency_referenced" || len(fault.TaskIDs) != 0 {
		t.Fatalf("deletion fault: %v", err)
	}
	facts = &goalFacts{err: sentinel}
	if err := ValidateGoalDeletion(t.Context(), facts, "goal"); !errors.Is(err, sentinel) {
		t.Fatalf("lost deletion failure: %v", err)
	}
}
