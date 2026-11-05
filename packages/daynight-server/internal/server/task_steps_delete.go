package server

import (
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func (h *taskStepsHandler) delete(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := taskResource(request, principal, h.logger.With("operation", "delete"))
	refuse := func(err error) {
		writeStepsError(w, request, logger.With("tx_outcome", store.TransactionNotCommitted), "prepare", err)
	}
	if err != nil {
		refuse(err)
		return
	}
	stepID, err := taskcodec.CanonicalID(request.PathValue("stepId"))
	if err != nil {
		refuse(invalidInput(err.Error()))
		return
	}
	logger = logger.With("step_id", stepID)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		refuse(invalidInput("Steps do not accept query parameters."))
		return
	}
	fields, err := decodeObject(w, request, "version")
	if request.Context().Err() != nil {
		refuse(request.Context().Err())
		return
	}
	if err != nil {
		refuse(err)
		return
	}
	input, err := deleteStepInput(fields)
	if err != nil {
		refuse(err)
		return
	}
	result, err := h.steps.Delete(request.Context(), principal, projectID, taskID, stepID, input)
	writeStepChange(w, request, logger, result, err)
}

func deleteStepInput(fields map[string]json.RawMessage) (service.DeleteTaskStep, error) {
	if err := validateStepUnicode(fields); err != nil {
		return service.DeleteTaskStep{}, err
	}
	version, err := versionInput(fields)
	return service.DeleteTaskStep{Version: version}, err
}
