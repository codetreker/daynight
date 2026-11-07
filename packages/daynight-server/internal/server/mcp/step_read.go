package mcp

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed step_read_tools.json
var stepReadToolsJSON []byte

type stepReadOperations interface {
	ListPageAdmitted(context.Context, model.Principal, string, string, int64, int, *int64, bool, func(model.TaskHeader, store.TaskStepProjection, bool) (bool, error)) (taskservice.StepsPage, error)
	GetSummary(context.Context, model.Principal, string, string, string) (taskservice.StepSummary, error)
	GetBounded(context.Context, model.Principal, string, string, string) (taskservice.StepDocument, error)
}
type stepReadInput struct {
	ProjectID string  `json:"projectId"`
	TaskID    string  `json:"taskId"`
	StepID    string  `json:"stepId"`
	View      string  `json:"view"`
	Limit     *int    `json:"limit"`
	Cursor    *string `json:"cursor"`
}
type stepCursor struct {
	Schema    int    `json:"schema"`
	Kind      string `json:"kind"`
	UserID    string `json:"userId"`
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	View      string `json:"view"`
	Version   string `json:"version"`
	Position  int64  `json:"position"`
}
type stepSummaryWire struct {
	ID             string               `json:"id"`
	Status         model.TaskStepStatus `json:"status"`
	TitlePreview   string               `json:"titlePreview"`
	TitleTruncated bool                 `json:"titleTruncated"`
	Position       int64                `json:"position"`
}
type stepFullWire struct {
	ID          string               `json:"id"`
	Title       string               `json:"title"`
	Description string               `json:"description"`
	Status      model.TaskStepStatus `json:"status"`
	Position    int64                `json:"position"`
	CreatedAt   time.Time            `json:"createdAt"`
	UpdatedAt   time.Time            `json:"updatedAt"`
}

func projectStep(item store.TaskStepProjection, summary bool) any {
	s := item.Step
	if !summary {
		return stepFullWire{s.ID, s.Title, s.Description, s.Status, s.Position, s.CreatedAt.UTC(), s.UpdatedAt.UTC()}
	}
	title := s.Title
	truncated := item.TitleTruncated || len(title) > titlePreviewBytes
	if len(title) > titlePreviewBytes {
		end := titlePreviewBytes
		for end > 0 && !utf8.RuneStart(title[end]) {
			end--
		}
		title = title[:end]
	}
	return stepSummaryWire{s.ID, s.Status, title, truncated, s.Position}
}
func encodeStepCursor(c stepCursor) string {
	raw, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(raw)
}
func decodeStepCursor(raw string, expected stepCursor) (stepCursor, int64, error) {
	invalid := &model.Fault{Code: "invalid_input", Message: "Cursor is invalid for this Step list."}
	if len(raw) > taskcodec.MaxMCPStepCursorBytes {
		return stepCursor{}, 0, invalid
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil {
		return stepCursor{}, 0, invalid
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var c stepCursor
	if dec.Decode(&c) != nil || dec.Decode(new(any)) != io.EOF {
		return stepCursor{}, 0, invalid
	}
	version, err := ParseVersion(c.Version)
	if err != nil || c.Schema != 1 || c.Kind != "task-steps" || c.UserID != expected.UserID || c.ProjectID != expected.ProjectID || c.TaskID != expected.TaskID || c.View != expected.View || c.Position < 0 {
		return stepCursor{}, 0, invalid
	}
	return c, version, nil
}

// RegisterStepReadTools exposes bounded, version-fenced Step reads.
func RegisterStepReadTools(e *Entry, steps stepReadOperations) error {
	var tools []*sdk.Tool
	if err := json.Unmarshal(stepReadToolsJSON, &tools); err != nil {
		return fmt.Errorf("decode Step read tools: %w", err)
	}
	for _, tool := range tools {
		name := tool.Name
		err := e.registerReadTool(tool, func(raw json.RawMessage) BudgetClass {
			var in stepReadInput
			_ = json.Unmarshal(raw, &in)
			if in.View == "full" {
				return BudgetLarge
			}
			return BudgetControl
		}, func(ctx context.Context, actor RequestActor, raw json.RawMessage) (ToolResult, error) {
			if err := ValidateUnicodeFields(raw, "projectId", "taskId", "stepId", "view", "cursor"); err != nil {
				return ToolResult{}, err
			}
			var in stepReadInput
			if err := json.Unmarshal(raw, &in); err != nil {
				return ToolResult{}, &model.Fault{Code: "invalid_input", Message: "Tool arguments could not be decoded."}
			}
			if name == "task_step_list" {
				return listSteps(ctx, actor, steps, in)
			}
			return showStep(ctx, actor, steps, in)
		})
		if err != nil {
			return err
		}
	}
	return nil
}
func listSteps(ctx context.Context, actor RequestActor, steps stepReadOperations, in stepReadInput) (ToolResult, error) {
	project, err := model.CanonicalID(in.ProjectID)
	if err != nil {
		return ToolResult{}, err
	}
	task, err := model.CanonicalID(in.TaskID)
	if err != nil {
		return ToolResult{}, err
	}
	view := in.View
	if view == "" {
		view = "summary"
	}
	limit := 50
	if in.Limit != nil {
		limit = *in.Limit
	}
	cursor := stepCursor{Schema: 1, Kind: "task-steps", UserID: actor.Principal.UserID, ProjectID: project, TaskID: task, View: view}
	after := int64(-1)
	var version *int64
	if in.Cursor != nil {
		parsed, v, err := decodeStepCursor(*in.Cursor, cursor)
		if err != nil {
			return ToolResult{}, err
		}
		after = parsed.Position
		version = &v
	}
	budget := 16 << 10
	if view == "full" {
		budget = 4 << 20
	}
	out := struct {
		ProjectID  string  `json:"projectId"`
		TaskID     string  `json:"taskId"`
		Version    string  `json:"version"`
		Projection string  `json:"projection"`
		Items      []any   `json:"items"`
		NextCursor *string `json:"nextCursor"`
	}{project, task, "", view, make([]any, 0, limit), nil}
	itemsBytes := 0
	page, err := steps.ListPageAdmitted(ctx, actor.Principal, project, task, after, limit, version, view == "summary", func(header model.TaskHeader, item store.TaskStepProjection, more bool) (bool, error) {
		cursor.Version = Decimal(header.Version)
		out.Version = cursor.Version
		previousCursor := out.NextCursor
		projected := projectStep(item, view == "summary")
		if more {
			cursor.Position = item.Step.Position
			next := encodeStepCursor(cursor)
			out.NextCursor = &next
		} else {
			out.NextCursor = nil
		}
		// Measure the same envelope and individual item encoding used by the
		// final output without re-encoding the entire growing page each time.
		empty := out
		empty.Items = []any{}
		encoded, err := json.Marshal(envelope{Data: empty, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if err != nil {
			return false, err
		}
		encodedItem, err := json.Marshal(projected)
		if err != nil {
			return false, err
		}
		candidateBytes := itemsBytes + len(encodedItem)
		if len(out.Items) > 0 {
			candidateBytes++
		}
		if item.Oversized || len(encoded)+candidateBytes > budget {
			out.NextCursor = previousCursor
			if len(out.Items) == 0 {
				return false, &model.Fault{Code: "resource_limit_exceeded", Message: "Step exceeds the page budget."}
			}
			return false, nil
		}
		itemsBytes = candidateBytes
		out.Items = append(out.Items, projected)
		return true, nil
	})
	if err != nil {
		return ToolResult{}, err
	}
	out.Version = Decimal(page.Header.Version)
	return ToolResult{Data: out}, nil
}
func showStep(ctx context.Context, actor RequestActor, steps stepReadOperations, in stepReadInput) (ToolResult, error) {
	refs := map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID, "stepId": in.StepID}
	var data any
	var err error
	if in.View == "full" {
		var doc taskservice.StepDocument
		doc, err = steps.GetBounded(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID)
		if err == nil {
			data = map[string]any{"projectId": doc.Resource.ProjectID, "taskId": doc.Resource.TaskID, "version": Decimal(doc.Resource.Version), "projection": "full", "step": doc.Resource.Step}
		}
	} else {
		var doc taskservice.StepSummary
		doc, err = steps.GetSummary(ctx, actor.Principal, in.ProjectID, in.TaskID, in.StepID)
		if err == nil {
			data = map[string]any{"projectId": doc.Header.ProjectID, "taskId": doc.Header.ID, "version": Decimal(doc.Header.Version), "projection": "summary", "step": projectStep(doc.Item, true)}
		}
	}
	if err != nil {
		var absence *tasksteps.StepAbsence
		if _, ok := taskservice.TaskStepsFault(err); ok && errors.As(err, &absence) {
			refs["version"] = Decimal(absence.Version)
		}
		return ToolResult{Refs: refs}, err
	}
	if in.View == "full" {
		encoded, encodeErr := json.Marshal(envelope{Data: data, Meta: &envelopeMeta{RequestID: actor.RequestID}})
		if encodeErr != nil {
			return ToolResult{}, encodeErr
		}
		if len(encoded) > 512<<10 {
			return ToolResult{}, &model.Fault{Code: "resource_limit_exceeded", Message: "Step exceeds the single resource budget."}
		}
	}
	return ToolResult{Data: data}, nil
}
