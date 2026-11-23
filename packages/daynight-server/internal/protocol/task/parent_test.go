package task

import (
	"bytes"
	"encoding/json"
	"io"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestParentProjectionAcrossTaskRepresentations(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, kind := range []model.TaskType{"", model.TaskTypeGoal, model.TaskTypeTask} {
		for _, enabled := range []bool{false, true} {
			t.Run(string(kind)+map[bool]string{false: "/default", true: "/v1"}[enabled], func(t *testing.T) {
				var parent *string
				if kind != "" {
					parent = &id
				}
				task := model.Task{ParentID: parent, ParentType: kind}
				rest, err := RESTTask(task, true, enabled)
				if err != nil {
					t.Fatal(err)
				}
				values := []any{rest, MCPTask(task, enabled), MCPTaskSummary(task, enabled), RESTSyncRecord(model.TaskViewRecord{ParentID: parent, ParentType: kind}, enabled)}
				for _, value := range values {
					encoded, err := json.Marshal(value)
					if err != nil {
						t.Fatal(err)
					}
					var fields map[string]json.RawMessage
					if err := json.Unmarshal(encoded, &fields); err != nil {
						t.Fatal(err)
					}
					goal := "null"
					if kind == model.TaskTypeGoal {
						goal = `"` + id + `"`
					}
					if string(fields["parentId"]) != goal {
						t.Fatalf("Goal parent: %s", encoded)
					}
					taskValue, present := fields["parentTaskId"]
					if present != enabled {
						t.Fatalf("extension presence: %s", encoded)
					}
					if enabled {
						want := "null"
						if kind == model.TaskTypeTask {
							want = `"` + id + `"`
						}
						if string(taskValue) != want {
							t.Fatalf("Task parent: %s", encoded)
						}
					}
				}
			})
		}
	}
}

func TestParentProjectionEncodingUsesAdmissionBytes(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	task := model.Task{ParentID: &id, ParentType: model.TaskTypeTask}
	var output bytes.Buffer
	n, err := EncodeREST(&output, task, true, math.MaxInt64, true)
	if err != nil {
		t.Fatal(err)
	}
	value, err := RESTTask(task, true, true)
	if err != nil {
		t.Fatal(err)
	}
	want, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), append(want, '\n')) || n != int64(output.Len()) {
		t.Fatal("REST admission differs from response")
	}
	if _, err := EncodeREST(io.Discard, task, true, n-1, true); err == nil {
		t.Fatal("REST relation bytes omitted from admission")
	}
	output.Reset()
	n, err = EncodeMCPResponse(&output, task, "r", "changed", 1, true, true, math.MaxInt64, true)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(output.Bytes(), []byte(`"parentTaskId":"`+id+`"`)) {
		t.Fatal("missing MCP relation")
	}
	if _, err := EncodeMCPResponse(io.Discard, task, "r", "changed", 1, true, true, n-1, true); err == nil {
		t.Fatal("MCP relation bytes omitted from admission")
	}
}
