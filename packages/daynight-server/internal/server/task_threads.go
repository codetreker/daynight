package server

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type taskThreadHandler struct {
	threads *service.TaskThreads
	logger  *slog.Logger
}

func taskThreadRoutes(mux *http.ServeMux, threads *service.TaskThreads, auth *Authentication, logger *slog.Logger) {
	handler := &taskThreadHandler{threads: threads, logger: logger}
	const path = "/api/v1/projects/{projectId}/tasks/{taskId}/thread/messages"
	mux.HandleFunc("GET "+path, auth.Require(handler.list))
	mux.HandleFunc("POST "+path, auth.Require(handler.post))
	mux.HandleFunc(path, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
}

func threadPostInput(fields map[string]json.RawMessage) (service.CreateThreadMessage, error) {
	var result service.CreateThreadMessage
	var err error
	result.Body, err = requiredString(fields, "body")
	if err != nil {
		return result, err
	}
	result.ReplyTo, err = optionalString(fields, "replyTo")
	if err != nil {
		return result, err
	}
	result.ClaimID, err = optionalString(fields, "claimId")
	return result, err
}

func threadListInput(request *http.Request) (service.ThreadListRequest, error) {
	values, err := queryValues(request, "beforeId", "afterId", "count", "details", "fromBeginning")
	if err != nil {
		return service.ThreadListRequest{}, err
	}
	result := service.ThreadListRequest{Count: 50}
	for key, target := range map[string]**string{"beforeId": &result.BeforeID, "afterId": &result.AfterID} {
		if values.Has(key) {
			value, err := service.CanonicalID(values.Get(key))
			if err != nil {
				return result, err
			}
			*target = &value
		}
	}
	if result.BeforeID != nil && result.AfterID != nil {
		return result, invalidInput("beforeId and afterId are mutually exclusive")
	}
	if values.Has("count") {
		result.Count, err = strconv.Atoi(values.Get("count"))
		if err != nil || result.Count < 1 || result.Count > 100 {
			return result, invalidInput("count must be an integer from 1 to 100")
		}
	}
	for key, target := range map[string]*bool{"details": &result.Details, "fromBeginning": &result.FromBeginning} {
		if values.Has(key) {
			value := values.Get(key)
			if value != "true" && value != "false" {
				return result, invalidInput(key + " must be true or false")
			}
			*target = value == "true"
		}
	}
	if values.Has("fromBeginning") && (result.BeforeID != nil || result.AfterID != nil) {
		return result, invalidInput("fromBeginning cannot be combined with a boundary Id")
	}
	return result, nil
}

func (h *taskThreadHandler) post(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := taskResource(request, principal, h.logger)
	if err != nil {
		writeThreadError(w, request, logger, "admission", err)
		return
	}
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		writeThreadError(w, request, logger, "admission", invalidInput("posting a thread message does not accept query parameters"))
		return
	}
	fields, err := decodeObject(w, request, "body", "replyTo", "claimId")
	if err != nil {
		writeThreadError(w, request, logger, "admission", err)
		return
	}
	input, err := threadPostInput(fields)
	if err != nil {
		writeThreadError(w, request, logger, "admission", err)
		return
	}
	document, err := h.threads.Post(request.Context(), principal, projectID, taskID, input)
	if err != nil {
		writeThreadError(w, request, logger, "append", err)
		return
	}
	logger = logger.With("message_id", document.Message.ID)
	logger = threadExecutionLogger(logger, document.Message.Author.Execution)
	logger.InfoContext(request.Context(), "thread message committed", "type", "resource", "component", "task_thread", "phase", "commit", "request_id", RequestID(request.Context()))
	writeThreadJSON(w, request, logger, http.StatusCreated, document.JSON)
}

func (h *taskThreadHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	projectID, taskID, logger, err := taskResource(request, principal, h.logger)
	if err != nil {
		writeThreadError(w, request, logger, "admission", err)
		return
	}
	input, err := threadListInput(request)
	if err != nil {
		writeThreadError(w, request, logger, "admission", err)
		return
	}
	document, err := h.threads.List(request.Context(), principal, projectID, taskID, input)
	if err != nil {
		writeThreadError(w, request, logger, "read", err)
		return
	}
	writeThreadJSON(w, request, logger, http.StatusOK, document.JSON)
}

// The service owns these exact bytes, including the page and message budgets.
func writeThreadJSON(w http.ResponseWriter, request *http.Request, logger *slog.Logger, status int, data []byte) {
	if request.Context().Err() != nil {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	n, err := w.Write(data)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	if err != nil {
		LogFailure(logger, request.Context(), "task_thread", "response", err)
	}
}

func writeThreadError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, phase string, err error) {
	var message *service.ThreadMessageError
	if errors.As(err, &message) {
		if message.MessageID != "" {
			logger = logger.With("message_id", message.MessageID)
		}
		logger = threadExecutionLogger(logger, message.Execution)
	}
	var clock *store.ThreadClockError
	if errors.As(err, &clock) {
		phase = "clock"
		logger = logger.With("head_created_at", clock.Head.CreatedAt, "head_message_id", clock.Head.ID)
		if !clock.Observed.IsZero() {
			logger = logger.With("observed_at", clock.Observed)
		}
	}
	if fault, ok := service.ThreadResponseFault(err); ok {
		status := http.StatusServiceUnavailable
		cause := ErrorKind(err)
		if fault.Code == "internal_error" {
			status = http.StatusInternalServerError
			phase = "rollback"
			// A nested business refusal cannot classify a failed cleanup.
			if nested, ok := knownFault(err); ok && cause == nested.Code {
				cause = "internal"
			}
		}
		logger = logger.With("thread_error_code", fault.Code)
		if service.ThreadWriteOutcomeUnknown(err) {
			logger = logger.With("write_outcome", "unknown")
			phase = "commit"
		}
		logger.ErrorContext(request.Context(), "operation failed", "type", "operation_error", "component", "task_thread",
			"phase", phase, "cause", cause, "error_code", fault.Code, "diagnostic", fault.Message, "request_id", RequestID(request.Context()))
		writeJSON(w, request, logger, status, api.ErrorResponse{Error: api.Error{
			Code: fault.Code, Message: fault.Message, RequestID: RequestID(request.Context()),
		}})
		return
	}
	writeError(w, request, logger, "task_thread", phase, err)
}

func threadExecutionLogger(logger *slog.Logger, execution *model.ThreadExecution) *slog.Logger {
	if execution == nil {
		return logger
	}
	return logger.With("claim_id", execution.ClaimID, "worker_id", execution.WorkerID, "provider", execution.Provider)
}
