package server

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
)

func (h *taskStepsHandler) change(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	operation := "update"
	allowed := []string{"version", "title", "description"}
	if request.Method == http.MethodPut {
		operation = "set_status"
		allowed = []string{"version", "status"}
	}
	projectID, taskID, logger, err := taskResource(request, principal, h.logger.With("operation", operation))
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
	fields, err := decodeObject(w, request, allowed...)
	if request.Context().Err() != nil {
		refuse(request.Context().Err())
		return
	}
	if err != nil {
		refuse(err)
		return
	}
	var result service.StepsWriteResult
	if operation == "update" {
		input, err := updateStepInput(fields)
		if err != nil {
			refuse(err)
			return
		}
		result, err = h.steps.Update(request.Context(), principal, projectID, taskID, stepID, input)
		writeStepChange(w, request, logger, result, err)
		return
	}
	input, err := stepStatusInput(fields)
	if err != nil {
		refuse(err)
		return
	}
	result, err = h.steps.SetStatus(request.Context(), principal, projectID, taskID, stepID, input)
	writeStepChange(w, request, logger, result, err)
}

func updateStepInput(fields map[string]json.RawMessage) (service.UpdateTaskStep, error) {
	var input service.UpdateTaskStep
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return input, err
	}
	input.Title, err = optionalString(fields, "title")
	if err != nil {
		return input, err
	}
	input.Description, err = optionalString(fields, "description")
	return input, err
}

func stepStatusInput(fields map[string]json.RawMessage) (service.SetTaskStepStatus, error) {
	var input service.SetTaskStepStatus
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = versionInput(fields)
	if err != nil {
		return input, err
	}
	status, err := requiredString(fields, "status")
	if err != nil {
		return input, err
	}
	input.Status = core.TaskStepStatus(status)
	return input, nil
}

func writeStepChange(w http.ResponseWriter, request *http.Request, logger *slog.Logger, result service.StepsWriteResult, err error) {
	logger = logger.With("tx_outcome", result.TransactionOutcome, "cleanup_failed", result.CleanupFailed)
	if err != nil {
		writeStepsError(w, request, logger, result.Phase, err)
		return
	}
	outcome := "unchanged"
	phases := []string{"prepare", "commit"}
	if result.Changed {
		outcome = "changed"
		phases = []string{"prepare", "persist", "commit"}
	}
	for _, phase := range phases {
		logger.InfoContext(request.Context(), "task step change completed", "type", "resource", "component", "task_step", "phase", phase, "outcome", outcome, "version", result.Resource.Version, "request_id", RequestID(request.Context()))
	}
	writeStepsJSON(w, request, logger, http.StatusOK, result.JSON)
}
