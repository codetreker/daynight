package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type workersHandler struct {
	workers *service.Workers
	logger  *slog.Logger
}

func workersRoutes(mux *http.ServeMux, workers *service.Workers, auth *Authentication, logger *slog.Logger) {
	handler := &workersHandler{workers: workers, logger: logger}
	base := "/api/v1/me/workers"
	mux.HandleFunc("POST "+base+"/{workerId}/report", auth.Require(handler.report))
	mux.HandleFunc(base+"/{workerId}/report", auth.Require(resourceMethodNotAllowed(logger, "POST")))
	mux.HandleFunc("GET "+base, auth.Require(handler.list))
	mux.HandleFunc(base, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("GET "+base+"/{workerId}", auth.Require(handler.get))
	mux.HandleFunc(base+"/{workerId}", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
}

func (h *workersHandler) resource(request *http.Request, principal core.Principal) (string, *slog.Logger, error) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := service.CanonicalID(request.PathValue("workerId"))
	if err != nil {
		return "", logger, err
	}
	return id, logger.With("worker_id", id), nil
}

func (h *workersHandler) report(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = invalidInput("worker reports do not accept query parameters")
	}
	if err != nil {
		writeError(w, request, logger, "worker_report", "validate", err)
		return
	}
	fields, err := decodeObject(w, request, workerReportFields...)
	if err != nil {
		writeError(w, request, logger, "worker_report", "validate", err)
		return
	}
	input, err := workerReportInput(fields)
	if err != nil {
		writeError(w, request, logger, "worker_report", "validate", err)
		return
	}
	result, err := h.workers.Report(request.Context(), principal, id, input)
	if err != nil {
		phase := "persist"
		if fault, ok := knownFault(err); ok && fault.Code == "invalid_input" {
			phase = "validate"
		}
		writeError(w, request, logger, "worker_report", phase, err)
		return
	}
	logger.InfoContext(request.Context(), "worker report saved", "type", "resource", "component", "worker_report", "phase", "persist", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, http.StatusOK, api.WorkerReportResponse{ObservedAt: result.ObservedAt.UTC(), LastReportedAt: result.LastReportedAt.UTC()})
}

func (h *workersHandler) list(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := pageRequest(request)
	if err != nil {
		writeError(w, request, logger, "worker_report", "read", err)
		return
	}
	result, err := h.workers.List(request.Context(), principal, page)
	if err != nil {
		writeError(w, request, logger, "worker_report", "read", err)
		return
	}
	response := api.WorkerPage{ObservedAt: result.ObservedAt.UTC(), Items: make([]api.WorkerSummary, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, worker := range result.Items {
		response.Items = append(response.Items, workerSummaryResponse(worker))
	}
	writeJSON(w, request, logger, http.StatusOK, response)
}

func (h *workersHandler) get(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = invalidInput("worker detail does not accept query parameters")
	}
	if err != nil {
		writeError(w, request, logger, "worker_report", "read", err)
		return
	}
	result, err := h.workers.Get(request.Context(), principal, id)
	if err != nil {
		writeError(w, request, logger, "worker_report", "read", err)
		return
	}
	writeJSON(w, request, logger, http.StatusOK, api.WorkerDetailResponse{ObservedAt: result.ObservedAt.UTC(), Worker: workerDetailResponse(result.Worker)})
}

func workerSummaryResponse(worker core.WorkerSnapshot) api.WorkerSummary {
	var count *int
	if worker.TaskSnapshot.State != core.WorkerTasksUnavailable {
		value := len(worker.TaskSnapshot.Items)
		count = &value
	}
	return api.WorkerSummary{WorkerID: worker.WorkerID,
		Machine: api.WorkerMachine{ID: worker.Telemetry.Machine.ID, Name: worker.Telemetry.Machine.Name}, Platform: string(worker.Telemetry.Platform),
		LastReportedAt: worker.LastReportedAt.UTC(), TaskObservationState: string(worker.TaskSnapshot.State),
		TaskObservedAt: workerOptionalTime(worker.TaskSnapshot.ObservedAt), ActiveTaskCount: count}
}

func workerDetailResponse(worker core.WorkerSnapshot) api.WorkerDetail {
	telemetry := worker.Telemetry
	response := api.WorkerDetail{WorkerSummary: workerSummaryResponse(worker), InventoryObservedAt: workerOptionalTime(worker.TaskSnapshot.InventoryObservedAt), Tasks: make([]api.WorkerTaskSnapshot, 0, len(worker.TaskSnapshot.Items)),
		Telemetry: api.WorkerTelemetry{Machine: api.WorkerMachine{ID: telemetry.Machine.ID, Name: telemetry.Machine.Name}, Platform: string(telemetry.Platform),
			WorkingDirectory: telemetry.WorkingDirectory, SampledAt: telemetry.SampledAt.UTC(),
			OS:     workerProbeResponse(telemetry.OS, func(value core.WorkerOS) api.WorkerOS { return api.WorkerOS(value) }),
			CPU:    workerProbeResponse(telemetry.CPU, func(value core.WorkerCPU) api.WorkerCPU { return api.WorkerCPU(value) }),
			Memory: workerProbeResponse(telemetry.Memory, func(value core.WorkerMemory) api.WorkerMemory { return api.WorkerMemory(value) }),
			Disk:   workerProbeResponse(telemetry.Disk, func(value core.WorkerDisk) api.WorkerDisk { return api.WorkerDisk(value) }),
			Versions: api.WorkerVersions{Daynight: telemetry.Versions.Daynight,
				Herdr:   workerProbeResponse(telemetry.Versions.Herdr, func(value string) string { return value }),
				Codex:   workerProbeResponse(telemetry.Versions.Codex, func(value string) string { return value }),
				Copilot: workerProbeResponse(telemetry.Versions.Copilot, func(value string) string { return value })}}}
	for _, task := range worker.TaskSnapshot.Items {
		response.Tasks = append(response.Tasks, api.WorkerTaskSnapshot{ProjectID: task.ProjectID, TaskID: task.TaskID, ClaimID: task.ClaimID, Title: task.Title, ProjectName: task.ProjectName, Status: string(task.Status), Phase: string(task.Phase), Agent: string(task.Agent)})
	}
	return response
}

func workerProbeResponse[S, T any](probe core.WorkerProbe[S], convert func(S) T) api.WorkerProbe[T] {
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
