package task

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func (h *taskStepsHandler) change(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	operation := "update"
	allowed := []string{"version", "title", "description"}
	if request.Method == http.MethodPut {
		operation = "set_status"
		allowed = []string{"version", "status"}
	}
	projectID, taskID, logger, err := TaskResource(request, principal, h.logger.With("operation", operation))
	refuse := func(err error) {
		writeStepsError(w, request, logger.With("tx_outcome", store.TransactionNotCommitted), "prepare", err)
	}
	if err != nil {
		refuse(err)
		return
	}
	stepID, err := taskcodec.CanonicalID(request.PathValue("stepId"))
	if err != nil {
		refuse(httpx.InvalidInput(err.Error()))
		return
	}
	logger = logger.With("step_id", stepID)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		refuse(httpx.InvalidInput("Steps do not accept query parameters."))
		return
	}
	fields, err := h.decodeObject(w, request, allowed...)
	if err != nil {
		refuse(err)
		return
	}
	if request.Context().Err() != nil {
		refuse(request.Context().Err())
		return
	}
	var result taskservice.StepsWriteResult
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

func updateStepInput(fields map[string]json.RawMessage) (taskservice.UpdateTaskStep, error) {
	var input taskservice.UpdateTaskStep
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return input, err
	}
	input.Title, err = httpx.OptionalString(fields, "title")
	if err != nil {
		return input, err
	}
	input.Description, err = httpx.OptionalString(fields, "description")
	return input, err
}

func stepStatusInput(fields map[string]json.RawMessage) (taskservice.SetTaskStepStatus, error) {
	var input taskservice.SetTaskStepStatus
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return input, err
	}
	status, err := httpx.RequiredString(fields, "status")
	if err != nil {
		return input, err
	}
	input.Status = model.TaskStepStatus(status)
	return input, nil
}

func writeStepChange(w http.ResponseWriter, request *http.Request, logger *slog.Logger, result taskservice.StepsWriteResult, err error) {
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
		logger.InfoContext(request.Context(), "task step change completed", "type", "resource", "component", "task_step", "phase", phase, "outcome", outcome, "version", result.Resource.Version, "request_id", httpx.RequestID(request.Context()))
	}
	writeStepsJSON(w, request, logger, http.StatusOK, result.JSON)
}
