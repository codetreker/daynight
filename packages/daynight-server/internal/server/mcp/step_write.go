package mcp

import (
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed step_write_tools.json
var stepWriteToolsJSON []byte

type stepWriteOperations interface {
	ListPage(context.Context, model.Principal, string, string, int64, int, *int64, bool) (taskservice.StepsPage, error)
	Add(context.Context, model.Principal, string, string, taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	Update(context.Context, model.Principal, string, string, string, taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatus(context.Context, model.Principal, string, string, string, taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	Move(context.Context, model.Principal, string, string, string, taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
	Delete(context.Context, model.Principal, string, string, string, taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
}

type stepWriteBase struct {
	ProjectID  string  `json:"projectId"`
	TaskID     string  `json:"taskId"`
	IfVersion  *string `json:"ifVersion"`
	ReturnView string  `json:"returnView"`
}
type stepAddInput struct {
	stepWriteBase
	ID          *string               `json:"id"`
	Title       string                `json:"title"`
	Description *string               `json:"description"`
	Status      *model.TaskStepStatus `json:"status"`
	Before      *string               `json:"before"`
	After       *string               `json:"after"`
}
type stepUpdateInput struct {
	stepWriteBase
	StepID      string  `json:"stepId"`
	Title       *string `json:"title"`
	Description *string `json:"description"`
}
type stepStatusInput struct {
	stepWriteBase
	StepID string               `json:"stepId"`
	Status model.TaskStepStatus `json:"status"`
}
type stepMoveInput struct {
	stepWriteBase
	StepID   string  `json:"stepId"`
	Before   *string `json:"before"`
	After    *string `json:"after"`
	Position *string `json:"position"`
}
type stepDeleteInput struct {
	stepWriteBase
	StepID string `json:"stepId"`
}
type stepWriter struct{ steps stepWriteOperations }

// RegisterStepWriteTools uses a large-object permit even for summary receipts:
// the underlying mutations admit and encode the complete collection.
func RegisterStepWriteTools(e *Entry, steps stepWriteOperations) error {
	var definitions []*sdk.Tool
	if err := json.Unmarshal(stepWriteToolsJSON, &definitions); err != nil {
		return fmt.Errorf("decode Step write tools: %w", err)
	}
	byName := make(map[string]*sdk.Tool, len(definitions))
	for _, tool := range definitions {
		byName[tool.Name] = tool
	}
	h := stepWriter{steps: steps}
	if err := RegisterTypedTool(e, byName["task_step_add"], BudgetLarge, h.add, "projectId", "taskId", "id", "title", "description", "status", "before", "after", "ifVersion", "returnView"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["task_step_update"], BudgetLarge, h.update, "projectId", "taskId", "stepId", "title", "description", "ifVersion", "returnView"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["task_step_set_status"], BudgetLarge, h.status, "projectId", "taskId", "stepId", "status", "ifVersion", "returnView"); err != nil {
		return err
	}
	if err := RegisterTypedTool(e, byName["task_step_move"], BudgetLarge, h.move, "projectId", "taskId", "stepId", "before", "after", "position", "ifVersion", "returnView"); err != nil {
		return err
	}
	return RegisterTypedTool(e, byName["task_step_delete"], BudgetLarge, h.delete, "projectId", "taskId", "stepId", "ifVersion", "returnView")
}

func (h *stepWriter) version(ctx context.Context, actor RequestActor, base stepWriteBase) (int64, error) {
	if base.IfVersion != nil {
		return ParseVersion(*base.IfVersion)
	}
	page, err := h.steps.ListPage(ctx, actor.Principal, base.ProjectID, base.TaskID, -1, 1, nil, true)
	if err != nil {
		return 0, err
	}
	return page.Header.Version, nil
}

func stepRefs(base stepWriteBase, id string) map[string]any {
	refs := map[string]any{"projectId": base.ProjectID, "taskId": base.TaskID}
	if id != "" {
		refs["stepId"] = id
	}
	return refs
}
func stepPrepareFailure(base stepWriteBase, id string, err error) (ToolResult, error) {
	return ToolResult{Refs: stepRefs(base, id), WriteOutcome: "not_committed", Phase: "prepare"}, err
}

// stepBusinessBodySize counts the REST business JSON as JSON.stringify does,
// including version as a number, without HTML or U+2028 escaping.
func stepBusinessBodySize(version int64, fields map[string]string) int {
	size := len(`{"version":`) + len(strconv.FormatInt(version, 10)) + 1
	for key, value := range fields {
		size += 1 + jsonStringSize(key) + 1 + jsonStringSize(value)
	}
	return size
}
func jsonStringSize(s string) int {
	n := 2
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"', '\\', '\b', '\f', '\n', '\r', '\t':
			n += 2
		default:
			if s[i] < 0x20 {
				n += 6
			} else {
				n++
			}
		}
	}
	return n
}
func stepCheckBody(version int64, fields map[string]string) error {
	if stepBusinessBodySize(version, fields) > httpx.MaxJSONBody {
		return &model.Fault{Code: "invalid_input", Message: "Step input exceeds the JSON body limit."}
	}
	return nil
}
func addField(fields map[string]string, key string, value *string) {
	if value != nil {
		fields[key] = *value
	}
}

func (h *stepWriter) add(ctx context.Context, actor RequestActor, in stepAddInput) (ToolResult, error) {
	id := ""
	if in.ID != nil {
		id = *in.ID
	} else {
		var b [4]byte
		if _, err := rand.Read(b[:]); err != nil {
			return stepPrepareFailure(in.stepWriteBase, "", err)
		}
		id = hex.EncodeToString(b[:])
	}
	canonical, err := tasksteps.CanonicalID(id)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, id, err)
	}
	id = canonical
	fields := map[string]string{"id": id, "title": in.Title}
	addField(fields, "description", in.Description)
	addField(fields, "before", in.Before)
	addField(fields, "after", in.After)
	if in.Status != nil {
		fields["status"] = string(*in.Status)
	}
	version, err := h.version(ctx, actor, in.stepWriteBase)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, id, err)
	}
	if err = stepCheckBody(version, fields); err != nil {
		return stepPrepareFailure(in.stepWriteBase, id, err)
	}
	desc := ""
	if in.Description != nil {
		desc = *in.Description
	}
	result, err := h.steps.Add(ctx, actor.Principal, in.ProjectID, in.TaskID, taskservice.AddTaskStep{Version: version, ID: id, Title: in.Title, Description: desc, Status: in.Status, Before: in.Before, After: in.After})
	return stepWriteResponse(in.stepWriteBase, id, result, err)
}
func (h *stepWriter) update(ctx context.Context, actor RequestActor, in stepUpdateInput) (ToolResult, error) {
	fields := map[string]string{}
	addField(fields, "title", in.Title)
	addField(fields, "description", in.Description)
	version, err := h.version(ctx, actor, in.stepWriteBase)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	if err = stepCheckBody(version, fields); err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	result, err := h.steps.Update(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID, taskservice.UpdateTaskStep{Version: version, Title: in.Title, Description: in.Description})
	return stepWriteResponse(in.stepWriteBase, in.StepID, result, err)
}
func (h *stepWriter) status(ctx context.Context, actor RequestActor, in stepStatusInput) (ToolResult, error) {
	version, err := h.version(ctx, actor, in.stepWriteBase)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	if err = stepCheckBody(version, map[string]string{"status": string(in.Status)}); err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	result, err := h.steps.SetStatus(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID, taskservice.SetTaskStepStatus{Version: version, Status: in.Status})
	return stepWriteResponse(in.stepWriteBase, in.StepID, result, err)
}
func (h *stepWriter) move(ctx context.Context, actor RequestActor, in stepMoveInput) (ToolResult, error) {
	fields := map[string]string{}
	addField(fields, "before", in.Before)
	addField(fields, "after", in.After)
	addField(fields, "position", in.Position)
	version, err := h.version(ctx, actor, in.stepWriteBase)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	if err = stepCheckBody(version, fields); err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	result, err := h.steps.Move(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID, taskservice.MoveTaskStep{Version: version, Before: in.Before, After: in.After, Position: in.Position})
	return stepWriteResponse(in.stepWriteBase, in.StepID, result, err)
}
func (h *stepWriter) delete(ctx context.Context, actor RequestActor, in stepDeleteInput) (ToolResult, error) {
	version, err := h.version(ctx, actor, in.stepWriteBase)
	if err != nil {
		return stepPrepareFailure(in.stepWriteBase, in.StepID, err)
	}
	result, err := h.steps.Delete(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID, taskservice.DeleteTaskStep{Version: version})
	return stepWriteResponse(in.stepWriteBase, in.StepID, result, err)
}

func stepWriteResponse(base stepWriteBase, id string, result taskservice.StepsWriteResult, err error) (ToolResult, error) {
	if canonical, e := taskcodec.CanonicalID(id); e == nil {
		id = canonical
	}
	refs := stepRefs(base, id)
	if err != nil {
		var absence *tasksteps.StepAbsence
		if fault, ok := taskservice.TaskStepsFault(err); ok {
			if errors.As(err, &absence) {
				refs["version"] = Decimal(absence.Version)
			}
			if fault.Code == "steps_limit_exceeded" && fault.StepsLimit != nil {
				refs["encodedBytes"] = Decimal(fault.StepsLimit.EncodedBytes)
				refs["maxEncodedBytes"] = Decimal(fault.StepsLimit.MaxEncodedBytes)
			}
		}
		outcome := ""
		switch result.TransactionOutcome {
		case store.TransactionCommitted:
			outcome = "confirmed"
		case store.TransactionNotCommitted:
			outcome = "not_committed"
		case store.TransactionUnknown:
			outcome = "unknown"
		}
		return ToolResult{Refs: refs, WriteOutcome: outcome, Phase: result.Phase}, err
	}
	outcome := "unchanged"
	if result.Changed {
		outcome = "changed"
	}
	resource := result.Resource
	data := map[string]any{"projection": "summary", "projectId": resource.ProjectID, "taskId": resource.TaskID, "version": Decimal(resource.Version), "stepId": id, "changed": result.Changed, "stepCount": len(resource.Steps)}
	if base.ReturnView == "full" {
		data["projection"] = "full"
		data["steps"] = resource.Steps
	} else {
		if len(resource.Steps) == 0 {
			data["steps"] = []taskcodec.Step{}
		}
		for i, step := range resource.Steps {
			if step.ID == id {
				title := step.Title
				truncated := len(title) > titlePreviewBytes
				if truncated {
					end := titlePreviewBytes
					for end > 0 && !utf8.RuneStart(title[end]) {
						end--
					}
					title = title[:end]
				}
				data["step"] = map[string]any{"id": id, "position": i, "status": step.Status, "titlePreview": title, "titleTruncated": truncated}
				break
			}
		}
	}
	return ToolResult{Data: data, Outcome: outcome, WriteOutcome: "confirmed", Refs: refs}, nil
}
