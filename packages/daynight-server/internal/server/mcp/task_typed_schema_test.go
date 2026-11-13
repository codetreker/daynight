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

func TestTaskTagSchemas(t *testing.T) {
	var definitions []sdk.Tool
	for _, source := range [][]byte{taskToolDefinitions, taskQueryToolDefinitions} {
		var tools []sdk.Tool
		if err := json.Unmarshal(source, &tools); err != nil {
			t.Fatal(err)
		}
		definitions = append(definitions, tools...)
	}
	for _, tool := range definitions {
		switch tool.Name {
		case "task_create", "task_update", "task_set_status", "task_set_property", "task_remove_property", "task_show", "task_list", "task_ready":
		default:
			continue
		}
		schema, err := resolveSchema(tool.OutputSchema)
		if err != nil {
			t.Fatal(err)
		}
		for _, view := range []string{"summary", "full"} {
			for _, tags := range [][]model.TagReference{nil, {{ID: testTargetID, Name: "<&标签"}, {ID: testProjectID, Name: "Other"}}} {
				task := taskFixtureTask()
				task.Tags = tags
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
				if tool.Name == "task_show" || tool.Name == "task_list" {
					item["session"] = observationFixture()
				}
				if tool.Name == "task_list" && view == "full" {
					delete(item, "description")
				}
				envelope := func(item map[string]any) []byte {
					var data any = item
					if tool.Name == "task_list" {
						data = map[string]any{"items": []any{item}, "nextCursor": nil, "projection": view}
					} else if tool.Name == "task_ready" {
						data = map[string]any{"items": []any{item}, "projection": view}
					}
					meta := map[string]any{"requestId": "request", "observedAt": "2026-11-01T02:03:04Z", "partial": false, "refs": map[string]any{}}
					result, err := json.Marshal(map[string]any{"data": data, "meta": meta})
					if err != nil {
						t.Fatal(err)
					}
					return result
				}
				if err := validateJSON(schema, envelope(item)); err != nil {
					t.Fatalf("%s %s tags=%v: %v", tool.Name, view, tags, err)
				}
				delete(item, "tags")
				if err := validateJSON(schema, envelope(item)); err == nil {
					t.Errorf("%s %s accepted missing tags", tool.Name, view)
				}
				item["tags"] = []any{map[string]any{"id": testTargetID}}
				if err := validateJSON(schema, envelope(item)); err == nil {
					t.Errorf("%s %s accepted tag without name", tool.Name, view)
				}
			}
		}
	}
}

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
