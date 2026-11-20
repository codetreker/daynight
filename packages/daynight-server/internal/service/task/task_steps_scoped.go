package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopedTaskSteps enforces the request's authenticated policy while retaining
// the existing project transaction, version and role checks. Existing mutation
// responses expose the complete collection, so they also require StepRead.
type ScopedTaskSteps struct {
	store    StepsStore
	capturer Capturer
}

func NewScopedTaskSteps(database StepsStore, capture ...Capturer) *ScopedTaskSteps {
	return &ScopedTaskSteps{store: database, capturer: capturer(capture)}
}

func (s *ScopedTaskSteps) authorized(auth model.CredentialAuthorization) *TaskSteps {
	steps := NewTaskSteps(s.store, s.capturer)
	steps.admit = func(ops ...scopepolicy.Operation) error { return scopeadmission.Require(auth, ops...) }
	return steps
}

func (s *ScopedTaskSteps) List(ctx context.Context, a model.CredentialAuthorization, project, task string) (StepsDocument, error) {
	return s.authorized(a).List(ctx, a.Principal, project, task)
}
func (s *ScopedTaskSteps) Get(ctx context.Context, a model.CredentialAuthorization, project, task, step string) (StepDocument, error) {
	return s.authorized(a).Get(ctx, a.Principal, project, task, step)
}
func (s *ScopedTaskSteps) ListPage(ctx context.Context, a model.CredentialAuthorization, project, task string, after int64, limit int, version *int64, summary bool) (StepsPage, error) {
	return s.authorized(a).ListPage(ctx, a.Principal, project, task, after, limit, version, summary)
}
func (s *ScopedTaskSteps) GetSummary(ctx context.Context, a model.CredentialAuthorization, project, task, step string) (StepSummary, error) {
	return s.authorized(a).GetSummary(ctx, a.Principal, project, task, step)
}
func (s *ScopedTaskSteps) Add(ctx context.Context, a model.CredentialAuthorization, project, task string, input AddTaskStep) (StepsWriteResult, error) {
	return s.authorized(a).Add(ctx, a.Principal, project, task, input)
}
func (s *ScopedTaskSteps) Update(ctx context.Context, a model.CredentialAuthorization, project, task, step string, input UpdateTaskStep) (StepsWriteResult, error) {
	return s.authorized(a).Update(ctx, a.Principal, project, task, step, input)
}
func (s *ScopedTaskSteps) SetStatus(ctx context.Context, a model.CredentialAuthorization, project, task, step string, input SetTaskStepStatus) (StepsWriteResult, error) {
	return s.authorized(a).SetStatus(ctx, a.Principal, project, task, step, input)
}
func (s *ScopedTaskSteps) Move(ctx context.Context, a model.CredentialAuthorization, project, task, step string, input MoveTaskStep) (StepsWriteResult, error) {
	return s.authorized(a).Move(ctx, a.Principal, project, task, step, input)
}
func (s *ScopedTaskSteps) Delete(ctx context.Context, a model.CredentialAuthorization, project, task, step string, input DeleteTaskStep) (StepsWriteResult, error) {
	return s.authorized(a).Delete(ctx, a.Principal, project, task, step, input)
}
