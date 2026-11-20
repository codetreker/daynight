package task

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

// ScopedWriteAuthentication supplies the policy from the same authentication
// read as the principal. Its implementation retains the existing origin policy.
type ScopedWriteAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

type taskReceiptKey struct{}

func taskReceiptRequested(ctx context.Context) bool {
	v, _ := ctx.Value(taskReceiptKey{}).(bool)
	return v
}

// RegisterScopedWriteRoutes mounts only Task mutation routes. Read and Worker
// routes have separate scoped owners and must be registered by their assembly.
func RegisterScopedWriteRoutes(mux httpx.RouteRegistrar, tasks TaskService, goals GoalDependencyService, auth ScopedWriteAuthentication, logger *slog.Logger) error {
	if mux == nil || tasks == nil || goals == nil || auth == nil || logger == nil {
		return errors.New("scoped Task write routes require all dependencies")
	}
	h := &taskHandler{tasks: tasks, logger: logger}
	g := &goalDependencyHandler{service: goals, logger: logger}
	register := func(pattern string, projected bool, next httpx.AuthenticatedHandler) {
		mux.HandleFunc(pattern, auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				httpx.WriteError(w, r, logger, "task", "authentication", model.Unauthenticated(err))
				return
			}
			receipt := projected && len(r.Header.Values("Daynight-Return")) == 1 && r.Header.Get("Daynight-Return") == "receipt-v1"
			ctx := service.WithTaskWriteAuthorization(r.Context(), a, projected && !receipt)
			ctx = context.WithValue(ctx, taskReceiptKey{}, receipt)
			next(w, r.WithContext(ctx), a.Principal)
		}))
	}
	register("POST /api/v1/projects/{projectId}/tasks", true, declaredBot(logger, taskBotRefusal("task", "create"), h.create))
	register("PATCH /api/v1/projects/{projectId}/tasks/{taskId}", true, declaredBot(logger, taskBotRefusal("task", "update"), h.update))
	register("DELETE /api/v1/projects/{projectId}/tasks/{taskId}", false, declaredBot(logger, taskBotRefusal("task", "delete"), h.delete))
	register("PUT /api/v1/projects/{projectId}/tasks/{taskId}/status", true, declaredBot(logger, taskBotRefusal("task", "set_status"), h.setStatus))
	register("PUT /api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}", true, declaredBot(logger, taskBotRefusal("task_property", "set"), h.setProperty))
	register("DELETE /api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}", true, declaredBot(logger, taskBotRefusal("task_property", "remove"), h.removeProperty))
	register("PATCH /api/v1/projects/{projectId}/tasks/{taskId}/goal-dependencies", false, g.edit)
	registerScopedMethodFallback(mux, auth, logger, "/api/v1/projects/{projectId}/tasks/{taskId}/status", "PUT")
	registerScopedMethodFallback(mux, auth, logger, "/api/v1/projects/{projectId}/tasks/{taskId}/properties/{name}", "PUT, DELETE")
	return nil
}

func registerScopedMethodFallback(mux httpx.RouteRegistrar, auth ScopedWriteAuthentication, logger *slog.Logger, path, allow string) {
	mux.HandleFunc(path, auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
		httpx.ResourceMethodNotAllowed(logger, allow)(w, r, a.Principal)
	}))
}

type taskMutationReceipt struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
	Version   int64  `json:"version"`
}

func writeTaskReceipt(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component string, status int, task model.Task) {
	w.Header().Set("Daynight-Return", "receipt-v1")
	httpx.WriteMutationJSON(w, r, logger.With("tx_outcome", "committed"), component, status, taskMutationReceipt{ProjectID: task.ProjectID, TaskID: task.ID, Version: task.Version})
}
