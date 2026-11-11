package task

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestGoalProgressOnlyInFullProjections(t *testing.T) {
	progress := &model.GoalProgress{Total: 3, Done: 1, Cancelled: 1, Unfinished: 1}
	goal := model.Task{Type: model.TaskTypeGoal, Progress: progress}
	rest, err := RESTTask(goal, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, projection := range []any{rest, MCPTask(goal)} {
		b, err := json.Marshal(projection)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(b, &fields); err != nil {
			t.Fatal(err)
		}
		if string(fields["progress"]) != `{"total":3,"done":1,"cancelled":1,"unfinished":1}` {
			t.Fatalf("progress %s", b)
		}
	}
	for _, projection := range []any{MCPTaskSummary(goal), MCPTask(model.Task{Type: model.TaskTypeTask})} {
		b, err := json.Marshal(projection)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(b, &fields); err != nil {
			t.Fatal(err)
		}
		if _, present := fields["progress"]; present {
			t.Fatalf("unexpected progress %s", b)
		}
	}
}
