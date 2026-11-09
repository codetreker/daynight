package worker

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	monitoring "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const monitoringRequestLimit = 256 << 10

func monitoringID(value string) (string, error) {
	id, err := model.CanonicalID(value)
	if err != nil || id != value {
		return "", httpx.InvalidInput("ID must be a canonical UUID")
	}
	return id, nil
}

func monitoringNoQuery(request *http.Request) error {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return httpx.InvalidInput("monitoring requests do not accept query parameters")
	}
	return nil
}

func monitoringPutInput(fields map[string]json.RawMessage) (*string, monitoring.Observation, error) {
	var empty monitoring.Observation
	raw, present := fields["expectedRevision"]
	if !present {
		return nil, empty, httpx.InvalidInput("expectedRevision is required")
	}
	var revision *string
	if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		value, err := httpx.RequiredString(fields, "expectedRevision")
		if err != nil {
			return nil, empty, err
		}
		if _, err = monitoringID(value); err != nil {
			return nil, empty, err
		}
		revision = &value
	}
	if _, present := fields["observation"]; !present {
		return nil, empty, httpx.InvalidInput("observation is required")
	}
	observation, err := monitoring.ParseObservation(fields["observation"])
	return revision, observation, err
}

func monitoringQueryInput(fields map[string]json.RawMessage) ([]string, error) {
	input, err := httpx.OptionalStrings(fields, "workerIds")
	if err != nil {
		return nil, err
	}
	if input == nil || len(*input) < 1 || len(*input) > 100 {
		return nil, httpx.InvalidInput("workerIds must contain 1 to 100 distinct UUIDs")
	}
	seen := make(map[string]bool, len(*input))
	for _, value := range *input {
		id, err := monitoringID(value)
		if err != nil || seen[id] {
			return nil, httpx.InvalidInput("workerIds must contain 1 to 100 distinct canonical UUIDs")
		}
		seen[id] = true
	}
	return *input, nil
}

func (h *workersHandler) putMonitoring(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := monitoringID(request.PathValue("workerId"))
	if err == nil {
		err = monitoringNoQuery(request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	logger = logger.With("worker_id", id)
	fields, err := httpx.DecodeObjectLimit(w, request, monitoringRequestLimit, "expectedRevision", "observation")
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	revision, observation, err := monitoringPutInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	result, err := h.workers.PutMonitoring(request.Context(), principal, id, revision, observation)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "write", err)
		return
	}
	logger.InfoContext(request.Context(), "worker monitoring saved", "type", "resource", "component", "worker_monitoring", "phase", "write", "run_id", observation["runId"], "sequence", observation["sequence"], "request_id", httpx.RequestID(request.Context()))
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}

func (h *workersHandler) getMonitoring(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := monitoringID(request.PathValue("workerId"))
	if err == nil {
		err = monitoringNoQuery(request)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	logger = logger.With("worker_id", id)
	result, err := h.workers.GetMonitoring(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}

func (h *workersHandler) queryMonitoring(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	if err := monitoringNoQuery(request); err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	fields, err := httpx.DecodeObject(w, request, "workerIds")
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	ids, err := monitoringQueryInput(fields)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "validate", err)
		return
	}
	result, err := h.workers.QueryMonitoring(request.Context(), principal, ids)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_monitoring", "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}
