package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
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
}

type runtimeError struct {
	phase string
	cause error
}

func (e *runtimeError) Error() string { return fmt.Sprintf("HTTP %s failed", e.phase) }
func (e *runtimeError) Unwrap() error { return e.cause }

func Start(ctx context.Context, config Config, logger *slog.Logger, handler func(Dependencies) (http.Handler, error)) (*Runtime, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	startup, cancel := context.WithTimeout(ctx, config.StartupTimeout)
	defer cancel()
	files, err := local.New(config.StorageRoot)
	if err != nil {
		return nil, &ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "must identify a writable storage directory with supported filename semantics", cause: err}
	}
	database, err := store.Open(startup, config.DatabaseURL)
	if err != nil {
		return nil, errors.Join(err, files.Close())
	}
	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", config.ListenAddress)
	if err != nil {
		database.Close()
		return nil, &runtimeError{phase: "listen", cause: errors.Join(err, files.Close())}
	}
	dependencies := Dependencies{Store: database, Files: files}
	application, err := handler(dependencies)
	if application == nil && err == nil {
		err = errors.New("HTTP handler is required")
	}
	if err != nil {
		database.Close()
		return nil, &runtimeError{phase: "composition", cause: errors.Join(err, listener.Close(), files.Close())}
	}
	requests, cancelRequests := context.WithCancel(context.Background())
	runtime := &Runtime{
		Dependencies: dependencies, files: files, listener: listener, logger: logger, shutdownTimeout: config.ShutdownTimeout,
		cancelRequests: cancelRequests,
		http: &http.Server{
			Handler:           RequestLogging(logger, application),
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			BaseContext:       func(net.Listener) context.Context { return requests },
		},
	}
	if graceful, ok := application.(interface{ Shutdown(context.Context) error }); ok {
		runtime.shutdownHandler = graceful.Shutdown
	}
	return runtime, nil
}

func (r *Runtime) Address() string { return r.listener.Addr().String() }

func (r *Runtime) Run(ctx context.Context) error {
	defer r.Store.Close()
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
		err = errors.Join(err, r.shutdownHandler(shutdown))
	}
	err = errors.Join(err, r.files.Close())
	if err != nil {
		return &runtimeError{phase: "shutdown", cause: err}
	}
	r.logger.InfoContext(ctx, "server stopped", "type", "lifecycle", "component", "server", "phase", "stopped")
	return nil
}
