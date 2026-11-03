package server

import (
	"io"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/tasksteps"
)

type taskStepsHandler struct {
	steps  *service.TaskSteps
	logger *slog.Logger
}

func taskStepsRoutes(mux *http.ServeMux, steps *service.TaskSteps, auth *Authentication, logger *slog.Logger) {
	handler := &taskStepsHandler{steps: steps, logger: logger}
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/steps"
	for _, resource := range []string{path, path + "/{stepId}"} {
		mux.HandleFunc("GET "+resource, auth.Require(handler.get))
		mux.HandleFunc(resource, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	}
}

func (h *taskStepsHandler) get(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := taskResource(request, principal, h.logger)
	if err != nil {
		writeStepsError(w, request, logger, err)
		return
	}
	operation := "list"
	stepID := request.PathValue("stepId")
	if stepID != "" {
		operation = "get"
		stepID, err = tasksteps.CanonicalID(stepID)
		if err != nil {
			writeStepsError(w, request, logger, invalidInput(err.Error()))
			return
		}
		logger = logger.With("step_id", stepID)
	}
	logger = logger.With("operation", operation)
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeStepsError(w, request, logger, invalidInput("Steps reads do not accept query parameters."))
		return
	}
	var data []byte
	if operation == "get" {
		var document service.StepDocument
		document, err = h.steps.Get(request.Context(), principal, projectID, taskID, stepID)
		data = document.JSON
	} else {
		var document service.StepsDocument
		document, err = h.steps.List(request.Context(), principal, projectID, taskID)
		data = document.JSON
	}
	if err != nil {
		writeStepsError(w, request, logger, err)
		return
	}
	logger.InfoContext(request.Context(), "task steps read", "type", "resource", "component", "task_step", "phase", "read", "outcome", "current_state", "request_id", RequestID(request.Context()))
	writeStepsJSON(w, request, logger, data)
}

func writeStepsJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, data []byte) {
	outcome := "canceled_before_write"
	if request.Context().Err() == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		n, err := w.Write(data)
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
		outcome = "written"
		if err != nil {
			outcome = "failed"
		}
	}
	logger.InfoContext(request.Context(), "task steps response", "type", "resource", "component", "task_step", "phase", "response", "response_outcome", outcome, "request_id", RequestID(request.Context()))
}

func writeStepsError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, err error) {
	status, code, message := http.StatusInternalServerError, "internal_error", "internal server error"
	cause := ErrorKind(err)
	if fault, pure := service.TaskStepsFault(err); pure {
		switch fault.Code {
		case "unauthenticated":
			status, code, message = http.StatusUnauthorized, fault.Code, "Authentication is required."
		case "invalid_input":
			status, code, message = http.StatusBadRequest, fault.Code, fault.Message
		case "not_found":
			status, code, message = http.StatusNotFound, fault.Code, fault.Message
		case "task_deleted":
			status, code, message = http.StatusGone, fault.Code, "Task has been deleted."
		}
	}
	if code == "internal_error" {
		if _, business := knownFault(err); business {
			cause = "internal"
		}
	}
	logger.ErrorContext(request.Context(), "task steps read failed", "type", "operation_error", "component", "task_step", "phase", "read", "cause", cause, "error_code", code, "diagnostic", "Task steps could not be read.", "request_id", RequestID(request.Context()))
	writeJSON(w, request, logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: RequestID(request.Context())}})
}
