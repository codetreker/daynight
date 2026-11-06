package server

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type Dependencies struct {
	Store store.Transactions
	Ready func(context.Context) error
	Files filestorage.Storage
}

// requestDrain accounts for handlers independently of net/http's connection
// state, which excludes hijacked connections and does not join forced closes.
type requestDrain struct {
	mu       sync.Mutex
	active   int
	stopping bool
	done     chan struct{}
}

func newRequestDrain() *requestDrain { return &requestDrain{done: make(chan struct{})} }

func (d *requestDrain) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.mu.Lock()
		if d.stopping {
			d.mu.Unlock()
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		d.active++
		d.mu.Unlock()
		defer func() {
			d.mu.Lock()
			d.active--
			if d.stopping && d.active == 0 {
				close(d.done)
			}
			d.mu.Unlock()
		}()
		next.ServeHTTP(w, r)
	})
}

func (d *requestDrain) stop() <-chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.stopping {
		d.stopping = true
		if d.active == 0 {
			close(d.done)
		}
	}
	return d.done
}

type Runtime struct {
	Dependencies

	files            *local.Storage
	listener         net.Listener
	http             *http.Server
	logger           *slog.Logger
	shutdownTimeout  time.Duration
	cancelRequests   context.CancelFunc
	shutdownHandler  func(context.Context) error
	beginShutdown    func()
	requests         *requestDrain
	closePersistence func()
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
	database, err := service.OpenPersistence(startup, config.DatabaseURL)
	if err != nil {
		return nil, errors.Join(err, files.Close())
	}
	listener, err := (&net.ListenConfig{}).Listen(startup, "tcp", config.ListenAddress)
	if err != nil {
		database.Close()
		return nil, &httpx.RuntimeError{Phase: "listen", Cause: errors.Join(err, files.Close())}
	}
	dependencies := Dependencies{Store: database.Transactions, Ready: database.Ready, Files: files}
	application, err := handler(dependencies)
	if application == nil && err == nil {
		err = errors.New("HTTP handler is required")
	}
	if err != nil {
		database.Close()
		return nil, &httpx.RuntimeError{Phase: "composition", Cause: errors.Join(err, listener.Close(), files.Close())}
	}
	requests, cancelRequests := context.WithCancel(context.Background())
	drain := newRequestDrain()
	runtime := &Runtime{
		Dependencies: dependencies, files: files, listener: listener, logger: logger, shutdownTimeout: config.ShutdownTimeout,
		cancelRequests: cancelRequests, requests: drain, closePersistence: database.Close,
		http: &http.Server{
			Handler:           httpx.RequestLogging(logger, drain.wrap(application)),
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
	drained := r.requests.stop()
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
	// The relay must close hijacked WebSockets before waiting for handlers.
	// Pool.Close also joins pgx's asynchronous cancellation of interrupted SQL.
	r.cancelRequests()
	if r.shutdownHandler != nil {
		err = errors.Join(err, r.shutdownHandler(context.Background()))
	}
	<-drained
	r.closePersistence()
	err = errors.Join(err, r.files.Close())
	if err != nil {
		return &httpx.RuntimeError{Phase: "shutdown", Cause: err}
	}
	r.logger.InfoContext(ctx, "server stopped", "type", "lifecycle", "component", "server", "phase", "stopped")
	return nil
}
