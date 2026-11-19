package worker

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type reviewSettingsResponse struct {
	Enabled bool `json:"enabled"`
}

func (h *workersHandler) reviewSettings(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	const component = "worker_review_settings"
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker review settings do not accept query parameters")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, component, "validate", err)
		return
	}
	if request.Method == http.MethodPut {
		enabled, err := decodeReviewSettings(w, request)
		if err != nil {
			httpx.WriteError(w, request, logger, component, "validate", err)
			return
		}
		stored, err := h.workers.SetReviewEnabled(request.Context(), principal, id, enabled)
		if err != nil {
			httpx.WriteError(w, request, logger, component, "write", err)
			return
		}
		httpx.WriteMutationJSON(w, request, logger, component, http.StatusOK, reviewSettingsResponse{Enabled: stored})
		return
	}
	enabled, err := h.workers.ReviewEnabled(request.Context(), principal, id)
	if err != nil {
		httpx.WriteError(w, request, logger, component, "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, reviewSettingsResponse{Enabled: enabled})
}

func decodeReviewSettings(w http.ResponseWriter, request *http.Request) (bool, error) {
	fields, err := httpx.DecodeObject(w, request, "enabled")
	if err != nil {
		return false, err
	}
	enabled, err := httpx.OptionalBool(fields, "enabled")
	if err != nil {
		return false, err
	}
	if enabled == nil {
		return false, httpx.InvalidInput("enabled is required")
	}
	return *enabled, nil
}
