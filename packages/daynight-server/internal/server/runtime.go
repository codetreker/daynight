package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/prometheus/client_golang/prometheus"
)

// Runtime owns the listeners, transports, and admission of HTTP work. Application
// dependencies remain owned by the supplied closeApp function.
type Runtime struct {
	listener        net.Listener
	http            *runtimeHTTPServer
	logger          *slog.Logger
	shutdownTimeout time.Duration
	cancelRequests  context.CancelFunc
	shutdownHandler func(context.Context) error
	beginShutdown   func()
	cancelApp       func()
	drainApp        func(context.Context) error
	closeApp        func(context.Context) error

	admissionState
	metrics *metricsServer

	closeLock        chan struct{}
	graceDone        bool
	graceErr         error
	relayDone        bool
	relay            <-chan error
	appDrain         <-chan error
	appDrained       bool
	appClosed        bool
	transportDrained bool
}

type MetricsEndpoint struct {
	Address  string
	Registry *prometheus.Registry
}

type admissionState struct {
	admission sync.Mutex
	closing   bool
	sealed    bool
	active    int
	drained   chan struct{}
}

type metricsServer struct {
	admissionState
	listener net.Listener
	http     *runtimeHTTPServer
}

// Every Close owned by Runtime is ordered with admission shutdown. Remember an
// earlier Close even if its Serve goroutine is scheduled after shutdown begins.
type runtimeHTTPServer struct {
	*http.Server
	state       *admissionState
	closedEarly bool
}

func (s *runtimeHTTPServer) Close() error {
	s.state.admission.Lock()
	if !s.state.closing {
		s.closedEarly = true
	}
	s.state.admission.Unlock()
	return s.Server.Close()
}

func (s *runtimeHTTPServer) expectedClose(err error) bool {
	s.state.admission.Lock()
	defer s.state.admission.Unlock()
	return s.state.closing && !s.closedEarly && errors.Is(err, http.ErrServerClosed)
}

func Start(ctx context.Context, address string, startupTimeout, shutdownTimeout time.Duration, logger *slog.Logger, handler http.Handler, shutdownHandler func(context.Context) error, cancelApp func(), drainApp func(context.Context) error, closeApp func(context.Context) error, metrics ...MetricsEndpoint) (*Runtime, error) {
	if handler == nil {
		return nil, &httpx.RuntimeError{Phase: "composition", Cause: errors.New("HTTP handler is required")}
	}
	if len(metrics) > 1 || len(metrics) == 1 && (metrics[0].Address == "" || metrics[0].Registry == nil) {
		return nil, &httpx.RuntimeError{Component: "metrics", Phase: "composition", Cause: errors.New("metrics address and registry are required")}
	}
	var metricsHandler http.Handler
	var requestMetrics *httpx.RequestMetrics
	if len(metrics) == 1 {
		var err error
		requestMetrics, err = httpx.NewRequestMetrics(metrics[0].Registry)
		if err != nil {
			return nil, &httpx.RuntimeError{Component: "metrics", Phase: "composition", Cause: err}
		}
		metricsHandler, err = newMetricsHandler(metrics[0].Registry, logger)
		if err != nil {
			return nil, &httpx.RuntimeError{Component: "metrics", Phase: "composition", Cause: err}
		}
	}
	startup, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	if err := startup.Err(); err != nil {
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: err}
	}
	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", address)
	if err != nil {
		return nil, &httpx.RuntimeError{Component: "server", Phase: "listen", Cause: err}
	}
	var metricsListener net.Listener
	if metricsHandler != nil {
		metricsListener, err = (&net.ListenConfig{}).Listen(startup, "tcp", metrics[0].Address)
		if err != nil {
			return nil, &httpx.RuntimeError{Component: "metrics", Phase: "listen", Cause: errors.Join(err, listener.Close())}
		}
	}
	if err := startup.Err(); err != nil {
		var metricsErr error
		if metricsListener != nil {
			metricsErr = metricsListener.Close()
		}
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: errors.Join(err, listener.Close(), metricsErr)}
	}
	requests, cancelRequests := context.WithCancel(context.Background())
	r := &Runtime{listener: listener, logger: logger, shutdownTimeout: shutdownTimeout, cancelRequests: cancelRequests,
		shutdownHandler: shutdownHandler, cancelApp: cancelApp, drainApp: drainApp, closeApp: closeApp, admissionState: admissionState{drained: make(chan struct{})}, closeLock: make(chan struct{}, 1)}
	if starter, ok := handler.(interface{ BeginShutdown() }); ok {
		r.beginShutdown = starter.BeginShutdown
	}
	r.closeLock <- struct{}{}
	r.http = &runtimeHTTPServer{state: &r.admissionState, Server: &http.Server{
		Handler: r.admitWrapped(handler, func(next http.Handler) http.Handler {
			return httpx.RequestLoggingWithMetrics(logger, httpx.LimitRequestTarget(logger, next), requestMetrics)
		}), ReadHeaderTimeout: 5 * time.Second,
		// net/http adds 4096 bytes of read-ahead to MaxHeaderBytes.
		MaxHeaderBytes: transport.MaxRequestHeadersBytes - 4096,
		IdleTimeout:    60 * time.Second, BaseContext: func(net.Listener) context.Context { return requests },
	}}
	if metricsListener != nil {
		m := &metricsServer{listener: metricsListener, admissionState: admissionState{drained: make(chan struct{})}}
		m.http = &runtimeHTTPServer{state: &m.admissionState, Server: &http.Server{
			Handler: m.admitWrapped(metricsHandler, func(next http.Handler) http.Handler {
				return metricsRequestLogging(logger, next)
			}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second,
			WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
			MaxHeaderBytes: transport.MaxRequestHeadersBytes - 4096,
			BaseContext:    func(net.Listener) context.Context { return requests },
		}}
		r.metrics = m
	}
	return r, nil
}

func (r *admissionState) admit(next http.Handler) http.Handler {
	return r.admitWrapped(next, func(handler http.Handler) http.Handler { return handler })
}

// Track the complete wrapper for admitted work: a hijacked connection is no
// longer tracked by net/http, but its request completion log can still run.
// Rejected requests use the same wrapper so shutdown does not suppress their logs.
func (r *admissionState) admitWrapped(next http.Handler, wrap func(http.Handler) http.Handler) http.Handler {
	accepted := wrap(next)
	rejected := wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "server is stopping", http.StatusServiceUnavailable)
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		r.admission.Lock()
		if r.sealed {
			r.admission.Unlock()
			http.Error(w, "server is stopping", http.StatusServiceUnavailable)
			return
		}
		closing := r.closing
		r.active++
		r.admission.Unlock()
		defer func() {
			r.admission.Lock()
			r.active--
			if r.sealed && r.active == 0 {
				close(r.drained)
			}
			r.admission.Unlock()
		}()
		if closing {
			rejected.ServeHTTP(w, request)
		} else {
			accepted.ServeHTTP(w, request)
		}
	})
}

func (r *admissionState) stopAdmission() {
	r.admission.Lock()
	defer r.admission.Unlock()
	r.closing = true
}

// Seal only after HTTP shutdown has closed its listener and stopped accepting
// requests. Any handler already running, including a rejected request's log,
// remains counted. A handler dispatched after this barrier cannot use logger.
func (r *admissionState) seal() {
	r.admission.Lock()
	defer r.admission.Unlock()
	if !r.sealed {
		r.sealed = true
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
		} else if completed, ok := err.(interface{ Drained() bool }); ok && completed.Drained() {
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
	if r.metrics != nil {
		r.metrics.stopAdmission()
	}
	if r.beginShutdown != nil {
		r.beginShutdown()
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.shutdownTimeout)
	defer cancel()
	r.startRelay(ctx)
	serverShutdown := make(chan error, 1)
	go func() { serverShutdown <- r.http.Shutdown(ctx) }()
	var metricsShutdown chan error
	if r.metrics != nil {
		metricsShutdown = make(chan error, 1)
		go func() { metricsShutdown <- r.metrics.http.Shutdown(ctx) }()
	}
	httpErr := <-serverShutdown
	var metricsErr error
	if r.metrics != nil {
		metricsErr = <-metricsShutdown
	}
	// On timeout, close live connections before sealing logging admission. A
	// late handler must not start logging after a successful drain observation.
	var earlyCloseErr, earlyMetricsCloseErr error
	if httpErr != nil {
		earlyCloseErr = r.http.Close()
		if errors.Is(earlyCloseErr, net.ErrClosed) {
			earlyCloseErr = nil
		}
		httpErr = &httpx.RuntimeError{Component: "server", Phase: "shutdown", Cause: httpErr}
	}
	if metricsErr != nil {
		earlyMetricsCloseErr = r.metrics.http.Close()
		if errors.Is(earlyMetricsCloseErr, net.ErrClosed) {
			earlyMetricsCloseErr = nil
		} else if earlyMetricsCloseErr != nil {
			earlyMetricsCloseErr = &httpx.RuntimeError{Component: "metrics", Phase: "shutdown", Cause: earlyMetricsCloseErr}
		}
		metricsErr = &httpx.RuntimeError{Component: "metrics", Phase: "shutdown", Cause: metricsErr}
	}
	r.seal()
	var metricsDrainErr error
	if r.metrics != nil {
		r.metrics.seal()
		metricsDrainErr = waitDrained(ctx, r.metrics.drained)
	}
	drainErr := waitDrained(ctx, r.drained)
	relayErr := r.waitRelay(ctx)
	var appErr error
	if httpErr == nil && metricsErr == nil && drainErr == nil && metricsDrainErr == nil && r.relayDone && ctx.Err() == nil {
		r.startAppDrain(ctx)
		appErr = r.waitAppDrain(ctx)
	}
	// Resource release belongs to the same budget as transport and application
	// draining. A timed-out process must not close dependencies still in use.
	var closeErr error
	if httpErr == nil && metricsErr == nil && drainErr == nil && metricsDrainErr == nil && r.relayDone && r.appDrained && ctx.Err() == nil {
		closeErr = r.finish(ctx)
	}
	r.graceErr = errors.Join(httpErr, metricsErr, earlyCloseErr, earlyMetricsCloseErr, drainErr, metricsDrainErr, relayErr, appErr, closeErr)
	if ctx.Err() != nil && !errors.Is(r.graceErr, context.DeadlineExceeded) {
		r.graceErr = errors.Join(r.graceErr, ctx.Err())
	}
	if r.graceErr != nil {
		if r.cancelApp != nil {
			r.cancelApp()
		}
		r.cancelRequests()
		if httpErr == nil {
			if err := r.http.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				r.graceErr = errors.Join(r.graceErr, err)
			}
		}
		if r.metrics != nil && metricsErr == nil {
			if err := r.metrics.http.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				r.graceErr = errors.Join(r.graceErr, &httpx.RuntimeError{Component: "metrics", Phase: "shutdown", Cause: err})
			}
		}
	}
	// Shutdown does not own the listener before Serve has started.
	if err := r.listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		r.graceErr = errors.Join(r.graceErr, err)
	}
	if r.metrics != nil {
		if err := r.metrics.listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			r.graceErr = errors.Join(r.graceErr, &httpx.RuntimeError{Component: "metrics", Phase: "shutdown", Cause: err})
		}
	}
	r.cancelRequests()
	if relayErr != nil && !r.relayDone && !onlyContextError(relayErr) {
		return relayErr
	}
	if appErr != nil && !r.appDrained && !onlyContextError(appErr) {
		return appErr
	}
	if closeErr != nil && !r.appClosed && !onlyContextError(closeErr) {
		return closeErr
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
	if r.metrics != nil {
		if err := waitDrained(ctx, r.metrics.drained); err != nil {
			return err
		}
	}
	if !r.appDrained {
		r.startAppDrain(ctx)
		err := r.waitAppDrain(ctx)
		if err != nil && !r.appDrained && ctx.Err() == nil && onlyContextError(err) {
			r.startAppDrain(ctx)
			err = r.waitAppDrain(ctx)
		}
		if err != nil {
			if r.appDrained || !onlyContextError(err) {
				r.graceErr = errors.Join(r.graceErr, err)
			}
			if !r.appDrained {
				return err
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	r.transportDrained = true
	if !r.appClosed && r.closeApp != nil {
		if err := r.closeApp(ctx); err != nil {
			if completed, ok := err.(interface{ Closed() bool }); ok && completed.Closed() {
				r.appClosed = true
			}
			if r.appClosed || !onlyContextError(err) {
				r.graceErr = errors.Join(r.graceErr, err)
			}
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

func (r *Runtime) MetricsAddress() string {
	if r.metrics == nil {
		return ""
	}
	return r.metrics.listener.Addr().String()
}

// TransportDrained reports whether all admitted transport work has stopped.
func (r *Runtime) TransportDrained() bool {
	_ = r.acquireClose(context.Background())
	defer func() { r.closeLock <- struct{}{} }()
	return r.transportDrained
}

func (r *Runtime) Run(ctx context.Context) error {
	type serveResult struct {
		component string
		err       error
		expected  bool
	}
	result := make(chan serveResult, 2)
	serve := func(component string, server *runtimeHTTPServer, listener net.Listener) {
		err := server.Serve(listener)
		result <- serveResult{component, err, server.expectedClose(err)}
	}
	go serve("server", r.http, r.listener)
	r.logger.InfoContext(ctx, "server started", "type", "lifecycle", "component", "server", "phase", "listening", "address", r.Address())
	count := 1
	if r.metrics != nil {
		count++
		go serve("metrics", r.metrics.http, r.metrics.listener)
		r.logger.InfoContext(ctx, "metrics started", "type", "lifecycle", "component", "metrics", "phase", "listening", "address", r.MetricsAddress())
	}
	var serveErr error
	remaining := count
	select {
	case outcome := <-result:
		remaining--
		if !outcome.expected {
			serveErr = &httpx.RuntimeError{Component: outcome.component, Phase: "serve", Cause: outcome.err}
		}
	case <-ctx.Done():
	}
	_ = r.acquireClose(context.Background())
	graceErr := r.grace()
	shutdownErr := errors.Join(r.graceErr, graceErr)
	r.closeLock <- struct{}{}
	for ; remaining > 0; remaining-- {
		outcome := <-result
		if !outcome.expected {
			serveErr = errors.Join(serveErr, &httpx.RuntimeError{Component: outcome.component, Phase: "serve", Cause: outcome.err})
		}
	}
	if err := errors.Join(shutdownErr, serveErr); err != nil {
		return err
	}
	r.logger.InfoContext(ctx, "server stopped", "type", "lifecycle", "component", "server", "phase", "stopped")
	return nil
}
