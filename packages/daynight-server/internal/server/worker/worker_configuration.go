package worker

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const workerConfigurationHeader = "Daynight-Worker-Configuration"

func (h *workersHandler) configuration(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker configuration does not accept query parameters")
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_configuration", "validate", err)
		return
	}
	var result model.WorkerConfigurationResource
	if request.Method == http.MethodPut {
		fields, decodeErr := httpx.DecodeObject(w, request, "revision", "value")
		if decodeErr != nil {
			err = decodeErr
		} else {
			revision, revisionErr := httpx.RequiredString(fields, "revision")
			if revisionErr != nil {
				err = revisionErr
			} else {
				value, valueErr := workercore.ParseWorkerConfiguration(fields["value"])
				if valueErr != nil {
					err = valueErr
				} else {
					result, err = h.workers.PutConfiguration(request.Context(), principal, id, revision, value)
				}
			}
		}
	} else {
		result, err = h.workers.Configuration(request.Context(), principal, id)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_configuration", "exchange", err)
		return
	}
	w.Header().Set(workerConfigurationHeader, "1")
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}
