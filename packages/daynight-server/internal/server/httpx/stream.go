package httpx

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"time"
)

// DeadlineBody applies an absolute deadline only when the consumer first reads.
// A complete read clears the deadline; an incomplete read or Close makes the
// connection non-reusable. Read errors preserve their cause in BodyReadError.
// As with http.Request.Body, Read and Close are owned by one consumer.
type DeadlineBody struct {
	w            http.ResponseWriter
	request      *http.Request
	source       io.ReadCloser
	timeout      time.Duration
	deadline     time.Time
	stop         func() bool
	callbackDone chan struct{}
	finished     bool
}

func NewDeadlineBody(w http.ResponseWriter, r *http.Request, timeout time.Duration) *DeadlineBody {
	source := r.Body
	if source == nil {
		source = http.NoBody
	}
	return &DeadlineBody{w: w, request: r, source: source, timeout: timeout}
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
		if err := controller.SetReadDeadline(b.deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
			b.finish()
			CloseUnreadBody(b.w, b.request)
			return 0, &BodyReadError{Cause: err, Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
		}
		b.callbackDone = make(chan struct{})
		b.stop = context.AfterFunc(b.request.Context(), func() { _ = controller.SetReadDeadline(time.Now()); close(b.callbackDone) })
	}
	n, err := b.source.Read(p)
	if err == nil {
		return n, nil
	}
	b.finish()
	if b.request.Context().Err() != nil && time.Now().Before(b.deadline) {
		CloseUnreadBody(b.w, b.request)
		return n, &BodyReadError{Cause: b.request.Context().Err(), Status: http.StatusBadRequest, Code: "invalid_input", Message: "unable to read request body"}
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
