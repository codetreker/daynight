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
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"

	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func RequestID(ctx context.Context) string { return requestid.From(ctx) }

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
	// Monitoring failures classify the Redis operation explicitly while retaining
	// its cause, including deadline or network errors, for diagnosis.
	if fault, ok := KnownFault(err); ok && (fault.Code == "monitoring_unavailable" || fault.Code == "monitoring_write_outcome_unknown") {
		return fault.Code
	}
	if fault, ok := err.(*model.Fault); ok && fault.Code == "search_timeout" {
		if _, known := KnownFault(err); known {
			return fault.Code
		}
	}
	databaseFailure, _ := store.DatabaseErrorFacts(err)
	var transaction *store.TransactionError
	transactionFailure := errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted)
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
	case databaseFailure || transactionFailure:
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

// KnownFault returns only faults whose completion and cleanup remain reliable.
func KnownFault(err error) (*model.Fault, bool) { return operation.KnownFault(err) }

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
	attrs := []any{"type", "operation_error", "component", component,
		"phase", phase, "cause", kind, "error_code", code, "diagnostic", diagnostic, "request_id", RequestID(ctx), "upstream_request_id", upstreamID}
	var monitoringFailure *store.MonitoringError
	if component == "worker_monitoring" && errors.As(err, &monitoringFailure) {
		switch monitoringFailure.Kind {
		case "deadline", "cancelled", "format", "oom", "type", "server", "network", "other":
			attrs = append(attrs, "dependency_cause", monitoringFailure.Kind)
		}
	}
	logger.ErrorContext(ctx, "operation failed", attrs...)
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
		request = request.WithContext(requestid.With(request.Context(), id))
		if request.Body != nil && request.Body != http.NoBody {
			body := &trackedRequestBody{ReadCloser: request.Body}
			request = request.WithContext(context.WithValue(request.Context(), bodyCompletionKey{}, body))
			request.Body = body
		}
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
