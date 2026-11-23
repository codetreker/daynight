package httpx

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

// DeadlineBody applies an absolute deadline only when the consumer first reads.
// A complete read clears the deadline; an incomplete read or Close makes the
// connection non-reusable. Read errors preserve their cause in BodyReadError.
// As with http.Request.Body, Read and Close are owned by one consumer.
type DeadlineBody struct {
	w            http.ResponseWriter
	request      *http.Request
	readContext  context.Context
	source       io.ReadCloser
	timeout      time.Duration
	idleTimeout  time.Duration
	deadline     time.Time
	stop         func() bool
	callbackDone chan struct{}
	finished     bool
	deadlineMu   sync.Mutex
}

// NewStreamingDeadlineBody bounds both an entire transfer and each idle read.
func NewStreamingDeadlineBody(w http.ResponseWriter, r *http.Request, idle, total time.Duration) *DeadlineBody {
	b := NewDeadlineBody(w, r, total)
	b.idleTimeout = idle
	return b
}

func NewDeadlineBody(w http.ResponseWriter, r *http.Request, timeout time.Duration) *DeadlineBody {
	source := r.Body
	if source == nil {
		source = http.NoBody
	}
	return &DeadlineBody{w: w, request: r, readContext: r.Context(), source: source, timeout: timeout}
}

// SetReadContext binds the operation that consumes the body. The caller sets
// it before reading, while the original request still owns the connection.
func (b *DeadlineBody) SetReadContext(ctx context.Context) {
	b.readContext = ctx
}

func (b *DeadlineBody) finish() {
	if b.finished {
		return
	}
	b.finished = true
	if b.stop != nil && !b.stop() {
		<-b.callbackDone
	}
}

func (b *DeadlineBody) Read(p []byte) (int, error) {
	if b.finished {
		return 0, io.EOF
	}
	controller := http.NewResponseController(b.w)
	if b.stop == nil {
		b.deadline = time.Now().Add(b.timeout)
		if b.idleTimeout == 0 {
			if err := controller.SetReadDeadline(b.deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
				b.finish()
				CloseUnreadBody(b.w, b.request)
				return 0, &BodyReadError{Cause: err, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
			}
		}
		b.callbackDone = make(chan struct{})
		b.stop = context.AfterFunc(b.readContext, func() {
			b.deadlineMu.Lock()
			_ = controller.SetReadDeadline(time.Now())
			b.deadlineMu.Unlock()
			close(b.callbackDone)
		})
	}
	if b.idleTimeout > 0 {
		b.deadlineMu.Lock()
		if err := b.readContext.Err(); err != nil {
			b.deadlineMu.Unlock()
			b.finish()
			CloseUnreadBody(b.w, b.request)
			return 0, &BodyReadError{Cause: err, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
		}
		deadline := time.Now().Add(b.idleTimeout)
		if deadline.After(b.deadline) {
			deadline = b.deadline
		}
		err := controller.SetReadDeadline(deadline)
		b.deadlineMu.Unlock()
		if err != nil && !errors.Is(err, http.ErrNotSupported) {
			b.finish()
			CloseUnreadBody(b.w, b.request)
			return 0, &BodyReadError{Cause: err, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
		}
	}
	n, err := b.source.Read(p)
	if err == nil {
		return n, nil
	}
	b.finish()
	if readErr := b.readContext.Err(); readErr != nil && time.Now().Before(b.deadline) {
		CloseUnreadBody(b.w, b.request)
		return n, &BodyReadError{Cause: readErr, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
	}
	if err == io.EOF {
		if clearErr := controller.SetReadDeadline(time.Time{}); clearErr != nil && !errors.Is(clearErr, http.ErrNotSupported) {
			CloseUnreadBody(b.w, b.request)
			return n, &BodyReadError{Cause: clearErr, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
		}
		b.request.Body = http.NoBody
		return n, io.EOF
	}
	CloseUnreadBody(b.w, b.request)
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return n, &BodyReadError{Cause: err, Status: http.StatusRequestTimeout, Code: "request_timeout", Message: "request body read timed out"}
	}
	return n, &BodyReadError{Cause: err, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
}

func (b *DeadlineBody) Close() error {
	if !b.finished {
		b.finish()
		CloseUnreadBody(b.w, b.request)
	}
	return b.source.Close()
}
