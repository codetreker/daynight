package httpx

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"sync/atomic"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

// BodyReadError preserves the transport cause while exposing only a safe error.
type BodyReadError struct {
	Cause   error
	Status  int
	Code    string
	Message string
}

func (e *BodyReadError) Error() string { return e.Message }
func (e *BodyReadError) Unwrap() error { return e.Cause }

// bodyReadFailure cannot turn an uncertain transaction or cleanup failure into
// a definite transport rejection merely because its cause contains one.
func bodyReadFailure(err error) *BodyReadError {
	var found *BodyReadError
	canceled := false
	var visit func(error) bool
	visit = func(err error) bool {
		if err == nil {
			return true
		}
		switch value := err.(type) {
		case *BodyReadError:
			if found != nil && found != value {
				return false
			}
			found = value
			return true
		case *store.TransactionError:
			if value.Phase != "operation" || value.CleanupFailed || value.Outcome != store.TransactionNotCommitted {
				return false
			}
		case *store.ThreadTransactionError:
			if value.OutcomeUnknown || value.RollbackFailed || value.CommitAttempted {
				return false
			}
		case *model.BotOperationError:
			return false
		case interface{ Unwrap() []error }:
			children := value.Unwrap()
			if len(children) == 0 {
				return false
			}
			for _, child := range children {
				if !visit(child) {
					return false
				}
			}
			return true
		}
		if err == context.Canceled {
			canceled = true
			return true
		}
		if wrapped := errors.Unwrap(err); wrapped != nil {
			return visit(wrapped)
		}
		return false
	}
	if !visit(err) || found == nil || canceled && found.Status != http.StatusRequestTimeout {
		return nil
	}
	return found
}

type URITooLongError struct{}

func (*URITooLongError) Error() string { return "request target exceeds its input limit" }

type bodyCompletionKey struct{}

type trackedRequestBody struct {
	io.ReadCloser
	complete atomic.Bool
}

// NativeHTTP1RequestBody recognizes the Go 1.27 HTTP/1 server's own body
// implementations, including its Expect: 100-continue wrapper. Their Close
// drains the same socket; arbitrary middleware bodies have no such guarantee.
func NativeHTTP1RequestBody(r *http.Request) bool {
	if r.ProtoMajor != 1 {
		return false
	}
	tracked, ok := r.Context().Value(bodyCompletionKey{}).(*trackedRequestBody)
	if !ok || r.Body != tracked {
		return false
	}
	t := reflect.TypeOf(tracked.ReadCloser)
	if t == nil || t.Kind() != reflect.Pointer {
		return false
	}
	t = t.Elem()
	return t.PkgPath() == "net/http" && (t.Name() == "body" || t.Name() == "expectContinueReader")
}

func (b *trackedRequestBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.complete.Store(true)
	}
	return n, err
}

// LimitRequestTarget rejects raw transport input before routing or query decoding.
func LimitRequestTarget(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.RequestURI) > transport.MaxRequestTargetBytes || len(r.URL.RawQuery) > transport.MaxRawQueryBytes {
			WriteError(w, r, logger, "server", "request_target", &URITooLongError{})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// CloseUnreadBody prevents connection reuse and bounds net/http's automatic
// post-handler body drain to bytes already buffered by its header reader.
func CloseUnreadBody(w http.ResponseWriter, r *http.Request) {
	if r.Body == nil || r.Body == http.NoBody {
		return
	}
	if body, ok := r.Context().Value(bodyCompletionKey{}).(*trackedRequestBody); ok && body.complete.Load() {
		return
	}
	r.Close = true
	w.Header().Set("Connection", "close")
	_ = http.NewResponseController(w).SetReadDeadline(time.Now())
}

// ReadBody applies a deadline to the actual connection from the start of the
// read, clearing it only when the complete bounded body was read successfully.
func ReadBody(w http.ResponseWriter, r *http.Request, maxBytes int64, timeout time.Duration) ([]byte, error) {
	stream := NewDeadlineBody(w, r, timeout)
	body, err := io.ReadAll(http.MaxBytesReader(w, stream, maxBytes))
	if err == nil {
		return body, nil
	}
	CloseUnreadBody(w, r)
	_ = stream.Close()
	var limit *http.MaxBytesError
	if errors.As(err, &limit) {
		return nil, &BodyReadError{Cause: err, Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "request body exceeds its input limit"}
	}
	return nil, err
}

// WriteBodyError is the only cancellation-independent response path. Read
// timeouts and closing oversized chunked bodies can cancel net/http's request
// context while its response socket is still writable. Only these terminal
// input refusals may detach cancellation; business work keeps the original context.
func WriteBodyError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, component, phase string, err error) {
	bodyErr := bodyReadFailure(err)
	if bodyErr == nil {
		WriteError(w, r, logger, component, phase, err)
		return
	}
	logger.ErrorContext(r.Context(), "request body read failed", "type", "operation_error", "component", component, "phase", phase, "error_code", bodyErr.Code, "request_id", RequestID(r.Context()))
	if bodyErr.Status != http.StatusRequestTimeout && bodyErr.Status != http.StatusRequestEntityTooLarge {
		WriteJSON(w, r, logger, bodyErr.Status, api.ErrorResponse{Error: api.Error{Code: bodyErr.Code, Message: bodyErr.Message, RequestID: RequestID(r.Context())}})
		return
	}
	CloseUnreadBody(w, r)
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(time.Second)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		LogFailure(logger, r.Context(), component, "body rejection write deadline", err)
		panic(http.ErrAbortHandler)
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Second)
	defer cancel()
	WriteJSON(w, r.WithContext(ctx), logger, bodyErr.Status, api.ErrorResponse{Error: api.Error{Code: bodyErr.Code, Message: bodyErr.Message, RequestID: RequestID(ctx)}})
	if err := controller.Flush(); err != nil && !errors.Is(err, http.ErrNotSupported) {
		LogFailure(logger, r.Context(), component, "body rejection flush", err)
		panic(http.ErrAbortHandler)
	}
	if !r.Close {
		if err := controller.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
			LogFailure(logger, r.Context(), component, "body rejection clear deadline", err)
			panic(http.ErrAbortHandler)
		}
	}
}
