package task

import (
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestTaskParentViewAdmissionUsesSelectedBytes(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	task := model.Task{ParentID: &id, ParentType: model.TaskTypeTask}
	size, err := taskprotocol.EncodeREST(io.Discard, task, true, taskcore.MaxTaskResponseJSONBytes, true)
	if err != nil {
		t.Fatal(err)
	}
	task.Description = strings.Repeat("x", int(taskcore.MaxTaskResponseJSONBytes-size))
	ctx := WithTaskParentView(t.Context(), true)
	if !taskParentView(ctx) || taskParentView(t.Context()) {
		t.Fatal("relation context not isolated")
	}
	if err := admitTaskResponse(ctx, task, false); err != nil {
		t.Fatal(err)
	}
	task.Description += "x"
	if err := admitTaskResponse(ctx, task, false); err == nil {
		t.Fatal("extended REST overflow admitted")
	}
	if err := admitTaskResponse(t.Context(), task, false); err != nil {
		t.Fatalf("default REST boundary changed: %v", err)
	}

	task.Description = ""
	mcp := WithMCPTaskResponse(ctx, "request", 1, true, false, true)
	size, err = taskprotocol.EncodeMCPResponse(io.Discard, task, "request", "changed", 1, true, true, taskcore.MaxTaskResponseJSONBytes, true)
	if err != nil {
		t.Fatal(err)
	}
	task.Description = strings.Repeat("x", int(taskcore.MaxTaskResponseJSONBytes-size))
	if err := admitTaskResponse(mcp, task, true); err != nil {
		t.Fatal(err)
	}
	task.Description += "x"
	if err := admitTaskResponse(mcp, task, true); err == nil {
		t.Fatal("extended MCP overflow admitted")
	}
}
