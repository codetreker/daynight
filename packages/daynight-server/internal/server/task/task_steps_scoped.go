package task

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"log/slog"
	"net/http"
)

type ScopedStepService interface {
	List(_ context.Context, _ model.CredentialAuthorization, project, task string) (taskservice.StepsDocument, error)
	Get(_ context.Context, _ model.CredentialAuthorization, project, task, step string) (taskservice.StepDocument, error)
	Add(_ context.Context, _ model.CredentialAuthorization, project, task string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error)
	Update(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error)
	SetStatus(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error)
	Move(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error)
	Delete(_ context.Context, _ model.CredentialAuthorization, project, task, step string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error)
}

type ScopedStepAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}
type stepAuthorizationKey struct{}
type scopedStepAuthentication struct{ auth ScopedStepAuthentication }

func (a scopedStepAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, auth model.CredentialAuthorization) {
		next(w, r.WithContext(context.WithValue(r.Context(), stepAuthorizationKey{}, auth)), auth.Principal)
	})
}

type scopedStepAdapter struct{ steps ScopedStepService }

func stepAuthorization(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	a, ok := ctx.Value(stepAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok || a.Principal != p || a.Validate() != nil {
		return model.CredentialAuthorization{}, errors.New("scoped Step authorization unavailable")
	}
	return a, nil
}
func (s scopedStepAdapter) List(ctx context.Context, p model.Principal, project, task string) (taskservice.StepsDocument, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsDocument{}, err
	}
	return s.steps.List(ctx, a, project, task)
}
func (s scopedStepAdapter) Get(ctx context.Context, p model.Principal, project, task, step string) (taskservice.StepDocument, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepDocument{}, err
	}
	return s.steps.Get(ctx, a, project, task, step)
}
func (s scopedStepAdapter) Add(ctx context.Context, p model.Principal, project, task string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Add(ctx, a, project, task, input)
}
func (s scopedStepAdapter) Update(ctx context.Context, p model.Principal, project, task, step string, input taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Update(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) SetStatus(ctx context.Context, p model.Principal, project, task, step string, input taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.SetStatus(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) Move(ctx context.Context, p model.Principal, project, task, step string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Move(ctx, a, project, task, step, input)
}
func (s scopedStepAdapter) Delete(ctx context.Context, p model.Principal, project, task, step string, input taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	a, err := stepAuthorization(ctx, p)
	if err != nil {
		return taskservice.StepsWriteResult{}, err
	}
	return s.steps.Delete(ctx, a, project, task, step, input)
}

// TaskStepsScopedRoutes mounts the existing protocol with scoped admission.
func TaskStepsScopedRoutes(mux httpx.RouteRegistrar, steps ScopedStepService, auth ScopedStepAuthentication, logger *slog.Logger, observe ...func(StepScopeRoute)) {
	var observer func(StepScopeRoute)
	if len(observe) > 0 {
		observer = observe[0]
	}
	registerTaskStepsRoutes(mux, scopedStepAdapter{steps}, scopedStepAuthentication{auth}, logger, observer)
}
