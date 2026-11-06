package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Dependencies struct {
	Store *store.Store
	Files filestorage.Storage
}

type Runtime struct {
	Dependencies

	files           *local.Storage
	listener        net.Listener
	http            *http.Server
	logger          *slog.Logger
	shutdownTimeout time.Duration
	cancelRequests  context.CancelFunc
	shutdownHandler func(context.Context) error
	beginShutdown   func()
}

func Start(ctx context.Context, config Config, logger *slog.Logger, handler func(Dependencies) (http.Handler, error)) (*Runtime, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	startup, cancel := context.WithTimeout(ctx, config.StartupTimeout)
	defer cancel()
	files, err := local.New(config.StorageRoot)
	if err != nil {
		return nil, &configpkg.ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "must identify a writable storage directory with supported filename semantics", Cause: err}
	}
	database, err := store.Open(startup, config.DatabaseURL)
	if err != nil {
		return nil, errors.Join(err, files.Close())
	}
	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", config.ListenAddress)
	if err != nil {
		database.Close()
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: errors.Join(err, files.Close())}
	}
	dependencies := Dependencies{Store: database, Files: files}
	application, err := handler(dependencies)
	if application == nil && err == nil {
		err = errors.New("HTTP handler is required")
	}
	if err != nil {
		database.Close()
		return nil, &httpx.RuntimeError{Phase: "composition", Cause: errors.Join(err, listener.Close(), files.Close())}
	}
	requests, cancelRequests := context.WithCancel(context.Background())
	runtime := &Runtime{
		Dependencies: dependencies, files: files, listener: listener, logger: logger, shutdownTimeout: config.ShutdownTimeout,
		cancelRequests: cancelRequests,
		http: &http.Server{
			Handler:           httpx.RequestLogging(logger, application),
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			BaseContext:       func(net.Listener) context.Context { return requests },
		},
	}
	if starter, ok := application.(interface{ BeginShutdown() }); ok {
		runtime.beginShutdown = starter.BeginShutdown
	}
	if graceful, ok := application.(interface{ Shutdown(context.Context) error }); ok {
		runtime.shutdownHandler = graceful.Shutdown
	}
	return runtime, nil
}

func (r *Runtime) Address() string { return r.listener.Addr().String() }

func (r *Runtime) Run(ctx context.Context) error {
	defer r.cancelRequests()
	result := make(chan error, 1)
	go func() { result <- r.http.Serve(r.listener) }()
	r.logger.InfoContext(ctx, "server started", "type", "lifecycle", "component", "server", "phase", "listening", "address", r.Address())
	var serveError error
	serveFinished := false
	select {
	case serveError = <-result:
		serveFinished = true
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), r.shutdownTimeout)
	defer cancel()
	if r.beginShutdown != nil {
		r.beginShutdown()
	}
	err := r.http.Shutdown(shutdown)
	if err != nil {
		r.cancelRequests()
		err = errors.Join(err, r.http.Close())
	}
	if !serveFinished {
		serveError = <-result
	}
	if !errors.Is(serveError, http.ErrServerClosed) {
		err = errors.Join(err, serveError)
	}
	// net/http does not wait for hijacked WebSocket connections. Stop the
	// relay and await its database work before closing shared dependencies.
	r.cancelRequests()
	if r.shutdownHandler != nil {
		shutdownErr := r.shutdownHandler(shutdown)
		err = errors.Join(err, shutdownErr)
		if errors.Is(shutdownErr, context.DeadlineExceeded) || errors.Is(shutdownErr, context.Canceled) {
			// Preserve borrowed resources until the unfinished application work stops.
			go func() { _ = r.shutdownHandler(context.Background()); _ = r.files.Close(); r.Store.Close() }()
			return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
		}
	}
	err = errors.Join(err, r.files.Close())
	r.Store.Close()
	if err != nil {
		return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
	}
	r.logger.InfoContext(ctx, "server stopped", "type", "lifecycle", "component", "server", "phase", "stopped")
	return nil
}
