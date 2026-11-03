package core

import "testing"

func TestTaskStepStatesStayIndependentOfTaskStates(t *testing.T) {
	for _, state := range []TaskStepStatus{TaskStepTodo, TaskStepInProgress, TaskStepDone, TaskStepSkipped} {
		if !state.Valid() {
			t.Fatalf("invalid Step state %q", state)
		}
	}
	if TaskStepStatus("review").Valid() || TaskStatus(TaskStepSkipped).Valid() {
		t.Fatal("Step and Task states were conflated")
	}
}
