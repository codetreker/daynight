package remote

import (
	"context"
	"net/http"
	"time"
)

type checkpointKey struct{}
type checkpointError struct{ cause error }

func (e *checkpointError) Error() string { return e.cause.Error() }
func (e *checkpointError) Unwrap() error { return e.cause }

// WithRequestCheckpoint associates a checkpoint with one remote operation. It is
// called before each HTTP request, including redirects and authentication. A
// checkpoint error stops the operation and is available through errors.Is/As.
// The checkpoint must bound its own work and honor the supplied context.
func WithRequestCheckpoint(ctx context.Context, checkpoint func(context.Context) error) context.Context {
	return context.WithValue(ctx, checkpointKey{}, checkpoint)
}

// CheckpointRequest executes the operation's checkpoint before a request.
// A context without a checkpoint only checks cancellation.
func CheckpointRequest(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if checkpoint, ok := ctx.Value(checkpointKey{}).(func(context.Context) error); ok && checkpoint != nil {
		if err := checkpoint(ctx); err != nil {
			return &checkpointError{cause: err}
		}
	}
	return ctx.Err()
}

type checkpointTransport struct{ base http.RoundTripper }

func (t checkpointTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	ctx := req.Context()
	if err := CheckpointRequest(ctx); err != nil {
		return nil, err
	}
	// Each hop has its own network budget; checkpoint work uses its own budget.
	requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	request := req.Clone(requestCtx)
	base := t.base
	if base == nil {
		base = http.DefaultTransport
	}
	resp, err := base.RoundTrip(request)
	if err != nil {
		cause := requestCtx.Err()
		cancel()
		if cause != nil {
			return nil, cause
		}
		return nil, err
	}
	if resp.Request == nil {
		resp.Request = request
	}
	resp.Body = &cancelBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}
