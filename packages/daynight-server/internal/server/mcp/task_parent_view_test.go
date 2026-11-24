package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func assertTaskParentProjection(t *testing.T, data map[string]any, parent string, expanded bool) {
	t.Helper()
	if data["parentId"] != nil {
		t.Fatalf("ordinary parent exposed as Goal: %#v", data)
	}
	value, present := data["parentTaskId"]
	if present != expanded || expanded && value != parent {
		t.Fatalf("parentTaskId=%v, present=%v, expanded=%v", value, present, expanded)
	}
}

func TestTaskParentViewShowAndWriteResults(t *testing.T) {
	for _, expanded := range []bool{false, true} {
		for _, view := range []string{"summary", "full", "receipt"} {
			t.Run(view+map[bool]string{false: "/default", true: "/expanded"}[expanded], func(t *testing.T) {
				f := newTaskResourceFixture(t)
				child := taskFixtureTask()
				parent := testProjectID
				child.ParentID, child.ParentType = &parent, model.TaskTypeTask
				args := map[string]any{"projectId": f.project, "taskId": child.ID}
				if expanded {
					args["taskParentView"] = "v1"
				}
				if view != "receipt" {
					expectTaskGet(t, f, child, nil)
					args["view"] = view
					assertTaskParentProjection(t, taskData(t, f.client, "task_show", args), parent, expanded)
					delete(args, "view")
				}
				expectTaskStatus(t, f, taskcore.SetTaskStatus{Version: child.Version, Status: child.Status}, child, nil)
				args["ifVersion"], args["status"], args["returnView"] = Decimal(child.Version), child.Status, view
				data := taskData(t, f.client, "task_set_status", args)
				if view == "receipt" {
					if len(data) != 3 {
						t.Fatalf("minimal receipt fields: %#v", data)
					}
					if _, present := data["parentTaskId"]; present {
						t.Fatalf("minimal receipt includes relation: %#v", data)
					}
				} else {
					assertTaskParentProjection(t, data, parent, expanded)
				}
			})
		}
	}
}

func TestTaskParentViewQueryTools(t *testing.T) {
	for _, tool := range []string{"task_list", "task_ready", "task_graph"} {
		for _, expanded := range []bool{false, true} {
			for _, view := range []string{"summary", "full"} {
				t.Run(tool+"/"+view+map[bool]string{false: "/default", true: "/expanded"}[expanded], func(t *testing.T) {
					parent := testProjectID
					child := taskFixtureTask()
					child.ParentID, child.ParentType = &parent, model.TaskTypeTask
					stub := &queryStub{items: []store.TaskPriorityItem{{Task: child}}, graph: model.TaskGraph{Tasks: []model.GraphTask{{ID: child.ID, Type: child.Type, ParentID: &parent, ParentType: model.TaskTypeTask}}}}
					f := newEntryFixture(t)
					if err := registerTaskQueryTools(f.entry, stub); err != nil {
						t.Fatal(err)
					}
					args := map[string]any{"projectId": testProjectID, "view": view}
					if expanded {
						args["taskParentView"] = "v1"
					}
					if tool == "task_graph" {
						args["taskId"] = testTargetID
					} else {
						args["parentTaskId"] = parent
					}
					result := tagTestCall(t, f.client(t, "2026-07-28", "alice"), tool, args)
					if result.IsError {
						t.Fatalf("query: %#v", structured(t, result))
					}
					data := object(t, structured(t, result)["data"])
					field := "items"
					if tool == "task_graph" {
						field = "tasks"
					} else {
						got := stub.request.ParentTask
						if tool == "task_ready" {
							got = stub.readyRequest.ParentTask
						}
						if got == nil || *got != parent {
							t.Fatalf("parentTask filter: %v", got)
						}
					}
					assertTaskParentProjection(t, object(t, data[field].([]any)[0]), parent, expanded)
				})
			}
		}
	}
}

func TestTaskParentViewSearch(t *testing.T) {
	for _, expanded := range []bool{false, true} {
		f := newEntryFixture(t)
		parent := testProjectID
		calls := 0
		if err := RegisterTaskSearchTool(f.entry, func(_ context.Context, _ model.Principal, project string, in tasksearch.Request) (tasksearch.Page, error) {
			calls++
			if in.ParentTask == nil || *in.ParentTask != parent || in.Parent != nil {
				t.Errorf("search filter: %+v", in)
			}
			return tasksearch.Page{ProjectID: project, Items: []tasksearch.Item{{ID: testTargetID, Type: model.TaskTypeTask, ParentID: &parent, ParentType: model.TaskTypeTask, Context: &tasksearch.Context{TaskID: parent, Title: "Parent Task"}}}}, nil
		}); err != nil {
			t.Fatal(err)
		}
		args := map[string]any{"projectId": testProjectID, "query": "child", "parentTaskId": parent}
		if expanded {
			args["taskParentView"] = "v1"
		}
		result := tagTestCall(t, f.client(t, "2026-07-28", "alice"), "task_search", args)
		if result.IsError || calls != 1 {
			t.Fatalf("search: %#v, calls=%d", structured(t, result), calls)
		}
		item := object(t, object(t, structured(t, result)["data"])["items"].([]any)[0])
		assertTaskParentProjection(t, item, parent, expanded)
		if item["context"] != nil {
			t.Fatalf("ordinary parent context exposed as Goal: %#v", item)
		}
		parentContext, present := item["parentTaskContext"]
		if present != expanded || expanded && object(t, parentContext)["taskId"] != parent {
			t.Fatalf("ordinary context: %#v", item)
		}
	}
}

func TestTaskParentViewInputSchemas(t *testing.T) {
	var definitions []sdk.Tool
	if err := json.Unmarshal(taskToolDefinitions, &definitions); err != nil {
		t.Fatal(err)
	}
	var queries []sdk.Tool
	if err := json.Unmarshal(taskQueryToolDefinitions, &queries); err != nil {
		t.Fatal(err)
	}
	var search sdk.Tool
	if err := json.Unmarshal(taskSearchToolDefinition, &search); err != nil {
		t.Fatal(err)
	}
	definitions = append(append(definitions, queries...), search)
	for _, tool := range definitions {
		if tool.Name == "task_properties" || tool.Name == "task_delete" {
			continue
		}
		schema, err := resolveSchema(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		base := map[string]any{"projectId": testProjectID}
		switch tool.Name {
		case "task_create":
			base["title"] = "New Task"
		case "task_search":
			base["query"] = "child"
		case "task_list", "task_ready":
		default:
			base["taskId"] = testTargetID
		}
		if tool.Name == "task_set_status" {
			base["status"] = "done"
		}
		if tool.Name == "task_update" {
			base["title"] = "Updated Task"
		}
		if tool.Name == "task_set_property" {
			base["name"], base["valueText"] = "blocked", "false"
		}
		if tool.Name == "task_remove_property" {
			base["name"] = "blocked"
		}
		for _, value := range []any{"v1", "v2", "", nil, true} {
			base["taskParentView"] = value
			raw, _ := json.Marshal(base)
			if got, want := validateJSON(schema, raw) == nil, value == "v1"; got != want {
				t.Errorf("%s taskParentView=%v valid=%v, want=%v", tool.Name, value, got, want)
			}
		}
		if tool.Name == "task_list" || tool.Name == "task_ready" || tool.Name == "task_search" {
			base["taskParentView"], base["parentTaskId"], base["parentId"] = "v1", testTargetID, nil
			raw, _ := json.Marshal(base)
			if validateJSON(schema, raw) == nil {
				t.Errorf("%s accepted competing Parent filters", tool.Name)
			}
			delete(base, "parentId")
			base["parentTaskId"] = nil
			raw, _ = json.Marshal(base)
			if validateJSON(schema, raw) == nil {
				t.Errorf("%s accepted null ordinary Parent filter", tool.Name)
			}
		}
	}
}

func TestTaskParentViewBusinessLimit(t *testing.T) {
	fields := map[string]any{"query": strings.Repeat("x", httpx.MaxJSONBody-len(`{"query":""}`)), "taskParentView": "v1", "projectId": testProjectID}
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := queryBusinessLimit(raw); err != nil {
		t.Fatalf("presentation choice consumed business bytes: %v", err)
	}
	fields["parentTaskId"] = testTargetID
	raw, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if queryBusinessLimit(raw) == nil {
		t.Fatal("ordinary Parent filter was excluded from business bytes")
	}
}

func TestTaskParentViewRefusesUnsupportedProjectionBeforeBusinessCalls(t *testing.T) {
	actor := RequestActor{}
	ctx := t.Context()
	for name, call := range map[string]func() (ToolResult, error){
		"list": func() (ToolResult, error) {
			return listTool(ctx, actor, listInput{TaskParentView: "v2"}, nil)
		},
		"ready": func() (ToolResult, error) {
			return readyTool(ctx, actor, readyInput{TaskParentView: "v2"}, nil)
		},
		"graph": func() (ToolResult, error) {
			return graphTool(ctx, actor, graphInput{TaskParentView: "v2"}, nil)
		},
		"show": func() (ToolResult, error) {
			return handleTaskTool(ctx, actor, nil, nil, "task_show", taskArguments{TaskParentView: "v2"}, nil)
		},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := call()
			var fault *model.Fault
			if result.Data != nil || !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("unsupported projection: data=%#v, error=%v", result.Data, err)
			}
		})
	}
}
