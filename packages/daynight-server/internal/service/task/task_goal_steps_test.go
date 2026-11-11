package task

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"testing"
)

func TestGoalStepsRejectBeforeRowsOrMutation(t *testing.T) {
	h := stepReadHeader(1)
	h.Type = model.TaskTypeGoal
	r := newStepReadFixture(t, h)
	r.begin(stepReadPath("")...)
	_, err := r.svc.List(r.ctx, r.principal, r.projectID, r.taskID)
	r.end()
	stepReadFault(t, err, "invalid_input")

	w := newStrictStepWrite(t, h, nil)
	w.begin(writePath("header")...)
	result, err := w.svc.Add(w.ctx, w.principal, h.ProjectID, h.ID, AddTaskStep{Version: h.Version, ID: "abcdef01", Title: "x"})
	w.end()
	expectRefusal(t, result, err, "invalid_input")
}
