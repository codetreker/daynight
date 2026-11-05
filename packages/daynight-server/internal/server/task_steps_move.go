package server

import (
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
)

func (h *taskStepsHandler) move(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := taskResource(request, principal, h.logger.With("operation", "move"))
	refuse := func(err error) {
		writeStepsError(w, request, logger.With("tx_outcome", store.TransactionNotCommitted), "prepare", err)
	}
	if err != nil {
		refuse(err)
		return
	}
	stepID, err := tasksteps.CanonicalID(request.PathValue("stepId"))
	if err != nil {
		refuse(invalidInput(err.Error()))
		return
	}
	logger = logger.With("step_id", stepID)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		refuse(invalidInput("Steps do not accept query parameters."))
		return
	}
	fields, err := decodeObject(w, request, "version", "before", "after", "position")
	if request.Context().Err() != nil {
		refuse(request.Context().Err())
		return
	}
	if err != nil {
		refuse(err)
		return
	}
	input, err := moveStepInput(fields)
	if err != nil {
		refuse(err)
		return
	}
	result, err := h.steps.Move(request.Context(), principal, projectID, taskID, stepID, input)
	writeStepChange(w, request, logger, result, err)
}

func moveStepInput(fields map[string]json.RawMessage) (service.MoveTaskStep, error) {
	var input service.MoveTaskStep
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return input, err
	}
	input.Before, err = optionalString(fields, "before")
	if err != nil {
		return input, err
	}
	input.After, err = optionalString(fields, "after")
	if err != nil {
		return input, err
	}
	input.Position, err = optionalString(fields, "position")
	return input, err
}
