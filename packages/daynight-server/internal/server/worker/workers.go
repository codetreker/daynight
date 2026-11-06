package worker

import (
	"log/slog"
	"net/http"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type workersHandler struct {
	workers *service.Workers
	logger  *slog.Logger
}

func RegisterRoutes(mux *http.ServeMux, workers *service.Workers, auth *authhttp.Authentication, logger *slog.Logger) {
	handler := &workersHandler{workers: workers, logger: logger}
	base := "/api/v1/me/workers"
	mux.HandleFunc("GET "+base+"/{workerId}/configuration", auth.Require(handler.configuration))
	mux.HandleFunc("PUT "+base+"/{workerId}/configuration", auth.Require(handler.configuration))
	mux.HandleFunc(base+"/{workerId}/configuration", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PUT")))
	mux.HandleFunc("POST "+base+"/{workerId}/report", auth.Require(handler.report))
	mux.HandleFunc(base+"/{workerId}/report", auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("GET "+base, auth.Require(handler.list))
	mux.HandleFunc(base, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("GET "+base+"/{workerId}", auth.Require(handler.get))
	mux.HandleFunc(base+"/{workerId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
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
	configurationAware := false
	if values, exists := request.Header[workerConfigurationHeader]; exists {
		if len(values) != 1 || values[0] != "1" {
			httpx.WriteError(w, request, logger, "worker_report", "validate", httpx.InvalidInput("Unsupported Worker configuration protocol."))
			return
		}
		configurationAware = true
		allowed = append(allowed, "configuration")
	}
	fields, err := httpx.DecodeObject(w, request, allowed...)
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
		input.Configuration, err = workercore.ParseWorkerConfigurationExchange(fields["configuration"])
		if err != nil {
			httpx.WriteError(w, request, logger, "worker_report", "validate", err)
			return
		}
	}
	result, err := h.workers.Report(request.Context(), principal, id, input)
	if err != nil {
		phase := "persist"
		if fault, ok := httpx.KnownFault(err); ok && fault.Code == "invalid_input" {
			phase = "validate"
		}
		httpx.WriteError(w, request, logger, "worker_report", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "worker report saved", "type", "resource", "component", "worker_report", "phase", "persist", "request_id", httpx.RequestID(request.Context()))
	if configurationAware {
		w.Header().Set(workerConfigurationHeader, "1")
		httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
			ObservedAt     time.Time                         `json:"observedAt"`
			LastReportedAt time.Time                         `json:"lastReportedAt"`
			Configuration  *model.WorkerConfigurationReceipt `json:"configuration"`
		}{result.ObservedAt.UTC(), result.LastReportedAt.UTC(), result.Configuration})
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.WorkerReportResponse{ObservedAt: result.ObservedAt.UTC(), LastReportedAt: result.LastReportedAt.UTC()})
}

func (h *workersHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := httpx.PageRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	result, err := h.workers.List(request.Context(), principal, page)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	response := api.WorkerPage{ObservedAt: result.ObservedAt.UTC(), Items: make([]api.WorkerSummary, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, worker := range result.Items {
		response.Items = append(response.Items, workerSummaryResponse(worker))
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func (h *workersHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker detail does not accept query parameters")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	result, err := h.workers.Get(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_report", "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, api.WorkerDetailResponse{ObservedAt: result.ObservedAt.UTC(), Worker: workerDetailResponse(result.Worker)})
}

func workerSummaryResponse(worker model.WorkerSnapshot) api.WorkerSummary {
	projection := workercore.ProjectSnapshot(worker)
	return api.WorkerSummary{WorkerID: worker.WorkerID,
		Machine: api.WorkerMachine{ID: worker.Telemetry.Machine.ID, Name: worker.Telemetry.Machine.Name}, Platform: string(worker.Telemetry.Platform),
		LastReportedAt: worker.LastReportedAt.UTC(), TaskObservationState: string(worker.TaskSnapshot.State),
		TaskObservedAt: workerOptionalTime(worker.TaskSnapshot.ObservedAt), ActiveTaskCount: projection.ActiveTaskCount}
}

func workerDetailResponse(worker model.WorkerSnapshot) api.WorkerDetail {
	telemetry := worker.Telemetry
	response := api.WorkerDetail{WorkerSummary: workerSummaryResponse(worker), InventoryObservedAt: workerOptionalTime(worker.TaskSnapshot.InventoryObservedAt), Tasks: make([]api.WorkerTaskSnapshot, 0, len(worker.TaskSnapshot.Items)),
		Telemetry: api.WorkerTelemetry{Machine: api.WorkerMachine{ID: telemetry.Machine.ID, Name: telemetry.Machine.Name}, Platform: string(telemetry.Platform),
			WorkingDirectory: telemetry.WorkingDirectory, SampledAt: telemetry.SampledAt.UTC(), AssistantHost: workerAssistantHostResponse(telemetry.AssistantHost), RuntimeConfiguration: workerRuntimeConfigurationResponse(telemetry.RuntimeConfiguration),
			OS:     workerProbeResponse(telemetry.OS, func(value model.WorkerOS) api.WorkerOS { return api.WorkerOS(value) }),
			CPU:    workerProbeResponse(telemetry.CPU, func(value model.WorkerCPU) api.WorkerCPU { return api.WorkerCPU(value) }),
			Memory: workerProbeResponse(telemetry.Memory, func(value model.WorkerMemory) api.WorkerMemory { return api.WorkerMemory(value) }),
			Disk:   workerProbeResponse(telemetry.Disk, func(value model.WorkerDisk) api.WorkerDisk { return api.WorkerDisk(value) }),
			Versions: api.WorkerVersions{Daynight: telemetry.Versions.Daynight,
				Herdr:   workerProbeResponse(telemetry.Versions.Herdr, func(value string) string { return value }),
				Codex:   workerProbeResponse(telemetry.Versions.Codex, func(value string) string { return value }),
				Copilot: workerProbeResponse(telemetry.Versions.Copilot, func(value string) string { return value })}}}
	for _, task := range worker.TaskSnapshot.Items {
		response.Tasks = append(response.Tasks, api.WorkerTaskSnapshot{ProjectID: task.ProjectID, TaskID: task.TaskID, ClaimID: task.ClaimID, Title: task.Title, ProjectName: task.ProjectName, Status: string(task.Status), Phase: string(task.Phase), Agent: string(task.Agent)})
	}
	return response
}

func workerProbeResponse[S, T any](probe model.WorkerProbe[S], convert func(S) T) api.WorkerProbe[T] {
	response := api.WorkerProbe[T]{State: probe.State, CheckedAt: probe.CheckedAt.UTC(), Code: probe.Code}
	if probe.Value != nil {
		value := convert(*probe.Value)
		response.Value = &value
	}
	return response
}

func workerOptionalTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func workerAssistantHostResponse(host *model.WorkerAssistantHost) *api.WorkerAssistantHost {
	if host == nil {
		return nil
	}
	response := &api.WorkerAssistantHost{ProtocolVersion: host.ProtocolVersion, ObservedAt: host.ObservedAt.UTC(), DefaultCwd: host.DefaultCwd, DefaultProvider: string(host.DefaultProvider), Providers: make([]api.WorkerAssistantProvider, 0, len(host.Providers))}
	for _, provider := range host.Providers {
		response.Providers = append(response.Providers, api.WorkerAssistantProvider{Provider: string(provider.Provider), Available: provider.Available, Reason: provider.Reason, Model: provider.Model, Args: provider.Args})
	}
	return response
}
