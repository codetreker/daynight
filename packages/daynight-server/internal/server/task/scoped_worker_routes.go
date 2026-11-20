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

// RegisterScopedWorkerClaimRoutes mounts Worker claim mutations with the same
// response selection and authenticated policy used by scoped Task writes.
// Product assembly chooses when to enable these routes.
func RegisterScopedWorkerClaimRoutes(mux httpx.RouteRegistrar, tasks TaskService, auth ScopedWriteAuthentication, logger *slog.Logger) error {
	if mux == nil || tasks == nil || auth == nil || logger == nil {
		return errors.New("scoped Worker claim routes require all dependencies")
	}
	h := &taskHandler{tasks: tasks, logger: logger}
	register := func(pattern, phase string, next httpx.AuthenticatedHandler) {
		mux.HandleFunc(pattern, auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				httpx.WriteError(w, r, logger, "worker_claim", "authentication", model.Unauthenticated(err))
				return
			}
			receipt := len(r.Header.Values("Daynight-Return")) == 1 && r.Header.Get("Daynight-Return") == "receipt-v1"
			ctx := service.WithTaskWriteAuthorization(r.Context(), a, !receipt)
			ctx = context.WithValue(ctx, taskReceiptKey{}, receipt)
			declaredBot(logger, taskBotRefusal("worker_claim", phase), next)(w, r.WithContext(ctx), a.Principal)
		}))
	}
	path := "/api/v1/projects/{projectId}/tasks/{taskId}/worker-claim"
	register("POST "+path, "claim", h.claimWorker)
	register("PATCH "+path, "update", h.updateWorker)
	register("POST "+path+"/release", "release", h.releaseWorker)
	register("POST "+path+"/withdraw", "withdraw", h.withdrawWorker)
	registerScopedMethodFallback(mux, auth, logger, path, "POST, PATCH")
	registerScopedMethodFallback(mux, auth, logger, path+"/release", "POST")
	registerScopedMethodFallback(mux, auth, logger, path+"/withdraw", "POST")
	return nil
}
