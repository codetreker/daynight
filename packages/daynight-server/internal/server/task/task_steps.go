package task

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type taskStepsHandler struct {
	steps  StepService
	logger *slog.Logger
}

func TaskStepsRoutes(mux *http.ServeMux, steps StepService, auth RouteAuthentication, logger *slog.Logger) {
	handler := &taskStepsHandler{steps: steps, logger: logger}
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/steps"
	mux.HandleFunc("POST "+path, auth.Require(handler.add))
	mux.HandleFunc("GET "+path, auth.Require(handler.get))
	mux.HandleFunc(path, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("GET "+path+"/{stepId}", auth.Require(handler.get))
	mux.HandleFunc("PATCH "+path+"/{stepId}", auth.Require(handler.change))
	mux.HandleFunc("DELETE "+path+"/{stepId}", auth.Require(handler.delete))
	mux.HandleFunc(path+"/{stepId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")))
	mux.HandleFunc("PUT "+path+"/{stepId}/status", auth.Require(handler.change))
	mux.HandleFunc(path+"/{stepId}/status", auth.Require(httpx.ResourceMethodNotAllowed(logger, "PUT")))
	mux.HandleFunc("PUT "+path+"/{stepId}/position", auth.Require(handler.move))
	mux.HandleFunc(path+"/{stepId}/position", auth.Require(httpx.ResourceMethodNotAllowed(logger, "PUT")))
}

func (h *taskStepsHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	operation := "list"
	if request.PathValue("stepId") != "" {
		operation = "get"
	}
	projectID, taskID, logger, err := TaskResource(request, principal, h.logger.With("operation", operation))
	logger = logger.With("read_kind", stepsReadKind(httpx.RequestID(request.Context())))
	if err != nil {
		writeStepsError(w, request, logger, "read", err)
		return
	}
	stepID := request.PathValue("stepId")
	if operation == "get" {
		stepID, err = taskcodec.CanonicalID(stepID)
		if err != nil {
			writeStepsError(w, request, logger, "read", httpx.InvalidInput(err.Error()))
			return
		}
		logger = logger.With("step_id", stepID)
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeStepsError(w, request, logger, "read", httpx.InvalidInput("Steps do not accept query parameters."))
		return
	}
	var data []byte
	var version int64
	if operation == "get" {
		var document taskservice.StepDocument
		document, err = h.steps.Get(request.Context(), principal, projectID, taskID, stepID)
		data, version = document.JSON, document.Resource.Version
	} else {
		var document taskservice.StepsDocument
		document, err = h.steps.List(request.Context(), principal, projectID, taskID)
		data, version = document.JSON, document.Resource.Version
	}
	if err != nil {
		var absence *tasksteps.StepAbsence
		if errors.As(err, &absence) {
			logger.InfoContext(request.Context(), "task step current state", "type", "resource", "component", "task_step", "phase", "read", "outcome", "absent", "version", absence.Version, "request_id", httpx.RequestID(request.Context()))
		}
		writeStepsError(w, request, logger, "read", err)
		return
	}
	outcome := "current_state"
	if operation == "get" {
		outcome = "found"
	}
	logger.InfoContext(request.Context(), "task steps current state", "type", "resource", "component", "task_step", "phase", "read", "outcome", outcome, "version", version, "request_id", httpx.RequestID(request.Context()))
	writeStepsJSON(w, request, logger, http.StatusOK, data)
}

func stepsReadKind(id string) string {
	index := strings.LastIndex(id, ".r")
	if index > 0 {
		number, err := strconv.ParseUint(id[index+2:], 10, 64)
		if err == nil && number > 0 {
			return "reconcile"
		}
	}
	return "normal"
}

func (h *taskStepsHandler) add(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := TaskResource(request, principal, h.logger.With("operation", "add"))
	refuse := func(err error) {
		writeStepsError(w, request, logger.With("tx_outcome", store.TransactionNotCommitted), "prepare", err)
	}
	if err != nil {
		refuse(err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		refuse(httpx.InvalidInput("Steps do not accept query parameters."))
		return
	}
	fields, err := httpx.DecodeObject(w, request, "version", "id", "title", "description", "status", "before", "after")
	if err != nil {
		refuse(err)
		return
	}
	if request.Context().Err() != nil {
		refuse(request.Context().Err())
		return
	}
	input, err := addStepInput(fields)
	if err != nil {
		refuse(err)
		return
	}
	id, err := taskcodec.CanonicalID(input.ID)
	if err != nil {
		refuse(httpx.InvalidInput(err.Error()))
		return
	}
	logger = logger.With("step_id", id)
	result, err := h.steps.Add(request.Context(), principal, projectID, taskID, input)
	logger = logger.With("tx_outcome", result.TransactionOutcome, "cleanup_failed", result.CleanupFailed)
	if err != nil {
		writeStepsError(w, request, logger, result.Phase, err)
		return
	}
	for _, phase := range []string{"prepare", "persist", "commit"} {
		logger.InfoContext(request.Context(), "task step added", "type", "resource", "component", "task_step", "phase", phase, "outcome", "changed", "version", result.Resource.Version, "request_id", httpx.RequestID(request.Context()))
	}
	w.Header().Set("Location", "/api/v1/projects/"+projectID+"/tasks/"+taskID+"/steps/"+id)
	writeStepsJSON(w, request, logger, http.StatusCreated, result.JSON)
}

func addStepInput(fields map[string]json.RawMessage) (taskservice.AddTaskStep, error) {
	var input taskservice.AddTaskStep
	if err := validateStepUnicode(fields); err != nil {
		return input, err
	}
	var err error
	input.Version, err = httpx.VersionInput(fields)
	if err != nil {
		return input, err
	}
	input.ID, err = httpx.RequiredString(fields, "id")
	if err != nil {
		return input, err
	}
	input.Title, err = httpx.RequiredString(fields, "title")
	if err != nil {
		return input, err
	}
	description, err := httpx.OptionalString(fields, "description")
	if err != nil {
		return input, err
	}
	if description != nil {
		input.Description = *description
	}
	status, err := httpx.OptionalString(fields, "status")
	if err != nil {
		return input, err
	}
	if status != nil {
		value := model.TaskStepStatus(*status)
		input.Status = &value
	}
	input.Before, err = httpx.OptionalString(fields, "before")
	if err != nil {
		return input, err
	}
	input.After, err = httpx.OptionalString(fields, "after")
	return input, err
}

// Validate original JSON strings before encoding/json can replace a lone
// escaped surrogate. Escaped backslashes and a literal U+FFFD remain valid.
func validateStepUnicode(fields map[string]json.RawMessage) error {
	for _, raw := range fields {
		if !jsonunicode.Valid(raw) {
			return httpx.InvalidInput("Step fields must contain valid Unicode.")
		}
	}
	return nil
}

func writeStepsJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, status int, data []byte) {
	outcome, written := "canceled_before_body", 0
	if request.Context().Err() == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		n, err := w.Write(data)
		written = n
		if err == nil && n != len(data) {
			err = io.ErrShortWrite
		}
		outcome = "written"
		if err != nil {
			outcome = "failed"
		}
	}
	logger.InfoContext(request.Context(), "task steps response", "type", "resource", "component", "task_step", "phase", "response", "status", status, "response_outcome", outcome, "written_bytes", written, "request_id", httpx.RequestID(request.Context()))
}

func stepsErrorResponse(err error) (int, api.Error) {
	status, response := http.StatusInternalServerError, api.Error{Code: "internal_error", Message: "internal server error"}
	if fault, pure := taskservice.TaskStepsFault(err); pure {
		switch fault.Code {
		case "unauthenticated":
			status = http.StatusUnauthorized
		case "invalid_input":
			status = http.StatusBadRequest
		case "not_found":
			status = http.StatusNotFound
		case "task_deleted":
			status = http.StatusGone
		case "version_conflict", "step_id_conflict", "steps_limit_exceeded", "version_exhausted":
			status = http.StatusConflict
		}
		if status != http.StatusInternalServerError {
			response.Code, response.Message = fault.Code, fault.Message
			if fault.StepsLimit != nil {
				limits := fault.StepsLimit
				response.Details = &api.ErrorDetails{EncodedBytes: &limits.EncodedBytes, MaxEncodedBytes: &limits.MaxEncodedBytes}
			}
		}
	}
	return status, response
}

func writeStepsError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, phase string, err error) {
	if _, ok := err.(*httpx.BodyReadError); ok {
		httpx.WriteBodyError(w, request, logger, "task_step", phase, err)
		return
	}
	httpx.CloseUnreadBody(w, request)
	status, response := stepsErrorResponse(err)
	cause := httpx.ErrorKind(err)
	if response.Code == "internal_error" {
		if _, business := httpx.KnownFault(err); business {
			cause = "internal"
		}
	}
	_, sqlstate := store.DatabaseErrorFacts(err)
	if !validSQLState(sqlstate) {
		sqlstate = ""
	}
	logger.ErrorContext(request.Context(), "task steps operation failed", "type", "operation_error", "component", "task_step", "phase", phase, "cause", cause, "error_code", response.Code, "diagnostic", stepsDiagnostic(response.Code), "sqlstate", sqlstate, "request_id", httpx.RequestID(request.Context()))
	response.RequestID = httpx.RequestID(request.Context())
	data, encodeErr := json.Marshal(api.ErrorResponse{Error: response})
	if encodeErr != nil {
		panic(encodeErr)
	}
	writeStepsJSON(w, request, logger, status, append(data, '\n'))
}

func stepsDiagnostic(code string) string {
	switch code {
	case "unauthenticated":
		return "Authentication is required."
	case "invalid_input":
		return "Step input is invalid."
	case "not_found":
		return "Requested resource is unavailable."
	case "task_deleted":
		return "Parent task is deleted."
	case "version_conflict":
		return "Parent task version does not match."
	case "step_id_conflict":
		return "Step identity already exists."
	case "steps_limit_exceeded":
		return "Step collection exceeds its encoded capacity."
	case "version_exhausted":
		return "Parent task version is exhausted."
	default:
		return "Task steps operation failed."
	}
}

func validSQLState(value string) bool {
	if len(value) != 5 {
		return false
	}
	for _, digit := range []byte(value) {
		if !(digit >= '0' && digit <= '9' || digit >= 'A' && digit <= 'Z') {
			return false
		}
	}
	return true
}
