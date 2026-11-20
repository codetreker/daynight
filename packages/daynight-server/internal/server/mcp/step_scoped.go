package mcp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type ScopedStepOperations interface {
	List(_ context.Context, _ model.CredentialAuthorization, project, task string) (taskservice.StepsDocument, error)
	Get(_ context.Context, _ model.CredentialAuthorization, project, task, step string) (taskservice.StepDocument, error)
	ListPage(_ context.Context, _ model.CredentialAuthorization, project, task string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error)
	GetSummary(_ context.Context, _ model.CredentialAuthorization, project, task, step string) (taskservice.StepSummary, error)
	Add(_ context.Context, _ model.CredentialAuthorization, project, task string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	Update(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatus(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	Move(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
	Delete(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
}

type scopedStepAdapter struct{ steps ScopedStepOperations }

func (s scopedStepAdapter) List(ctx context.Context, p model.Principal, project, task string) (taskservice.StepsDocument, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsDocument{}, err
	}
	return s.steps.List(ctx, a, project, task)
}
func (s scopedStepAdapter) Get(ctx context.Context, p model.Principal, project, task, step string) (taskservice.StepDocument, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepDocument{}, err
	}
	return s.steps.Get(ctx, a, project, task, step)
}
func (s scopedStepAdapter) ListPage(ctx context.Context, p model.Principal, project, task string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsPage{}, err
	}
	return s.steps.ListPage(ctx, a, project, task, after, limit, version, summary)
}
func (s scopedStepAdapter) GetSummary(ctx context.Context, p model.Principal, project, task, step string) (taskservice.StepSummary, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepSummary{}, err
	}
	return s.steps.GetSummary(ctx, a, project, task, step)
}
func (s scopedStepAdapter) Add(ctx context.Context, p model.Principal, project, task string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Add(ctx, a, project, task, input)
}
func (s scopedStepAdapter) Update(ctx context.Context, p model.Principal, project, task, step string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Update(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) SetStatus(ctx context.Context, p model.Principal, project, task, step string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.SetStatus(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) Move(ctx context.Context, p model.Principal, project, task, step string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Move(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) Delete(ctx context.Context, p model.Principal, project, task, step string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Delete(ctx, a, project, task, step, input)
}

type StepScopeTool struct {
	Name       string
	Operations []scopepolicy.Operation
}

// RegisterScopedStepTools registers the same schemas with an explicit policy
// snapshot for each call. The original registration remains unchanged.
func RegisterScopedStepTools(e *Entry, steps ScopedStepOperations, observe ...func(StepScopeTool)) error {
	if e == nil || steps == nil {
		return fmt.Errorf("scoped Step dependencies are required")
	}
	var definitions []*sdk.Tool
	if err := json.Unmarshal(stepReadToolsJSON, &definitions); err != nil {
		return err
	}
	var writes []*sdk.Tool
	if err := json.Unmarshal(stepWriteToolsJSON, &writes); err != nil {
		return err
	}
	definitions = append(definitions, writes...)
	for _, tool := range definitions {
		if e.toolNames[tool.Name] {
			return fmt.Errorf("duplicate MCP tool %q", tool.Name)
		}
	}
	adapter := scopedStepAdapter{steps: steps}
	if err := RegisterStepReadTools(e, adapter); err != nil {
		return err
	}
	if err := RegisterStepWriteTools(e, adapter); err != nil {
		return err
	}
	if e.scopedTools == nil {
		e.scopedTools = make(map[string]bool)
	}
	for i, tool := range definitions {
		e.scopedTools[tool.Name] = true
		if len(observe) > 0 && observe[0] != nil {
			operations := []scopepolicy.Operation{scopepolicy.StepRead}
			if i >= len(definitions)-len(writes) {
				operations = []scopepolicy.Operation{scopepolicy.StepWrite, scopepolicy.StepRead}
			}
			observe[0](StepScopeTool{Name: tool.Name, Operations: operations})
		}
	}
	return nil
}
