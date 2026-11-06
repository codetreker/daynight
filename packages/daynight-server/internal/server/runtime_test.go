package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testConfig(t *testing.T) configpkg.Config {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	config := configuredTestConfig()
	config.DatabaseURL = url
	config.StorageRoot = testStorageRoot(t)
	return config
}

func testStorageRoot(t *testing.T) string {
	t.Helper()
	temporary := filepath.Join("..", "..", ".tmp")
	if err := os.MkdirAll(temporary, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(temporary, "runtime-storage-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}

func testLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func await[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case result := <-channel:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for operation")
		var zero T
		return zero
	}
}

func awaitSleepingQuery(t *testing.T, databaseURL, query string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	observer, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		closeContext, closeCancel := context.WithTimeout(context.Background(), time.Second)
		defer closeCancel()
		if err := observer.Close(closeContext); err != nil {
			t.Error(err)
		}
	}()
	for {
		var sleeping bool
		if err := observer.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND pid<>pg_backend_pid() AND query=$1
			AND state='active' AND wait_event_type='Timeout' AND wait_event='PgSleep')`, query).Scan(&sleeping); err != nil {
			t.Fatal(err)
		}
		if sleeping {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("database query did not enter pg_sleep")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func cleanupCancellationRequest(t *testing.T, cancelRequest, stopRuntime context.CancelFunc, clientDone, runtimeDone <-chan struct{}) {
	t.Helper()
	t.Cleanup(func() {
		cancelRequest()
		stopRuntime()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		for _, done := range []<-chan struct{}{clientDone, runtimeDone} {
			select {
			case <-done:
			case <-ctx.Done():
				t.Error("timed out cleaning up cancellation request")
				return
			}
		}
	})
}

func TestGracefulDrainPreservesActiveRequestsAndReleasesResources(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	canceled := make(chan bool, 1)
	runtime, dependencies := startRuntimeTest(t, testConfig(t), func(dependencies *runtimeTestResources) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(entered)
			select {
			case <-r.Context().Done():
				canceled <- true
			case <-release:
				canceled <- false
				if err := dependencies.Store.Ready(r.Context()); err != nil {
					t.Error(err)
				}
				if _, err := dependencies.Files.Put(r.Context(), "runtime", "active.txt", strings.NewReader("complete")); err != nil {
					t.Error(err)
				}
				_, _ = io.WriteString(w, "complete")
			}
		})
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- runtime.Run(ctx) }()
	response := make(chan error, 1)
	go func() {
		res, err := (&http.Client{Timeout: 4 * time.Second}).Get("http://" + runtime.Address())
		if err == nil {
			defer res.Body.Close()
			var body []byte
			body, err = io.ReadAll(res.Body)
			if string(body) != "complete" {
				err = errors.New("request did not finish")
			}
		}
		response <- err
	}()
	await(t, entered)
	cancel()
	select {
	case <-canceled:
		t.Fatal("shutdown canceled active request before drain deadline")
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if await(t, canceled) {
		t.Fatal("active request canceled")
	}
	if err := await(t, response); err != nil {
		t.Fatal(err)
	}
	if err := await(t, result); err != nil {
		t.Fatal(err)
	}
	if _, err := dependencies.Store.Pool.Acquire(context.Background()); err == nil {
		t.Fatal("database pool remained open")
	}
	if object, err := dependencies.Files.Open(context.Background(), "runtime", "active.txt"); err == nil {
		object.Body.Close()
		t.Fatal("file storage remained open")
	}
	listener, err := net.Listen("tcp", runtime.Address())
	if err != nil {
		t.Fatalf("listener leaked: %v", err)
	}
	listener.Close()
}

func TestForcedDrainCancelsDatabaseWork(t *testing.T) {
	config := testConfig(t)
	config.ShutdownTimeout = 30 * time.Millisecond
	query := "select pg_sleep(10) /* " + uuid.NewString() + " */"
	queryResult := make(chan error, 1)
	runtime, _ := startRuntimeTest(t, config, func(dependencies *runtimeTestResources) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			connection, err := dependencies.Store.Pool.Acquire(r.Context())
			if err != nil {
				queryResult <- err
				return
			}
			defer connection.Release()
			_, err = connection.Exec(r.Context(), query)
			queryResult <- err
		})
	})
	ctx, cancel := context.WithCancel(context.Background())
	requestContext, cancelRequest := context.WithCancel(context.Background())
	result := make(chan error, 1)
	clientDone, runtimeDone := make(chan struct{}), make(chan struct{})
	cleanupCancellationRequest(t, cancelRequest, cancel, clientDone, runtimeDone)
	go func() {
		defer close(runtimeDone)
		result <- runtime.Run(ctx)
	}()
	go func() {
		defer close(clientDone)
		request, err := http.NewRequestWithContext(requestContext, http.MethodGet, "http://"+runtime.Address(), nil)
		if err != nil {
			t.Error(err)
			return
		}
		response, err := (&http.Client{Timeout: 4 * time.Second}).Do(request)
		if err == nil {
			response.Body.Close()
		}
	}()
	awaitSleepingQuery(t, config.DatabaseURL, query)
	start := time.Now()
	cancel()
	if err := await(t, result); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("missing bounded shutdown failure: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("shutdown exceeded bound")
	}
	if err := await(t, queryResult); !errors.Is(err, context.Canceled) {
		t.Fatalf("request did not cancel query: %v", err)
	}
	await(t, clientDone)
}

func TestClientCancellationReachesDatabase(t *testing.T) {
	config := testConfig(t)
	query := "select pg_sleep(10) /* " + uuid.NewString() + " */"
	queryResult := make(chan error, 1)
	runtime, dependencies := startRuntimeTest(t, config, func(dependencies *runtimeTestResources) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, err := dependencies.Store.Pool.Exec(r.Context(), query)
			queryResult <- err
		})
	})
	root, stop := context.WithCancel(context.Background())
	result := make(chan error, 1)
	ctx, cancel := context.WithCancel(context.Background())
	clientDone, runtimeDone := make(chan struct{}), make(chan struct{})
	cleanupCancellationRequest(t, cancel, stop, clientDone, runtimeDone)
	go func() {
		defer close(runtimeDone)
		result <- runtime.Run(root)
	}()
	response := make(chan error, 1)
	go func() {
		defer close(clientDone)
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+runtime.Address(), nil)
		if err != nil {
			response <- err
			return
		}
		res, err := (&http.Client{Timeout: 4 * time.Second}).Do(request)
		if err == nil {
			res.Body.Close()
		}
		response <- err
	}()
	awaitSleepingQuery(t, config.DatabaseURL, query)
	cancel()
	if err := await(t, response); !errors.Is(err, context.Canceled) {
		t.Fatalf("client cancellation failed: %v", err)
	}
	if err := await(t, queryResult); !errors.Is(err, context.Canceled) {
		t.Fatalf("query cancellation failed: %v", err)
	}
	if err := dependencies.Store.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	stop()
	if err := await(t, result); err != nil {
		t.Fatal(err)
	}
}

func TestServeFailureAndAlreadyClosed(t *testing.T) {
	for _, closed := range []bool{false, true} {
		runtime, dependencies := startRuntimeTest(t, testConfig(t), func(*runtimeTestResources) http.Handler { return http.NotFoundHandler() })
		if closed {
			_ = runtime.http.Close()
		} else {
			_ = runtime.listener.Close()
		}
		err := runtime.Run(context.Background())
		if closed && err != nil {
			t.Fatalf("normal server close: %v", err)
		}
		if !closed && !errors.Is(err, net.ErrClosed) {
			t.Fatalf("unexpected serve failure: %v", err)
		}
		if _, err := dependencies.Store.Pool.Acquire(context.Background()); err == nil {
			t.Fatal("failed server leaked pool")
		}
	}
}

type runtimeTestResources struct {
	Store *postgres.Store
	Files *local.Storage
}

func startRuntimeTest(t *testing.T, config configpkg.Config, handler func(*runtimeTestResources) http.Handler) (*Runtime, *runtimeTestResources) {
	t.Helper()
	files, err := local.New(config.StorageRoot)
	if err != nil {
		t.Fatal(err)
	}
	store, err := postgres.Open(context.Background(), config.DatabaseURL)
	if err != nil {
		_ = files.Close()
		t.Fatal(err)
	}
	resources := &runtimeTestResources{Store: store, Files: files}
	closeApp := func(context.Context) error { store.Close(); return files.Close() }
	runtime, err := Start(context.Background(), config.ListenAddress, config.StartupTimeout, config.ShutdownTimeout, testLogger(), handler(resources), nil, nil, nil, closeApp)
	if err != nil {
		_ = closeApp(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = runtime.Close(ctx)
	})
	return runtime, resources
}

func TestTransportStartupFailures(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, err = Start(context.Background(), listener.Addr().String(), time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil)
	var failure *httpx.RuntimeError
	if !errors.As(err, &failure) || failure.Phase != "listen" || errors.Unwrap(err) == nil {
		t.Fatalf("listener failure lost cause: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = Start(ctx, "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation lost: %v", err)
	}
	_, err = Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), nil, nil, nil, nil, nil)
	if !errors.As(err, &failure) || failure.Phase != "composition" {
		t.Fatalf("missing handler accepted: %v", err)
	}
}

func TestCloseRetriesTimedOutHTTPDrainWithoutClosingApp(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(entered); <-release })
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 30*time.Millisecond, testLogger(), handler, nil, nil, nil, func(context.Context) error { calls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	root, stop := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- runtime.Run(root) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, e := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if e == nil {
			_ = response.Body.Close()
		}
	}()
	await(t, entered)
	stop()
	// The first Close shares Run's drain; use a bounded wait to verify resource ownership.
	time.Sleep(80 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("application closed while HTTP handler remained active")
	}
	rr := httptest.NewRecorder()
	runtime.http.Handler.ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("admitted new work after shutdown: %d", rr.Code)
	}
	close(release)
	if err := await(t, result); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost grace timeout: %v", err)
	}
	await(t, clientDone)
	if calls.Load() != 1 {
		t.Fatalf("application close count: %d", calls.Load())
	}
	if err := runtime.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost grace timeout: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("application closed more than once: %d", calls.Load())
	}
}

func TestCloseRetainsRelayWaitAcrossCleanupTimeout(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var relayCalls, appCalls atomic.Int32
	relay := func(context.Context) error { relayCalls.Add(1); close(entered); <-release; return nil }
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.NotFoundHandler(), relay, nil, nil, func(context.Context) error { appCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	if err := runtime.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cleanup timeout: %v", err)
	}
	await(t, entered)
	if relayCalls.Load() != 1 || appCalls.Load() != 0 {
		t.Fatal("relay or application closed incorrectly")
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel2()
	if err := runtime.Close(ctx2); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected retry timeout: %v", err)
	}
	if relayCalls.Load() != 1 || appCalls.Load() != 0 {
		t.Fatal("retry duplicated relay or closed resources early")
	}
	close(release)
	if err := runtime.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost grace timeout: %v", err)
	}
	if relayCalls.Load() != 1 || appCalls.Load() != 1 {
		t.Fatal("completed relay was not reused")
	}
}

func TestCloseRetainsAppAfterHTTPDrainTimeout(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var appCalls atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-release
	}), nil, nil, nil, func(context.Context) error { appCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- runtime.http.Serve(runtime.listener) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, e := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if e == nil {
			_ = response.Body.Close()
		}
	}()
	await(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
	err = runtime.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || appCalls.Load() != 0 {
		t.Fatalf("unfinished HTTP drain released application: %v, %d", err, appCalls.Load())
	}
	close(release)
	if err = runtime.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost grace timeout: %v", err)
	}
	if appCalls.Load() != 1 {
		t.Fatalf("application close count: %d", appCalls.Load())
	}
	await(t, clientDone)
	if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("unexpected serve result: %v", err)
	}
}

func TestRelayShutdownStartsDuringHTTPGrace(t *testing.T) {
	entered, release, relayStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-release
	}), func(context.Context) error { close(relayStarted); return nil }, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- runtime.http.Serve(runtime.listener) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, e := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if e == nil {
			_ = response.Body.Close()
		}
	}()
	await(t, entered)
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close(context.Background()) }()
	await(t, relayStarted)
	select {
	case err := <-closed:
		t.Fatalf("shutdown did not wait for HTTP handler: %v", err)
	default:
	}
	close(release)
	if err := await(t, closed); err != nil {
		t.Fatal(err)
	}
	await(t, clientDone)
	if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("unexpected serve result: %v", err)
	}
}

func TestAdmittedHTTPStartsOperationDuringShutdown(t *testing.T) {
	engine := sessioncore.NewEngine(nil)
	entered, proceed, relayStarted := make(chan struct{}), make(chan struct{}), make(chan struct{})
	operations := make(chan *sessioncore.Operation, 1)
	opErrors := make(chan error, 1)
	var appCalls atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(entered)
		<-proceed
		op, err := engine.BeginOperation()
		if err != nil {
			opErrors <- err
			http.Error(w, "operation rejected", http.StatusServiceUnavailable)
			return
		}
		operations <- op
		w.WriteHeader(http.StatusNoContent)
	}), func(context.Context) error { close(relayStarted); return nil }, nil, engine.Stop, func(context.Context) error { appCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- runtime.http.Serve(runtime.listener) }()
	response := make(chan int, 1)
	go func() {
		res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if err != nil {
			response <- 0
			return
		}
		_ = res.Body.Close()
		response <- res.StatusCode
	}()
	await(t, entered)
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close(context.Background()) }()
	await(t, relayStarted)
	close(proceed)
	select {
	case err := <-opErrors:
		t.Fatalf("already admitted HTTP operation rejected: %v", err)
	case op := <-operations:
		if status := await(t, response); status != http.StatusNoContent {
			t.Fatalf("HTTP request failed: %d", status)
		}
		select {
		case err := <-closed:
			t.Fatalf("shutdown released an active operation: %v", err)
		default:
		}
		if appCalls.Load() != 0 {
			t.Fatal("application closed before operation finished")
		}
		op.Close()
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP operation did not start")
	}
	if err := await(t, closed); err != nil {
		t.Fatal(err)
	}
	if appCalls.Load() != 1 {
		t.Fatal("application not closed after operation finished")
	}
	if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("unexpected serve result: %v", err)
	}
}

func TestCloseRetriesTimedOutDetachedOperation(t *testing.T) {
	engine := sessioncore.NewEngine(nil)
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	var appCalls atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.NotFoundHandler(), nil, nil, engine.Stop, func(context.Context) error { appCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
	err = runtime.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || appCalls.Load() != 0 {
		t.Fatalf("unfinished operation released application: %v, %d", err, appCalls.Load())
	}
	if _, err := engine.BeginOperation(); err == nil {
		t.Fatal("operation admission remained open after drain began")
	}
	op.Close()
	if err := runtime.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost grace timeout: %v", err)
	}
	if appCalls.Load() != 1 {
		t.Fatalf("application close count: %d", appCalls.Load())
	}
}

func TestDelayedMixedDrainErrorSurvivesRetry(t *testing.T) {
	for _, kind := range []string{"relay", "application"} {
		t.Run(kind, func(t *testing.T) {
			started, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
			sentinel := errors.New("cleanup failure")
			var attempts, closed atomic.Int32
			drain := func(context.Context) error {
				if attempts.Add(1) == 1 {
					close(started)
					<-release
					close(returned)
					return errors.Join(context.DeadlineExceeded, sentinel)
				}
				return nil
			}
			var relay, appDrain func(context.Context) error
			if kind == "relay" {
				relay = drain
			} else {
				appDrain = drain
			}
			runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.NotFoundHandler(), relay, nil, appDrain, func(context.Context) error { closed.Add(1); return nil })
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
			err = runtime.Close(ctx)
			cancel()
			if !errors.Is(err, context.DeadlineExceeded) || closed.Load() != 0 {
				t.Fatalf("unfinished drain released application: %v", err)
			}
			await(t, started)
			close(release)
			await(t, returned)
			if err := runtime.Close(context.Background()); !errors.Is(err, sentinel) || closed.Load() != 0 {
				t.Fatalf("mixed error was lost or application released: %v", err)
			}
			if err := runtime.Close(context.Background()); !errors.Is(err, sentinel) {
				t.Fatalf("successful retry lost earlier cleanup failure: %v", err)
			}
			if attempts.Load() != 2 || closed.Load() != 1 {
				t.Fatalf("unexpected attempts or resource closure: %d %d", attempts.Load(), closed.Load())
			}
		})
	}
}

func TestGraceTimeoutSignalsOperationsBeforeTransportDrain(t *testing.T) {
	engine := sessioncore.NewEngine(nil)
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	entered, releaseHTTP, relayStarted, releaseRelay := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	var appCalls atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(entered)
		<-releaseHTTP
	}), func(context.Context) error { close(relayStarted); <-releaseRelay; return nil }, engine.CancelWork, engine.Stop, func(context.Context) error { appCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan error, 1)
	go func() { served <- runtime.http.Serve(runtime.listener) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, e := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + runtime.Address())
		if e == nil {
			_ = response.Body.Close()
		}
	}()
	await(t, entered)
	closed := make(chan error, 1)
	go func() { closed <- runtime.Close(context.Background()) }()
	await(t, relayStarted)
	await(t, op.Stopping())
	if appCalls.Load() != 0 {
		t.Fatal("application closed before HTTP and relay drained")
	}
	// Relay disconnect may still need a new operation after the stop signal.
	disconnect, err := engine.BeginOperation()
	if err != nil {
		t.Fatalf("disconnect operation rejected: %v", err)
	}
	disconnect.Close()
	op.Close()
	close(releaseHTTP)
	close(releaseRelay)
	if err := await(t, closed); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost grace timeout: %v", err)
	}
	if appCalls.Load() != 1 {
		t.Fatal("application remained open after all work completed")
	}
	await(t, clientDone)
	if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("unexpected serve result: %v", err)
	}
}

type completedRelayTestError struct{ cause error }

func (e completedRelayTestError) Error() string { return e.cause.Error() }
func (e completedRelayTestError) Unwrap() error { return e.cause }
func (e completedRelayTestError) Drained() bool { return true }

func TestCompletedRelayFailureReleasesAppAndRemainsVisible(t *testing.T) {
	for _, delayed := range []bool{false, true} {
		t.Run(strconv.FormatBool(delayed), func(t *testing.T) {
			cause := errors.New("disconnect failed")
			started, release, returned := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var relayCalls, drainCalls, closeCalls atomic.Int32
			relay := func(context.Context) error {
				relayCalls.Add(1)
				close(started)
				if delayed {
					<-release
				}
				close(returned)
				return completedRelayTestError{cause}
			}
			runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 20*time.Millisecond, testLogger(), http.NotFoundHandler(), relay, nil, func(context.Context) error { drainCalls.Add(1); return nil }, func(context.Context) error { closeCalls.Add(1); return nil })
			if err != nil {
				t.Fatal(err)
			}
			if delayed {
				ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
				err = runtime.Close(ctx)
				cancel()
				if !errors.Is(err, context.DeadlineExceeded) || drainCalls.Load() != 0 || closeCalls.Load() != 0 {
					t.Fatalf("unfinished relay released application: %v", err)
				}
				await(t, started)
				close(release)
				await(t, returned)
			}
			if err := runtime.Close(context.Background()); !errors.Is(err, cause) {
				t.Fatalf("disconnect failure lost: %v", err)
			}
			if err := runtime.Close(context.Background()); !errors.Is(err, cause) {
				t.Fatalf("repeat close lost disconnect failure: %v", err)
			}
			if relayCalls.Load() != 1 || drainCalls.Load() != 1 || closeCalls.Load() != 1 {
				t.Fatalf("unexpected calls: relay=%d drain=%d close=%d", relayCalls.Load(), drainCalls.Load(), closeCalls.Load())
			}
		})
	}
}
