package mcp

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTypedTaskReadSchemas(t *testing.T) {
	definitions := []sdk.Tool{}
	for _, source := range [][]byte{taskToolDefinitions, taskQueryToolDefinitions} {
		var tools []sdk.Tool
		if err := json.Unmarshal(source, &tools); err != nil {
			t.Fatal(err)
		}
		definitions = append(definitions, tools...)
	}
	for _, name := range []string{"task_show", "task_list"} {
		var tool sdk.Tool
		for _, candidate := range definitions {
			if candidate.Name == name {
				tool = candidate
			}
		}
		schema, err := resolveSchema(tool.OutputSchema)
		if err != nil {
			t.Fatal(err)
		}
		for _, view := range []string{"summary", "full"} {
			for _, kind := range []string{"task", "goal"} {
				t.Run(name+"/"+view+"/"+kind, func(t *testing.T) {
					task := taskFixtureTask()
					task.Type = model.TaskType(kind)
					task.Ready = false
					var projection any = MapTaskSummary(task)
					if view == "full" {
						projection = MapTaskFull(task)
					}
					raw, err := json.Marshal(projection)
					if err != nil {
						t.Fatal(err)
					}
					var item map[string]any
					if err := json.Unmarshal(raw, &item); err != nil {
						t.Fatal(err)
					}
					item["session"] = observationFixture()
					if name == "task_list" && view == "full" {
						delete(item, "description")
					}
					if kind == "goal" && view == "full" {
						item["progress"] = map[string]any{"total": 7, "done": 2, "cancelled": 1, "unfinished": 4}
					}
					envelope := func(item map[string]any) []byte {
						data := any(item)
						meta := map[string]any{"requestId": "request", "observedAt": "2026-11-01T02:03:04Z", "partial": false, "refs": map[string]any{}}
						if name == "task_list" {
							data = map[string]any{"items": []any{item}, "nextCursor": nil, "projection": view}
						}
						raw, err := json.Marshal(map[string]any{"data": data, "meta": meta})
						if err != nil {
							t.Fatal(err)
						}
						return raw
					}
					if err := validateJSON(schema, envelope(item)); err != nil {
						t.Fatalf("valid result: %v", err)
					}
					if kind == "goal" {
						for _, status := range []string{"todo", "in_progress", "done", "cancelled"} {
							item["status"] = status
							if err := validateJSON(schema, envelope(item)); err != nil {
								t.Fatalf("goal %s: %v", status, err)
							}
						}
					} else {
						item["parentId"] = testTargetID
						if err := validateJSON(schema, envelope(item)); err != nil {
							t.Fatalf("task parent: %v", err)
						}
					}
					// Each mutation is made on a fresh copy so a previous invalid case cannot mask it.
					cases := map[string]func(map[string]any){
						"missing type":        func(v map[string]any) { delete(v, "type") },
						"unknown type":        func(v map[string]any) { v["type"] = "unknown" },
						"missing parent":      func(v map[string]any) { delete(v, "parentId") },
						"invalid parent":      func(v map[string]any) { v["parentId"] = 42 },
						"invalid parent UUID": func(v map[string]any) { v["parentId"] = "not-a-uuid" },
					}
					if kind == "goal" {
						cases["goal parent"] = func(v map[string]any) { v["parentId"] = testTargetID }
						cases["goal proposed"] = func(v map[string]any) { v["status"] = "proposed" }
						cases["goal ready"] = func(v map[string]any) { v["ready"] = true }
						cases["goal automation"] = func(v map[string]any) { v["allowAgents"] = true }
						cases["goal platform"] = func(v map[string]any) { v["requiredPlatform"] = "linux" }
						if view == "full" {
							cases["missing progress"] = func(v map[string]any) { delete(v, "progress") }
							cases["invalid progress"] = func(v map[string]any) { v["progress"] = map[string]any{"total": -1} }
							cases["goal dependency"] = func(v map[string]any) { v["dependsOn"] = []string{testTargetID} }
						} else {
							cases["summary progress"] = func(v map[string]any) { v["progress"] = map[string]any{} }
							cases["goal blocker count"] = func(v map[string]any) { v["blockedByCount"] = 1 }
						}
					} else if view == "full" {
						cases["ordinary progress"] = func(v map[string]any) {
							v["progress"] = map[string]any{"total": 0, "done": 0, "cancelled": 0, "unfinished": 0}
						}
					}
					for label, mutate := range cases {
						copy := make(map[string]any, len(item))
						for k, v := range item {
							copy[k] = v
						}
						mutate(copy)
						if err := validateJSON(schema, envelope(copy)); err == nil {
							t.Errorf("accepted %s", label)
						}
					}
				})
			}
		}
	}
}

func TestTypedFieldsNotAcceptedByExistingTaskWrites(t *testing.T) {
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
		input := map[string]any{"projectId": testProjectID, "title": "Task"}
		if tool.Name == "task_update" {
			input["taskId"] = testTargetID
		}
		encode := func() []byte {
			raw, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			return raw
		}
		if err := validateJSON(schema, encode()); err != nil {
			t.Fatalf("%s ordinary input: %v", tool.Name, err)
		}
		for field, value := range map[string]any{"type": "goal", "parentId": testTargetID} {
			input[field] = value
			if err := validateJSON(schema, encode()); err == nil {
				t.Errorf("%s accepted %s", tool.Name, field)
			}
			delete(input, field)
		}
	}
}
