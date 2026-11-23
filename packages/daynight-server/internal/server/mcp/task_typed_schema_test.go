package mcp

import (
	"encoding/json"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTaskTagInputSchemas(t *testing.T) {
	var definitions []sdk.Tool
	if err := json.Unmarshal(taskToolDefinitions, &definitions); err != nil {
		t.Fatal(err)
	}
	for _, tool := range definitions {
		if tool.Name != "task_create" && tool.Name != "task_update" {
			continue
		}
		schema, err := resolveSchema(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			name string
			tags any
			want bool
		}{
			{"empty", []string{}, true},
			{"multiple", []string{testTargetID, testProjectID}, true},
			{"duplicates", []string{testTargetID, testTargetID}, true},
			{"null", nil, false},
			{"invalid item", []any{42}, false},
		} {
			input := map[string]any{"projectId": testProjectID, "tagIds": tc.tags}
			if tool.Name == "task_create" {
				input["title"] = "Task"
			} else {
				input["taskId"] = testTargetID
			}
			raw, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if got := validateJSON(schema, raw) == nil; got != tc.want {
				t.Errorf("%s %s: valid=%v, want %v", tool.Name, tc.name, got, tc.want)
			}
		}
	}
}
