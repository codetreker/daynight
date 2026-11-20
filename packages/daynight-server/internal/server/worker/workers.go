package worker

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type workersHandler struct {
	workers workerService
	logger  *slog.Logger
}

type workerService interface {
	ReviewPullRequests(context.Context, model.Principal, string, model.PageRequest) (service.ReviewPullRequestPage, error)
	ReviewParticipation(context.Context, model.Principal, string) (model.WorkerReviewParticipation, error)
	PutReviewParticipation(context.Context, model.Principal, string, string, bool) (model.WorkerReviewParticipation, error)
	Alias(context.Context, model.Principal, string) (model.WorkerAlias, error)
	PutAlias(context.Context, model.Principal, string, string, *string) (model.WorkerAlias, error)
	Report(context.Context, model.Principal, string, model.WorkerReport) (service.WorkerReportResult, error)
	ReportSync(context.Context, model.Principal, string, model.WorkerReport, []model.PromptSelector) (service.ConfigurationSyncResult, error)
	List(context.Context, model.Principal, model.PageRequest) (service.WorkerPage, error)
	Get(context.Context, model.Principal, string) (service.WorkerDetailResult, error)
	Configuration(context.Context, model.Principal, string) (model.WorkerConfigurationResource, error)
	PutConfiguration(context.Context, model.Principal, string, string, model.WorkerConfiguration) (model.WorkerConfigurationResource, error)
	PutMonitoring(context.Context, model.Principal, string, *string, monitoring.Observation) (monitoring.Receipt, error)
	SaveDirectMonitoring(context.Context, model.Principal, string, monitoring.DirectObservation) (monitoring.DirectReceipt, string, error)
	GetMonitoring(context.Context, model.Principal, string) (monitoring.DetailResponse, error)
	QueryMonitoring(context.Context, model.Principal, []string) (monitoring.QueryResponse, error)
}

type configurationSyncReceipt struct {
	ObservedAt     time.Time `json:"observedAt"`
	LastReportedAt time.Time `json:"lastReportedAt"`
	Configuration  struct {
		*WorkerConfigurationReceipt
		Prompts []model.PromptResult `json:"prompts"`
	} `json:"configuration"`
}

func syncReceipt(native service.WorkerReportResult, prompts []model.PromptResult, capabilities workerprotocol.Capabilities) configurationSyncReceipt {
	var result configurationSyncReceipt
	result.ObservedAt = native.ObservedAt.UTC()
	result.LastReportedAt = native.LastReportedAt.UTC()
	result.Configuration.WorkerConfigurationReceipt = projectConfigurationReceipt(native.Configuration, capabilities)
	result.Configuration.Prompts = prompts
	return result
}

func RegisterRoutes(mux httpx.RouteRegistrar, workers workerService, auth *authhttp.Authentication, logger *slog.Logger) {
	handler := &workersHandler{workers: workers, logger: logger}
	registerRoutes(mux, handler, auth.Require)
}

func registerRoutes(mux httpx.RouteRegistrar, handler *workersHandler, require func(httpx.AuthenticatedHandler) http.HandlerFunc) {
	registerRoutesObserved(mux, handler, require, nil)
}

func registerRoutesObserved(mux httpx.RouteRegistrar, handler *workersHandler, require func(httpx.AuthenticatedHandler) http.HandlerFunc, observe func(ScopeRoute)) {
	logger := handler.logger
	routes := routeRegistry{mux: mux, observe: observe}
	registerLifecycleRoutes(routes, handler, require)
	base := "/api/v1/me/workers"
	routes.handle("GET "+base+"/{workerId}/review-pull-requests", require(handler.reviewPullRequests), routeReviewRead)
	routes.handle(base+"/{workerId}/review-pull-requests", require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")), routeFallback)
	routes.handle("GET "+base+"/{workerId}/review-participation", require(handler.reviewParticipation), routeRead)
	routes.handle("PUT "+base+"/{workerId}/review-participation", require(handler.reviewParticipation), routeConfigure)
	routes.handle(base+"/{workerId}/review-participation", require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PUT")), routeFallback)
	routes.handle("GET "+base+"/{workerId}/alias", require(handler.alias), routeRead)
	routes.handle("PUT "+base+"/{workerId}/alias", require(handler.alias), routeConfigure)
	routes.handle(base+"/{workerId}/alias", require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PUT")), routeFallback)
	routes.handle("POST "+base+"/monitoring/query", require(handler.queryMonitoring), routeRead)
	routes.handle(base+"/monitoring/query", require(httpx.ResourceMethodNotAllowed(logger, "POST")), routeFallback)
	routes.handle("GET "+base+"/{workerId}/monitoring", require(handler.getMonitoring), routeReadNoHead)
	routes.handle("HEAD "+base+"/{workerId}/monitoring", require(httpx.ResourceMethodNotAllowed(logger, "GET, PUT, POST")), routeFallback)
	routes.handle("PUT "+base+"/{workerId}/monitoring", require(handler.putMonitoring), routeProduce)
	routes.handle("POST "+base+"/{workerId}/monitoring", require(handler.postMonitoring), routeProduce)
	routes.handle(base+"/{workerId}/monitoring", require(httpx.ResourceMethodNotAllowed(logger, "GET, PUT, POST")), routeFallback)
	routes.handle("GET "+base+"/{workerId}/configuration", require(handler.configuration), routeRead)
	routes.handle("PUT "+base+"/{workerId}/configuration", require(handler.configuration), routeConfigure)
	routes.handle(base+"/{workerId}/configuration", require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PUT")), routeFallback)
	routes.handle("POST "+base+"/{workerId}/report", require(handler.report), routeReport)
	routes.handle(base+"/{workerId}/report", require(httpx.ResourceMethodNotAllowed(logger, "POST")), routeFallback)
	routes.handle("GET "+base, require(handler.list), routeRead)
	routes.handle(base, require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")), routeFallback)
	routes.handle("GET "+base+"/{workerId}", require(handler.get), routeRead)
	routes.handle(base+"/{workerId}", require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")), routeFallback)
}

func (h *workersHandler) resource(request *http.Request, principal model.Principal) (string, *slog.Logger, error) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := model.CanonicalID(request.PathValue("workerId"))
	if err != nil {
		return "", logger, err
	}
	return id, logger.With("worker_id", id), nil
}

func (h *workersHandler) report(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker reports do not accept query parameters")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "validate", err)
		return
	}
	allowed := append([]string(nil), workerReportFields...)
	protocol, selectors, err := promptProtocol(request.Header)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "validate", err)
		return
	}
	configurationAware := protocol != ""
	capabilities, err := workerCapabilities(request.Header)
	if err == nil {
		err = requireToolPaths(capabilities)
	}
	if err == nil && capabilities.ArchiveSessions && !configurationAware {
		err = httpx.InvalidInput("Worker extensions require the configuration protocol.")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "validate", err)
		return
	}
	if capabilities.ToolPaths {
		allowed = append(allowed, "toolPaths")
	}
	if configurationAware {
		allowed = append(allowed, "configuration")
	}
	limit := int64(transport.MaxRESTJSONBodyBytes)
	if configurationAware {
		limit = transport.MaxWorkerConfigurationReportBytes
	}
	fields, err := httpx.DecodeObjectLimit(w, request, limit, allowed...)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "validate", err)
		return
	}
	input, err := workerReportInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "validate", err)
		return
	}
	if configurationAware {
		input.Configuration, err = workercore.ParseWorkerConfigurationExchangeProtocol(fields["configuration"], capabilities)
		if err != nil {
			httpx.WriteError(w, request, logger, "worker_report", "validate", err)
			return
		}
	}
	var result service.WorkerReportResult
	var prompts []model.PromptResult
	if protocol == "2" {
		var syncResult service.ConfigurationSyncResult
		syncResult, err = h.workers.ReportSync(request.Context(), principal, id, input, selectors)
		result, prompts = syncResult.Native, syncResult.Prompts
	} else {
		result, err = h.workers.Report(request.Context(), principal, id, input)
	}
	if err != nil {
		phase := "persist"
		if fault, ok := httpx.KnownFault(err); ok && fault.Code == "invalid_input" {
			phase = "validate"
		}
		httpx.WriteError(w, request, logger, "worker_report", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "worker report saved", "type", "resource", "component", "worker_report", "phase", "persist", "request_id", httpx.RequestID(request.Context()))
	writeWorkerCapabilities(w.Header(), capabilities)
	if protocol == "2" {
		w.Header().Set(workerConfigurationHeader, "2")
		httpx.WriteJSON(w, request, logger, http.StatusOK, syncReceipt(result, prompts, capabilities))
		return
	}
	if configurationAware {
		w.Header().Set(workerConfigurationHeader, "1")
		httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
			ObservedAt     time.Time                   `json:"observedAt"`
			LastReportedAt time.Time                   `json:"lastReportedAt"`
			Configuration  *WorkerConfigurationReceipt `json:"configuration"`
		}{result.ObservedAt.UTC(), result.LastReportedAt.UTC(), projectConfigurationReceipt(result.Configuration, capabilities)})
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.WorkerReportResponse{ObservedAt: result.ObservedAt.UTC(), LastReportedAt: result.LastReportedAt.UTC()})
}

func (h *workersHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := httpx.PageRequest(request)
	var aliases bool
	if err == nil {
		aliases, err = aliasProtocol(request.Header)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	result, err := h.workers.List(request.Context(), principal, page)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	response := api.WorkerPage{ObservedAt: result.ObservedAt.UTC(), Items: result.Items, NextCursor: result.NextCursor}
	if aliases {
		w.Header().Set(workerAliasHeader, "1")
		for i := range response.Items {
			response.Items[i].Alias = workerprotocol.ProjectAlias(result.Aliases[i])
		}
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *workersHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	var aliases bool
	if err == nil {
		aliases, err = aliasProtocol(request.Header)
	}
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker detail does not accept query parameters")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	capabilities, err := workerCapabilities(request.Header)
	if err == nil {
		err = requireToolPaths(capabilities)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	writeWorkerCapabilities(w.Header(), capabilities)
	result, err := h.workers.Get(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	detail := workerprotocol.DetailForCapabilities(result.Worker, capabilities)
	if aliases {
		w.Header().Set(workerAliasHeader, "1")
		detail.Alias = workerprotocol.ProjectAlias(result.Worker.Alias)
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.WorkerDetailResponse{ObservedAt: result.ObservedAt.UTC(), Worker: detail})
}

func workerDetailResponse(worker model.WorkerSnapshot) api.WorkerDetail {
	return workerprotocol.Detail(worker)
}
