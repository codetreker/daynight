package httpx

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"syscall"
	"time"

	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

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

func runtimeComponent(err error) *RuntimeError {
	if err == nil {
		return nil
	}
	if failure, ok := err.(*RuntimeError); ok && failure.Component != "" {
		return failure
	}
	if causes, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range causes.Unwrap() {
			if failure := runtimeComponent(cause); failure != nil {
				return failure
			}
		}
		return nil
	}
	return runtimeComponent(errors.Unwrap(err))
}

func LogFailure(logger *slog.Logger, ctx context.Context, component, phase string, err error) {
	diagnostic := "operation failed"
	controllerFailure := false
	if component == "session" {
		switch phase {
		case "controller_connect", "controller_source", "controller_fence", "controller_handle", "controller_poll":
			controllerFailure = true
		}
	}
	kind, code := ErrorKind(err), "internal_error"
	if component == "task_search" {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) && (transaction.Phase != "operation" || transaction.CleanupFailed || transaction.Outcome != store.TransactionNotCommitted) {
			kind = "database"
		}
	}
	var configurationError *configvalue.ConfigurationError
	var databaseError *store.Error
	var runtimeFailure *RuntimeError
	if failure := runtimeComponent(err); failure != nil && !controllerFailure {
		component, phase = failure.Component, failure.Phase
	}
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
	if controllerFailure {
		// The adapter supplies the phase; nested error messages can include user
		// content or driver details even when the error has a known domain code.
		diagnostic = "controller operation failed"
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
	if component == "configuration" && configurationError != nil {
		if configurationError.Phase != "" {
			attrs[5] = configurationError.Phase
		}
		if configurationError.Field != "" {
			attrs = append(attrs, "field", configurationError.Field)
		}
		origin := configurationError.Origin
		if origin.Source != "" {
			attrs = append(attrs, "source", origin.Source)
		}
		if origin.EnvName != "" {
			attrs = append(attrs, "env_name", origin.EnvName)
		}
		if origin.Line > 0 {
			attrs = append(attrs, "line", origin.Line)
		}
		if origin.Column > 0 {
			attrs = append(attrs, "column", origin.Column)
		}
	}
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
	Status       int
	writeError   bool
	sse          bool
	hijacked     bool
	serverWriter bool
}

func (w *ResponseRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *ResponseRecorder) committed(status int) {
	if w.Status != 0 {
		return
	}
	w.Status = status
	mediaType, _, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	w.sse = err == nil && mediaType == "text/event-stream"
}

func (w *ResponseRecorder) WriteHeader(status int) {
	if w.Status != 0 {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	if status == http.StatusSwitchingProtocols || status >= 200 {
		w.committed(status)
	}
}

func (w *ResponseRecorder) Write(data []byte) (int, error) {
	n, err := w.ResponseWriter.Write(data)
	if n > 0 || err == nil || (w.serverWriter && !w.hijacked && !errors.Is(err, http.ErrHijacked)) {
		w.committed(http.StatusOK)
	}
	if err != nil || n < len(data) {
		w.writeError = true
	}
	return n, err
}

func (w *ResponseRecorder) FlushError() error {
	err := http.NewResponseController(w.ResponseWriter).Flush()
	if err != nil {
		w.writeError = true
	}
	if err == nil || (w.serverWriter && !w.hijacked && !errors.Is(err, http.ErrNotSupported)) {
		w.committed(http.StatusOK)
	}
	return err
}

func (w *ResponseRecorder) hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err != nil {
		w.writeError = true
	} else {
		w.hijacked = true
	}
	return conn, rw, err
}

// Preserve capability checks while routing supported operations through the recorder.
type flushRecorder struct{ *ResponseRecorder }

func (w flushRecorder) Flush() { _ = w.FlushError() }

type hijackRecorder struct{ *ResponseRecorder }

func (w hijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) { return w.hijack() }

type flushHijackRecorder struct{ *ResponseRecorder }

func (w flushHijackRecorder) Flush()                                       { _ = w.FlushError() }
func (w flushHijackRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) { return w.hijack() }

func (w *ResponseRecorder) capabilities() http.ResponseWriter {
	var flush, hijack bool
	for current := w.ResponseWriter; current != nil; {
		if _, ok := current.(http.Flusher); ok {
			flush = true
		}
		if _, ok := current.(http.Hijacker); ok {
			hijack = true
		}
		unwrapper, ok := current.(interface{ Unwrap() http.ResponseWriter })
		if !ok {
			break
		}
		current = unwrapper.Unwrap()
	}
	switch {
	case flush && hijack:
		return flushHijackRecorder{w}
	case flush:
		return flushRecorder{w}
	case hijack:
		return hijackRecorder{w}
	default:
		return w
	}
}

func (w *ResponseRecorder) mode() string {
	if w.hijacked {
		return "websocket"
	}
	if w.sse {
		return "sse"
	}
	return "http"
}

func RequestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return RequestLoggingWithMetrics(logger, next, nil)
}

// RequestLoggingWithMetrics observes the same response and handler lifecycle as logging.
func RequestLoggingWithMetrics(logger *slog.Logger, next http.Handler, metrics *RequestMetrics) http.Handler {
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
		// net/http commits an implicit 200 before attempting Write or Flush,
		// including when the subsequent transport operation fails. Arbitrary
		// ResponseWriters do not provide a way to inspect their commit state.
		recorder := &ResponseRecorder{ResponseWriter: w, serverWriter: request.Context().Value(http.ServerContextKey) != nil}
		start := time.Now()
		if metrics != nil {
			metrics.inFlight.Inc()
		}
		defer func() {
			value := recover()
			if metrics != nil {
				outcome := "returned"
				switch {
				case value != nil && value != http.ErrAbortHandler:
					outcome = "panic"
				case value == http.ErrAbortHandler:
					outcome = "aborted"
				case recorder.writeError:
					outcome = "write_error"
				case request.Context().Err() != nil:
					outcome = "canceled"
				}
				metrics.observe(request, recorder, start, outcome)
			}
			if value != nil {
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
		next.ServeHTTP(recorder.capabilities(), request)
		status := recorder.Status
		if status == 0 {
			status = http.StatusOK
		}
		logger.InfoContext(request.Context(), "request completed", "type", "http_request", "component", "server",
			"phase", "response", "request_id", id, "method", request.Method, "route", request.Pattern,
			"status", status, "duration", time.Since(start))
	})
}
