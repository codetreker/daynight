package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// Runtime owns the listener, transport, and admission of HTTP work. Application
// dependencies remain owned by the supplied closeApp function.
type Runtime struct {
	listener        net.Listener
	http            *http.Server
	logger          *slog.Logger
	shutdownTimeout time.Duration
	cancelRequests  context.CancelFunc
	shutdownHandler func(context.Context) error
	beginShutdown   func()
	cancelApp       func()
	drainApp        func(context.Context) error
	closeApp        func(context.Context) error

	admission sync.Mutex
	closing   bool
	active    int
	drained   chan struct{}

	closeLock  chan struct{}
	graceDone  bool
	graceErr   error
	relayDone  bool
	relay      <-chan error
	appDrain   <-chan error
	appDrained bool
	appClosed  bool
}

func Start(ctx context.Context, address string, startupTimeout, shutdownTimeout time.Duration, logger *slog.Logger, handler http.Handler, shutdownHandler func(context.Context) error, cancelApp func(), drainApp func(context.Context) error, closeApp func(context.Context) error) (*Runtime, error) {
	if handler == nil {
		return nil, &httpx.RuntimeError{Phase: "composition", Cause: errors.New("HTTP handler is required")}
	}
	startup, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	if err := startup.Err(); err != nil {
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: err}
	}
	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", address)
	if err != nil {
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: err}
	}
	if err := startup.Err(); err != nil {
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: errors.Join(err, listener.Close())}
	}
	requests, cancelRequests := context.WithCancel(context.Background())
	r := &Runtime{listener: listener, logger: logger, shutdownTimeout: shutdownTimeout, cancelRequests: cancelRequests,
		shutdownHandler: shutdownHandler, cancelApp: cancelApp, drainApp: drainApp, closeApp: closeApp, drained: make(chan struct{}), closeLock: make(chan struct{}, 1)}
	if starter, ok := handler.(interface{ BeginShutdown() }); ok {
		r.beginShutdown = starter.BeginShutdown
	}
	r.closeLock <- struct{}{}
	r.http = &http.Server{
		Handler: httpx.RequestLogging(logger, r.admit(handler)), ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return requests },
	}
	return r, nil
}

func (r *Runtime) admit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		r.admission.Lock()
		if r.closing {
			r.admission.Unlock()
			http.Error(w, "server is stopping", http.StatusServiceUnavailable)
			return
		}
		r.active++
		r.admission.Unlock()
		defer func() {
			r.admission.Lock()
			r.active--
			if r.closing && r.active == 0 {
				close(r.drained)
			}
			r.admission.Unlock()
		}()
		next.ServeHTTP(w, request)
	})
}

func (r *Runtime) stopAdmission() {
	r.admission.Lock()
	defer r.admission.Unlock()
	if !r.closing {
		r.closing = true
		if r.active == 0 {
			close(r.drained)
		}
	}
}

func (r *Runtime) startRelay(ctx context.Context) {
	if r.shutdownHandler == nil {
		r.relayDone = true
		return
	}
	if r.relayDone || r.relay != nil {
		return
	}
	result := make(chan error, 1)
	r.relay = result
	go func() { result <- r.shutdownHandler(ctx) }()
}

func (r *Runtime) waitRelay(ctx context.Context) error {
	if r.relayDone {
		return nil
	}
	select {
	case err := <-r.relay:
		r.relay = nil
		if err == nil {
			r.relayDone = true
		} else if completed, ok := err.(interface{ Drained() bool }); ok && completed.Drained() {
			r.relayDone = true
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Runtime) startAppDrain(ctx context.Context) {
	if r.drainApp == nil {
		r.appDrained = true
		return
	}
	if r.appDrained || r.appDrain != nil {
		return
	}
	result := make(chan error, 1)
	r.appDrain = result
	go func() { result <- r.drainApp(ctx) }()
}

func (r *Runtime) waitAppDrain(ctx context.Context) error {
	if r.appDrained {
		return nil
	}
	select {
	case err := <-r.appDrain:
		r.appDrain = nil
		if err == nil {
			r.appDrained = true
		}
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// onlyContextError reports cancellation only when every underlying cause is a
// context error. A joined cleanup failure must remain observable on retries.
func onlyContextError(err error) bool {
	if err == nil {
		return false
	}
	if many, ok := err.(interface{ Unwrap() []error }); ok {
		causes := many.Unwrap()
		if len(causes) == 0 {
			return false
		}
		for _, cause := range causes {
			if !onlyContextError(cause) {
				return false
			}
		}
		return true
	}
	if cause := errors.Unwrap(err); cause != nil {
		return onlyContextError(cause)
	}
	return err == context.Canceled || err == context.DeadlineExceeded
}

func waitDrained(ctx context.Context, drained <-chan struct{}) error {
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// grace is called once with closeLock held. Relay shutdown starts immediately
// so hijacked connections and their operations stop during the HTTP grace period.
func (r *Runtime) grace() error {
	if r.graceDone {
		return nil
	}
	r.graceDone = true
	r.stopAdmission()
	if r.beginShutdown != nil {
		r.beginShutdown()
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.shutdownTimeout)
	defer cancel()
	r.startRelay(ctx)
	httpErr := r.http.Shutdown(ctx)
	drainErr := waitDrained(ctx, r.drained)
	relayErr := r.waitRelay(ctx)
	var appErr error
	if httpErr == nil && drainErr == nil && r.relayDone && ctx.Err() == nil {
		r.startAppDrain(ctx)
		appErr = r.waitAppDrain(ctx)
	}
	r.graceErr = errors.Join(httpErr, drainErr, relayErr, appErr)
	if ctx.Err() != nil && !errors.Is(r.graceErr, context.DeadlineExceeded) {
		r.graceErr = errors.Join(r.graceErr, ctx.Err())
	}
	if r.graceErr != nil {
		if r.cancelApp != nil {
			r.cancelApp()
		}
		r.cancelRequests()
		if err := r.http.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			r.graceErr = errors.Join(r.graceErr, err)
		}
	}
	// Shutdown does not own the listener before Serve has started.
	if err := r.listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		r.graceErr = errors.Join(r.graceErr, err)
	}
	r.cancelRequests()
	if relayErr != nil && !r.relayDone && !onlyContextError(relayErr) {
		return relayErr
	}
	if appErr != nil && !onlyContextError(appErr) {
		return appErr
	}
	return nil
}

// finish waits for all admitted transport and application work before releasing
// shared resources. A timed-out call retains the same drain state for retry.
func (r *Runtime) finish(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !r.relayDone {
		r.startRelay(ctx)
		err := r.waitRelay(ctx)
		// An earlier grace call may have timed out while its relay was still
		// returning; consume that result before starting the cleanup attempt.
		if err != nil && !r.relayDone && ctx.Err() == nil && onlyContextError(err) {
			r.startRelay(ctx)
			err = r.waitRelay(ctx)
		}
		if err != nil {
			if r.relayDone || !onlyContextError(err) {
				r.graceErr = errors.Join(r.graceErr, err)
			}
			if !r.relayDone {
				return err
			}
		}
	}
	if err := waitDrained(ctx, r.drained); err != nil {
		return err
	}
	if !r.appDrained {
		r.startAppDrain(ctx)
		err := r.waitAppDrain(ctx)
		if err != nil && ctx.Err() == nil && onlyContextError(err) {
			r.startAppDrain(ctx)
			err = r.waitAppDrain(ctx)
		}
		if err != nil {
			if !onlyContextError(err) {
				r.graceErr = errors.Join(r.graceErr, err)
			}
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !r.appClosed && r.closeApp != nil {
		if err := r.closeApp(ctx); err != nil {
			return err
		}
	}
	r.appClosed = true
	return nil
}

func (r *Runtime) acquireClose(ctx context.Context) error {
	select {
	case <-r.closeLock:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close stops admission and retries incomplete cleanup using ctx. A grace
// timeout remains part of the result even when a later cleanup succeeds.
func (r *Runtime) Close(ctx context.Context) error {
	if err := r.acquireClose(ctx); err != nil {
		return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
	}
	defer func() { r.closeLock <- struct{}{} }()
	err := r.grace()
	if err == nil {
		err = r.finish(ctx)
	}
	if err = errors.Join(r.graceErr, err); err != nil {
		return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
	}
	return nil
}

func (r *Runtime) Address() string { return r.listener.Addr().String() }

func (r *Runtime) Run(ctx context.Context) error {
	result := make(chan error, 1)
	go func() { result <- r.http.Serve(r.listener) }()
	r.logger.InfoContext(ctx, "server started", "type", "lifecycle", "component", "server", "phase", "listening", "address", r.Address())
	var serveErr error
	served := false
	select {
	case serveErr = <-result:
		served = true
	case <-ctx.Done():
	}
	_ = r.acquireClose(context.Background())
	graceErr := r.grace()
	cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	var cleanupErr error
	if graceErr == nil {
		cleanupErr = r.finish(cleanup)
	}
	cancel()
	shutdownErr := errors.Join(r.graceErr, graceErr, cleanupErr)
	r.closeLock <- struct{}{}
	if !served {
		serveErr = <-result
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	if err := errors.Join(shutdownErr, serveErr); err != nil {
		return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
	}
	r.logger.InfoContext(ctx, "server stopped", "type", "lifecycle", "component", "server", "phase", "stopped")
	return nil
}
