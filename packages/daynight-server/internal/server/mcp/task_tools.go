package mcp

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"time"
)

//go:embed task_tools.json
var taskToolDefinitions []byte

type taskObservationGetter interface {
	ObserveGet(context.Context, model.Principal, string, string) (taskservice.ObservedTask, error)
}

type taskResourceOperations interface {
	Create(context.Context, model.Principal, string, taskcore.CreateTask) (model.Task, error)
	Get(context.Context, model.Principal, string, string) (model.Task, error)
	UpdatePartitionedDependencies(context.Context, model.Principal, string, string, taskcore.UpdateTask, *[]string, *[]string) (model.Task, error)
	ReplaceTags(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error)
	SetStatus(context.Context, model.Principal, string, string, taskcore.SetTaskStatus) (model.Task, error)
	Delete(context.Context, model.Principal, string, string, taskcore.DeleteTask) error
	SetProperty(context.Context, model.Principal, string, string, string, string, int64) (model.Task, error)
	RemoveProperty(context.Context, model.Principal, string, string, string, int64) (model.Task, error)
}

type taskArguments struct {
	ProjectID         string              `json:"projectId"`
	TaskID            string              `json:"taskId"`
	Type              model.TaskType      `json:"type"`
	ParentID          *string             `json:"parentId"`
	Title             *string             `json:"title"`
	Description       *string             `json:"description"`
	AssignedTo        *string             `json:"assignedTo"`
	RequiredPlatform  *model.TaskPlatform `json:"requiredPlatform"`
	AllowAgents       *bool               `json:"allowAgents"`
	DependsOn         *[]string           `json:"dependsOn"`
	ExternalDependsOn *[]string           `json:"externalDependsOn"`
	TagIDs            *[]string           `json:"tagIds"`
	IfVersion         *string             `json:"ifVersion"`
	View              string              `json:"view"`
	ReturnView        string              `json:"returnView"`
	Status            model.TaskStatus    `json:"status"`
	ClaimID           *string             `json:"claimId"`
	RemoveDepends     bool                `json:"removeDepends"`
	Mode              string              `json:"mode"`
	Name              string              `json:"name"`
	ValueText         string              `json:"valueText"`
}

// RegisterTaskTools exposes complete Task operations through the shared service.
// Operations that read or write Tasks reserve for their full materialization.
// The static property schema uses the independent control budget.
func RegisterTaskTools(e *Entry, tasks taskResourceOperations, observations taskObservationGetter) error {
	if e == nil || tasks == nil || tasks == (*taskservice.Tasks)(nil) {
		return fmt.Errorf("MCP task tools require an entry and Tasks service")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(taskToolDefinitions, &definitions); err != nil {
		return err
	}
	for _, tool := range definitions {
		name := tool.Name
		budget := func(raw json.RawMessage) BudgetClass {
			if name == "task_properties" {
				var input struct {
					Mode string `json:"mode"`
				}
				if json.Unmarshal(raw, &input) == nil && input.Mode == "schema" {
					return BudgetControl
				}
			}
			return BudgetLarge
		}
		handler := func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
			if err := ValidateUnicodeFields(raw, "title", "description", "name", "valueText"); err != nil {
				return ToolResult{}, err
			}
			var input taskArguments
			fields, err := jsonobject.Decode(raw, "tool arguments", "projectId", "taskId", "type", "parentId", "title", "description", "assignedTo", "requiredPlatform", "allowAgents", "dependsOn", "externalDependsOn", "tagIds", "ifVersion", "view", "returnView", "status", "claimId", "removeDepends", "mode", "name", "valueText")
			if err != nil {
				return ToolResult{}, &model.Fault{Code: "invalid_input", Message: err.Error()}
			}
			if err := json.Unmarshal(raw, &input); err != nil {
				return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
			}
			return handleTaskTool(ctx, actor, tasks, observations, name, input, fields)
		}
		register := e.registerTool
		if name == "task_show" || name == "task_properties" {
			register = e.registerReadTool
		}
		if err := register(tool, budget, handler); err != nil {
			return fmt.Errorf("register %s: %w", name, err)
		}
	}
	return nil
}

// The business payload limit matches the REST JSON limit independently of
// routing identifiers and MCP presentation options.
func taskBusinessLimit(name string, fields map[string]json.RawMessage, version int64, all, external *[]string) error {
	if name == "task_show" || name == "task_properties" {
		return nil
	}
	body := map[string]json.RawMessage{}
	for _, key := range []string{"type", "parentId", "title", "description", "assignedTo", "requiredPlatform", "allowAgents", "dependsOn", "externalDependsOn", "tagIds", "status", "claimId", "removeDepends"} {
		if value, ok := fields[key]; ok {
			body[key] = value
		}
	}
	if all != nil {
		body["dependsOn"], _ = json.Marshal(all)
		body["externalDependsOn"], _ = json.Marshal(external)
	}
	if name != "task_create" {
		body["version"] = json.RawMessage(Decimal(version))
	}
	if name == "task_set_property" {
		body["valueText"] = fields["valueText"]
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil || encoded.Len()-1 > httpx.MaxJSONBody {
		return httpx.InvalidInput("request body must be valid JSON within the 1 MiB limit")
	}
	return nil
}

// The domain uses the union and an external subset; either input replaces both.
func compileTaskDependencies(ordinary, external *[]string) (*[]string, *[]string, error) {
	return taskservice.PartitionDependencies(ordinary, external)
}

func taskView(task model.Task, view string) any {
	if view == "full" {
		return MapTaskFull(task)
	}
	return MapTaskSummary(task)
}
func taskResult(task model.Task, view string, previous int64) ToolResult {
	outcome := "changed"
	if task.Version == previous {
		outcome = "unchanged"
	}
	return ToolResult{Data: taskView(task, view), Outcome: outcome, WriteOutcome: "confirmed", Refs: map[string]any{"projectId": task.ProjectID, "taskId": task.ID, "version": Decimal(task.Version)}}
}
func taskVersion(ctx context.Context, actor RequestActor, tasks taskResourceOperations, input taskArguments) (int64, error) {
	if input.IfVersion != nil {
		return ParseVersion(*input.IfVersion)
	}
	task, err := tasks.Get(ctx, actor.Principal, input.ProjectID, input.TaskID)
	if err != nil {
		return 0, err
	}
	return task.Version, nil
}
func handleTaskTool(ctx context.Context, actor RequestActor, tasks taskResourceOperations, observations taskObservationGetter, name string, in taskArguments, fields map[string]json.RawMessage) (ToolResult, error) {
	if name != "task_show" && name != "task_properties" && name != "task_delete" {
		if actor.rpcResponseID == nil {
			return ToolResult{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Task response could not be bounded."}
		}
		ctx = taskservice.WithMCPTaskResponse(ctx, actor.RequestID, actor.rpcResponseID, actor.rpcModern, actor.rpcBatch, in.ReturnView == "full")
	}
	switch name {
	case "task_create":
		all, external, err := compileTaskDependencies(in.DependsOn, in.ExternalDependsOn)
		if err != nil {
			return ToolResult{}, err
		}
		if err := taskBusinessLimit(name, fields, 0, all, external); err != nil {
			return ToolResult{}, err
		}
		assigned := in.AssignedTo
		_, assignedPresent := fields["assignedTo"]
		_, platformPresent := fields["requiredPlatform"]
		if !assignedPresent && in.Type != model.TaskTypeGoal {
			assigned = &actor.Principal.UserID
		}
		input := taskcore.CreateTask{Type: in.Type, ParentID: in.ParentID, Title: *in.Title, AssignedTo: assigned, AssignedToPresent: assignedPresent, RequiredPlatform: in.RequiredPlatform, RequiredPlatformPresent: platformPresent, TagIDs: in.TagIDs}
		if _, exists := fields["status"]; exists {
			input.Status = &in.Status
		}
		if in.Description != nil {
			input.Description = *in.Description
		}
		if all != nil {
			input.DependsOn, input.ExternalDependsOn = *all, *external
		}
		task, err := tasks.Create(ctx, actor.Principal, in.ProjectID, input)
		if err != nil {
			return ToolResult{}, err
		}
		return taskResult(task, in.ReturnView, 0), nil
	case "task_show":
		observed, err := observations.ObserveGet(ctx, actor.Principal, in.ProjectID, in.TaskID)
		if err != nil {
			return ToolResult{}, err
		}
		var data any
		if in.View == "full" {
			data = struct {
				TaskFull
				Session sp.TaskSessionObservation `json:"session"`
			}{MapTaskFull(observed.Task), observed.Session}
		} else {
			data = struct {
				TaskSummary
				Session sp.TaskSessionObservation `json:"session"`
			}{MapTaskSummary(observed.Task), observed.Session}
		}
		stamp := time.Time{}
		if observed.Session.ObservedAt != nil {
			stamp = *observed.Session.ObservedAt
		}
		return ToolResult{Data: data, Observation: &ReadObservation{ObservedAt: stamp, Partial: observed.Session.Observation != "observed"}, Refs: map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}}, nil
	case "task_properties":
		if in.Mode == "schema" {
			return ToolResult{Data: map[string]any{"properties": taskproperty.Definitions()}}, nil
		}
		task, err := tasks.Get(ctx, actor.Principal, in.ProjectID, in.TaskID)
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Data: map[string]any{"projectId": task.ProjectID, "taskId": task.ID, "version": Decimal(task.Version), "properties": task.Properties}}, nil
	}
	var all, external *[]string
	if name == "task_update" {
		// A large partition is refused by the service after its version check;
		// do not allocate its union merely to measure the request envelope.
		all, external, _ = compileTaskDependencies(in.DependsOn, in.ExternalDependsOn)
	}
	// Omitted versions are read once and never refreshed after a write.
	version, err := taskVersion(ctx, actor, tasks, in)
	if err != nil {
		return ToolResult{}, err
	}
	if err := taskBusinessLimit(name, fields, version, all, external); err != nil {
		return ToolResult{}, err
	}
	var task model.Task
	switch name {
	case "task_update":
		input := taskcore.UpdateTask{Version: version, Title: in.Title, Description: in.Description, AllowAgents: in.AllowAgents, TagIDs: in.TagIDs}
		if _, ok := fields["parentId"]; ok {
			input.ParentID = &in.ParentID
		}
		if _, ok := fields["assignedTo"]; ok {
			input.AssignedTo = &in.AssignedTo
		}
		if _, ok := fields["requiredPlatform"]; ok {
			input.RequiredPlatform = &in.RequiredPlatform
		}
		if in.TagIDs != nil && in.Title == nil && in.Description == nil && in.AllowAgents == nil && input.ParentID == nil && input.AssignedTo == nil && input.RequiredPlatform == nil && in.DependsOn == nil && in.ExternalDependsOn == nil {
			task, err = tasks.ReplaceTags(ctx, actor.Principal, in.ProjectID, in.TaskID, version, in.TagIDs)
		} else {
			task, err = tasks.UpdatePartitionedDependencies(ctx, actor.Principal, in.ProjectID, in.TaskID, input, in.DependsOn, in.ExternalDependsOn)
		}
	case "task_set_status":
		task, err = tasks.SetStatus(ctx, actor.Principal, in.ProjectID, in.TaskID, taskcore.SetTaskStatus{Version: version, Status: in.Status, ClaimID: in.ClaimID})
	case "task_delete":
		err = tasks.Delete(ctx, actor.Principal, in.ProjectID, in.TaskID, taskcore.DeleteTask{Version: version, RemoveDepends: in.RemoveDepends})
		if err != nil {
			return ToolResult{}, err
		}
		projectID, _ := model.CanonicalID(in.ProjectID)
		taskID, _ := model.CanonicalID(in.TaskID)
		refs := map[string]any{"projectId": projectID, "taskId": taskID}
		return ToolResult{Data: map[string]any{"projectId": projectID, "taskId": taskID, "deleted": true}, Outcome: "changed", WriteOutcome: "confirmed", Refs: refs}, nil
	case "task_set_property":
		task, err = tasks.SetProperty(ctx, actor.Principal, in.ProjectID, in.TaskID, in.Name, in.ValueText, version)
	case "task_remove_property":
		task, err = tasks.RemoveProperty(ctx, actor.Principal, in.ProjectID, in.TaskID, in.Name, version)
	default:
		return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Unknown task operation."}
	}
	if err != nil {
		return ToolResult{}, err
	}
	return taskResult(task, in.ReturnView, version), nil
}
