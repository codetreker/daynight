package task

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCreateCandidateDefaultsToProposedAndAllowsConfirmedTodo(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	for _, status := range []*model.TaskStatus{nil, ptr(model.TaskProposed), ptr(model.TaskTodo)} {
		values, err := CreateCandidate(id, CreateTask{Title: "Task", Status: status})
		want := model.TaskProposed
		if status != nil {
			want = *status
		}
		if err != nil || values.Status != want || values.Type != model.TaskTypeTask || values.ParentID != nil || values.AllowAgents {
			t.Fatalf("creation status %v: values=%+v err=%v", status, values, err)
		}
	}
	for _, status := range []model.TaskStatus{"", "unknown", model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		_, err := CreateCandidate(id, CreateTask{Title: "Task", Status: &status})
		faultCode(t, err, "invalid_input")
	}
}

func TestProposedStatusCanBeSetWithoutAConfirmationSequence(t *testing.T) {
	for _, from := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		for _, to := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
			if from != model.TaskProposed && to != model.TaskProposed {
				continue
			}
			t.Run(string(from)+" to "+string(to), func(t *testing.T) {
				current := model.Task{ID: "task", Title: "Task", Description: "Materials", Status: from, AllowAgents: true, Properties: model.TaskProperties{}}
				values, changed, err := StatusCandidate(t.Context(), taskDAO{}, model.Principal{}, current, SetTaskStatus{Status: to}, nil)
				if from == to {
					if err != nil || changed {
						t.Fatalf("same proposed status changed data: changed=%v err=%v", changed, err)
					}
					return
				}
				want := CurrentWrite(current)
				want.Status = to
				if err != nil || !changed || !reflect.DeepEqual(values, want) {
					t.Fatalf("transition %s to %s: values=%+v changed=%v err=%v", from, to, values, changed, err)
				}
			})
		}
	}
}

func TestProposedRetainsDependencyAndExecutionGuards(t *testing.T) {
	current := model.Task{ID: "task", Status: model.TaskProposed, BlockedBy: []string{"prerequisite"}}
	for _, to := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
		_, _, err := StatusCandidate(t.Context(), nil, model.Principal{}, current, SetTaskStatus{Status: to}, nil)
		faultCode(t, err, "dependency_unsatisfied")
	}
	current.Status = model.TaskTodo
	if _, changed, err := StatusCandidate(t.Context(), nil, model.Principal{}, current, SetTaskStatus{Status: model.TaskProposed}, nil); err != nil || !changed {
		t.Fatalf("blocked todo cannot become proposed: changed=%v err=%v", changed, err)
	}
	current.Status = model.TaskDone
	_, _, err := StatusCandidate(t.Context(), taskDAO{active: []string{"successor"}}, model.Principal{}, current, SetTaskStatus{Status: model.TaskProposed}, nil)
	faultCode(t, err, "dependency_unsatisfied")
	current.Status = model.TaskProposed
	current.BlockedBy = nil
	faultCode(t, WorkerReady(current), "invalid_transition")
	for _, state := range []model.WorkerState{model.WorkerActive} {
		current.Status = model.TaskInProgress
		_, _, err := StatusCandidate(t.Context(), nil, model.Principal{}, current, SetTaskStatus{Status: model.TaskProposed}, &model.WorkerClaim{State: state})
		faultCode(t, err, "invalid_transition")
	}
	current.Status = model.TaskCancelled
	_, _, err = StatusCandidate(t.Context(), nil, model.Principal{}, current, SetTaskStatus{Status: model.TaskProposed}, nil)
	faultCode(t, err, "invalid_transition")
}
