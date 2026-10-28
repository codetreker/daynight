package server

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"syscall"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/jackc/pgx/v5/pgconn"
)

type requestIDKey struct{}

func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	return value
}

func validRequestID(value string) bool {
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
		if fault, ok := knownFault(err); ok {
			return fault.Code
		}
		if errors.As(err, &storeError) {
			return "database"
		}
		return "internal"
	}
}

func knownFault(err error) (*service.Fault, bool) {
	var fault *service.Fault
	if errors.As(err, &fault) {
		switch fault.Code {
		case "controller_offline", "relay_instance_unavailable", "content_unavailable", "rate_limited", "unauthenticated", "forbidden", "last_admin", "invitation_unavailable", "task_deleted", "invalid_input", "not_found", "path_conflict", "version_conflict", "invalid_transition", "claim_conflict", "dependency_cycle", "dependency_unsatisfied", "graph_limit_exceeded", "session_conflict", "operation_conflict", "source_gap", "reconcile_required", "reset_required", "resource_conflict", "payload_too_large":
			return fault, true
		}
	}
	return nil, false
}

func LogFailure(logger *slog.Logger, ctx context.Context, component, phase string, err error) {
	diagnostic := "operation failed"
	kind, code := ErrorKind(err), "internal_error"
	var configurationError *ConfigurationError
	var databaseError *store.Error
	var runtimeFailure *runtimeError
	var identityFailure *service.IdentityProviderError
	fault, domainFailure := knownFault(err)
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
	upstreamID := ""
	var protocolFailure *uniauth.ProtocolError
	var gatewayFailure *uniauth.APIError
	if errors.As(err, &protocolFailure) && validRequestID(protocolFailure.RequestID) {
		upstreamID = protocolFailure.RequestID
	}
	if errors.As(err, &gatewayFailure) && validRequestID(gatewayFailure.RequestID) {
		upstreamID = gatewayFailure.RequestID
	}
	logger.ErrorContext(ctx, "operation failed", "type", "operation_error", "component", component,
		"phase", phase, "cause", kind, "error_code", code, "diagnostic", diagnostic, "request_id", RequestID(ctx), "upstream_request_id", upstreamID)
}

type responseRecorder struct {
	http.ResponseWriter
	status int
}

func (w *responseRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *responseRecorder) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.ResponseWriter.WriteHeader(status)
	}
}

func (w *responseRecorder) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func RequestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		id := request.Header.Get("X-Request-ID")
		if !validRequestID(id) {
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
		recorder := &responseRecorder{ResponseWriter: w}
		start := time.Now()
		next.ServeHTTP(recorder, request)
		status := recorder.status
		if status == 0 {
			status = http.StatusOK
		}
		logger.InfoContext(request.Context(), "request completed", "type", "http_request", "component", "server",
			"phase", "response", "request_id", id, "method", request.Method, "route", request.Pattern,
			"status", status, "duration", time.Since(start))
	})
}
