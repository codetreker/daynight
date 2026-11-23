package worker

import (
	"context"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const lifecycleHeader = "X-Daynight-Worker-Lifecycle"

type lifecycleService interface {
	Lifecycle(context.Context, model.Principal, string) (model.LifecycleResource, error)
	LifecycleOperation(context.Context, model.Principal, string, string) (model.LifecycleOperationResult, error)
	RegisterLifecycle(context.Context, model.Principal, string, model.LifecycleInstanceRequest) (model.LifecycleInstanceReceipt, error)
	SetLifecycleIntent(context.Context, model.Principal, string, model.LifecycleIntentRequest) (model.LifecycleIntentReceipt, error)
	ActivateLifecycle(context.Context, model.Principal, string, model.LifecycleActivationRequest) (model.LifecycleActivationReceipt, error)
	ObserveLifecycle(context.Context, model.Principal, string, model.LifecycleObservationEnvelope) (model.LifecycleObservationReceipt, error)
	ResolveLifecycle(context.Context, model.Principal, string, string, model.LifecycleResolveRequest) (model.LifecycleOperationResult, error)
}

func registerLifecycleRoutes(routes routeRegistry, h *workersHandler, require func(httpx.AuthenticatedHandler) http.HandlerFunc) {
	base := "/api/v1/me/workers/{workerId}/lifecycle"
	for _, r := range []struct {
		suffix, method string
		class          routeClass
	}{
		{"", "GET", routeRead},
		{"/operations/{operationId}", "GET", routeRead},
		{"/instances", "POST", routeLifecycleReport},
		{"/operations", "POST", routeConfigure},
		{"/observations", "POST", routeLifecycleReport},
		{"/activations", "POST", routeLifecycleReport},
		{"/operations/{operationId}/resolve", "POST", routeLifecycleResolve},
	} {
		routes.handle(r.method+" "+base+r.suffix, require(h.lifecycle), r.class)
		allow := r.method
		if r.method == "GET" {
			allow = "GET, HEAD"
		}
		routes.handle(base+r.suffix, require(httpx.ResourceMethodNotAllowed(h.logger, allow)), routeFallback)
	}
}

func (h *workersHandler) lifecycle(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, logger, err := h.resource(r, p)
	if err == nil && (r.URL.RawQuery != "" || r.URL.ForceQuery) {
		err = httpx.InvalidInput("Worker lifecycle does not accept query parameters.")
	}
	if err == nil {
		values := r.Header.Values(lifecycleHeader)
		if len(values) > 1 || len(values) == 1 && values[0] != "1" {
			err = &model.Fault{Code: "lifecycle_unsupported", Message: "Worker lifecycle protocol version is unsupported."}
		}
	}
	if err != nil {
		httpx.WriteError(w, r, logger, "worker_lifecycle", "validate", err)
		return
	}
	w.Header().Set(lifecycleHeader, "1")
	s, ok := h.workers.(lifecycleService)
	if !ok {
		httpx.WriteError(w, r, logger, "worker_lifecycle", "exchange", &model.Fault{Code: "lifecycle_unavailable", Message: "Worker lifecycle is unavailable."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	var result any
	status := http.StatusOK
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if operation := r.PathValue("operationId"); operation != "" {
			result, err = s.LifecycleOperation(ctx, p, id, operation)
		} else {
			result, err = s.Lifecycle(ctx, p, id)
		}
	} else {
		var body []byte
		body, err = httpx.ReadJSONBodyLimit(w, r, 256*1024, transport.JSONBodyReadTimeout)
		if err == nil {
			switch r.Pattern {
			case "POST /api/v1/me/workers/{workerId}/lifecycle/instances":
				var input model.LifecycleInstanceRequest
				input, err = workerprotocol.ParseLifecycleInstance(body)
				if err == nil {
					result, err = s.RegisterLifecycle(ctx, p, id, input)
				}
			case "POST /api/v1/me/workers/{workerId}/lifecycle/operations":
				var input model.LifecycleIntentRequest
				input, err = workerprotocol.ParseLifecycleIntent(body)
				if err == nil {
					result, err = s.SetLifecycleIntent(ctx, p, id, input)
					status = http.StatusAccepted
				}
			case "POST /api/v1/me/workers/{workerId}/lifecycle/observations":
				var input model.LifecycleObservationEnvelope
				input, err = workerprotocol.ParseLifecycleObservation(body)
				if err == nil {
					result, err = s.ObserveLifecycle(ctx, p, id, input)
				}
			case "POST /api/v1/me/workers/{workerId}/lifecycle/activations":
				var input model.LifecycleActivationRequest
				input, err = workerprotocol.ParseLifecycleActivation(body)
				if err == nil {
					result, err = s.ActivateLifecycle(ctx, p, id, input)
				}
			case "POST /api/v1/me/workers/{workerId}/lifecycle/operations/{operationId}/resolve":
				var input model.LifecycleResolveRequest
				input, err = workerprotocol.ParseLifecycleResolve(body)
				if err == nil {
					result, err = s.ResolveLifecycle(ctx, p, id, r.PathValue("operationId"), input)
				}
			}
		}
	}
	if err != nil {
		httpx.WriteError(w, r, logger, "worker_lifecycle", "exchange", err)
		return
	}
	if r.Method == http.MethodPost {
		httpx.WriteMutationJSON(w, r, logger, "worker_lifecycle", status, result)
	} else {
		httpx.WriteJSON(w, r, logger, status, result)
	}
}
