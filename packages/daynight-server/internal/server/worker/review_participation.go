package worker

import (
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *workersHandler) reviewParticipation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("Worker review participation does not accept query parameters.")
	}
	var result model.WorkerReviewParticipation
	if err == nil && request.Method == http.MethodPut {
		var fields map[string]json.RawMessage
		fields, err = httpx.DecodeObject(w, request, "enabled", "expectedVersion")
		var version string
		var enabled *bool
		if err == nil {
			version, err = httpx.RequiredString(fields, "expectedVersion")
		}
		if err == nil {
			enabled, err = httpx.OptionalBool(fields, "enabled")
			if err == nil && enabled == nil {
				err = httpx.InvalidInput("enabled is required and must be a boolean")
			}
		}
		if err == nil {
			result, err = h.workers.PutReviewParticipation(request.Context(), principal, id, version, *enabled)
		}
	} else if err == nil {
		result, err = h.workers.ReviewParticipation(request.Context(), principal, id)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_review_participation", "exchange", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, workerprotocol.ProjectReviewParticipation(result))
}
