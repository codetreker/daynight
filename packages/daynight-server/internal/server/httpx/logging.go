package httpx

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"syscall"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"

	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/jackc/pgx/v5/pgconn"
)

type requestIDKey struct{}

func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	return value
}

func ValidRequestID(value string) bool {
	if len(value) == 0 || len(value) > 64 {
		return false
	}
	for index, char := range []byte(value) {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' {
			continue
		}
		if index > 0 && (char == '.' || char == '_' || char == '-') {
			continue
		}
		return false
	}
	return true
}

func ErrorKind(err error) string {
	if fault, ok := err.(*model.Fault); ok && fault.Code == "search_timeout" {
		if _, known := KnownFault(err); known {
			return fault.Code
		}
	}
	var databaseError *pgconn.PgError
	var storeError *store.Error
	var networkError *net.OpError
	var protocolError *uniauth.ProtocolError
	var requestError *uniauth.RequestError
	var apiError *uniauth.APIError
	switch {
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.As(err, &databaseError):
		return "database"
	case errors.As(err, &protocolError), errors.As(err, &apiError):
		return "protocol"
	case errors.As(err, &requestError):
		return "network"
	case errors.Is(err, syscall.EADDRINUSE):
		return "address_in_use"
	case errors.As(err, &networkError):
		return "network"
	default:
		if fault, ok := KnownFault(err); ok {
			return fault.Code
		}
		if errors.As(err, &storeError) {
			return "database"
		}
		return "internal"
	}
}

func KnownFault(err error) (*model.Fault, bool) {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
		return nil, false
	}
	var botOperation *model.BotOperationError
	if errors.As(err, &botOperation) {
		return nil, false
	}
	var validation *taskproperties.ValidationError
	if errors.As(err, &validation) && onlyPropertyValidation(err) {
		return &model.Fault{Code: "invalid_input", Message: validation.Error(), Cause: err}, true
	}
	var fault *model.Fault
	if errors.As(err, &fault) {
		switch fault.Code {
		case "configuration_not_initialized", "invalid_search_expression", "search_context_limit_exceeded", "search_changed", "search_timeout":
			return fault, true
		case "personal_team_immutable", "team_not_empty", "write_outcome_unknown", "step_id_conflict", "steps_limit_exceeded", "version_exhausted", "permission_denied", "stale_fence", "target_changed", "lease_expired", "input_busy", "automation_suspended", "unsupported_protocol", "unsupported_content_kind", "input_unknown", "recording_limit", "source_corrupt", "stop_unknown", "archive_pending", "invalid_payload", "controller_offline", "relay_instance_unavailable", "content_unavailable", "rate_limited", "unauthenticated", "forbidden", "last_admin", "identity_mismatch", "invitation_unavailable", "task_deleted", "invalid_input", "not_found", "path_conflict", "version_conflict", "invalid_transition", "claim_conflict", "dependency_cycle", "dependency_unsatisfied", "graph_limit_exceeded", "session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict", "payload_too_large", "message_not_found", "clock_not_advanced", "message_outcome_unknown":
			return fault, true
		}
	}
	return nil, false
}

func onlyPropertyValidation(err error) bool {
	if _, ok := err.(*taskproperties.ValidationError); ok {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		children := joined.Unwrap()
		if len(children) == 0 {
			return false
		}
		for _, child := range children {
			if !onlyPropertyValidation(child) {
				return false
			}
		}
		return true
	}
	if wrapped := errors.Unwrap(err); wrapped != nil {
		return onlyPropertyValidation(wrapped)
	}
	return false
}

func LogFailure(logger *slog.Logger, ctx context.Context, component, phase string, err error) {
	diagnostic := "operation failed"
	kind, code := ErrorKind(err), "internal_error"
	if component == "task_search" {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
			kind = "database"
		}
	}
	var configurationError *config.ConfigurationError
	var databaseError *store.Error
	var runtimeFailure *RuntimeError
	var identityFailure *model.IdentityProviderError
	fault, domainFailure := KnownFault(err)
	switch {
	case errors.As(err, &identityFailure):
		diagnostic, code = identityFailure.Error(), identityFailure.Code
	case domainFailure && kind == fault.Code:
		diagnostic, code = fault.Message, fault.Code
	case errors.As(err, &configurationError):
		diagnostic = configurationError.Error()
	case errors.As(err, &databaseError):
		diagnostic = databaseError.Error()
	case errors.As(err, &runtimeFailure):
		diagnostic = runtimeFailure.Error()
	}
	if component == "task_search" {
		// Search failures may contain query parameters or driver diagnostics.
		diagnostic = "search operation failed"
	}
	upstreamID := ""
	var protocolFailure *uniauth.ProtocolError
	var gatewayFailure *uniauth.APIError
	if errors.As(err, &protocolFailure) && ValidRequestID(protocolFailure.RequestID) {
		upstreamID = protocolFailure.RequestID
	}
	if errors.As(err, &gatewayFailure) && ValidRequestID(gatewayFailure.RequestID) {
		upstreamID = gatewayFailure.RequestID
	}
	logger.ErrorContext(ctx, "operation failed", "type", "operation_error", "component", component,
		"phase", phase, "cause", kind, "error_code", code, "diagnostic", diagnostic, "request_id", RequestID(ctx), "upstream_request_id", upstreamID)
}

type ResponseRecorder struct {
	http.ResponseWriter
	Status int
}

func (w *ResponseRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *ResponseRecorder) WriteHeader(status int) {
	if w.Status == 0 {
		w.Status = status
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *ResponseRecorder) Write(data []byte) (int, error) {
	if w.Status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func RequestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		id := request.Header.Get("X-Request-ID")
		if !ValidRequestID(id) {
			id = rand.Text()
		}
		request = request.WithContext(context.WithValue(request.Context(), requestIDKey{}, id))
		defer func() {
			if value := recover(); value != nil {
				if value == http.ErrAbortHandler {
					panic(value)
				}
				logger.ErrorContext(request.Context(), "request interrupted", "type", "request_error", "component", "server",
					"phase", "handler", "cause", "panic", "request_id", id)
				// net/http aborts the request without logging the recovered value.
				panic(http.ErrAbortHandler)
			}
		}()
		w.Header().Set("X-Request-ID", id)
		recorder := &ResponseRecorder{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(recorder, request)
		status := recorder.Status
		if status == 0 {
			status = http.StatusOK
		}
		logger.InfoContext(request.Context(), "request completed", "type", "http_request", "component", "server",
			"phase", "response", "request_id", id, "method", request.Method, "route", request.Pattern,
			"status", status, "duration", time.Since(start))
	})
}
