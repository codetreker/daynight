package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testConfig(t *testing.T) Config {
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

func TestStartupFailures(t *testing.T) {
	config := testConfig(t)
	unavailable := filepath.Join(config.StorageRoot, "file")
	if err := os.WriteFile(unavailable, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	invalidStorage := config
	invalidStorage.StorageRoot = unavailable
	_, err := Start(context.Background(), invalidStorage, testLogger(), nil)
	var configurationFailure *ConfigurationError
	if !errors.As(err, &configurationFailure) || configurationFailure.Field != "DAYNIGHT_STORAGE_ROOT" || errors.Unwrap(err) == nil {
		t.Fatalf("storage initialization failure lost configuration context or cause: %v", err)
	}
	invalid := config
	invalid.ListenAddress = "0.0.0.0:80"
	if _, err := Start(context.Background(), invalid, testLogger(), nil); err == nil {
		t.Fatal("accepted non-loopback listener")
	}
	invalid = config
	invalid.DatabaseURL = "postgres://secret:password@bad%host/database"
	if _, err := Start(context.Background(), invalid, testLogger(), nil); err == nil {
		t.Fatal("accepted malformed database configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Start(ctx, config, testLogger(), nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled startup lost cause: %v", err)
	}
	listener, err := net.Listen("tcp", config.ListenAddress)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	config.ListenAddress = listener.Addr().String()
	_, err = Start(context.Background(), config, testLogger(), nil)
	var failure *runtimeError
	if !errors.As(err, &failure) || failure.phase != "listen" || errors.Unwrap(err) == nil {
		t.Fatalf("listener failure lost cause: %v", err)
	}
}

func TestGracefulDrainPreservesActiveRequestsAndReleasesResources(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	canceled := make(chan bool, 1)
	runtime, err := Start(context.Background(), testConfig(t), testLogger(), func(dependencies Dependencies) (http.Handler, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(entered)
			select {
			case <-r.Context().Done():
				canceled <- true
			case <-release:
				canceled <- false
				if err := dependencies.Store.Pool.Ping(r.Context()); err != nil {
					t.Error(err)
				}
				if _, err := dependencies.Files.Put(r.Context(), "runtime", "active.txt", strings.NewReader("complete")); err != nil {
					t.Error(err)
				}
				_, _ = io.WriteString(w, "complete")
			}
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
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
	if _, err := runtime.Store.Pool.Acquire(context.Background()); err == nil {
		t.Fatal("database pool remained open")
	}
	if object, err := runtime.Files.Open(context.Background(), "runtime", "active.txt"); err == nil {
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
	runtime, err := Start(context.Background(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			connection, err := dependencies.Store.Pool.Acquire(r.Context())
			if err != nil {
				queryResult <- err
				return
			}
			defer connection.Release()
			_, err = connection.Exec(r.Context(), query)
			queryResult <- err
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
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
	runtime, err := Start(context.Background(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, err := dependencies.Store.Pool.Exec(r.Context(), query)
			queryResult <- err
		}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
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
	if err := runtime.Store.Pool.Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
	stop()
	if err := await(t, result); err != nil {
		t.Fatal(err)
	}
}

func TestServeFailureAndAlreadyClosed(t *testing.T) {
	for _, closed := range []bool{false, true} {
		runtime, err := Start(context.Background(), testConfig(t), testLogger(), func(Dependencies) (http.Handler, error) { return http.NotFoundHandler(), nil })
		if err != nil {
			t.Fatal(err)
		}
		if closed {
			runtime.http.Close()
		} else {
			runtime.listener.Close()
		}
		err = runtime.Run(context.Background())
		if closed && err != nil {
			t.Fatalf("normal server close: %v", err)
		}
		if !closed && !errors.Is(err, net.ErrClosed) {
			t.Fatalf("unexpected serve failure: %v", err)
		}
		if _, err := runtime.Store.Pool.Acquire(context.Background()); err == nil {
			t.Fatal("failed server leaked pool")
		}
	}
}

func TestCompositionFailureReleasesOpenedResources(t *testing.T) {
	for _, missingHandler := range []bool{false, true} {
		config := testConfig(t)
		listener, err := net.Listen("tcp", config.ListenAddress)
		if err != nil {
			t.Fatal(err)
		}
		config.ListenAddress = listener.Addr().String()
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
		cause := errors.New("composition failed")
		var opened Dependencies
		_, err = Start(context.Background(), config, testLogger(), func(dependencies Dependencies) (http.Handler, error) {
			opened = dependencies
			if _, err := dependencies.Files.Put(context.Background(), "runtime", "composition.txt", strings.NewReader("allocated")); err != nil {
				return nil, err
			}
			if missingHandler {
				return nil, nil
			}
			return nil, cause
		})
		var failure *runtimeError
		if !errors.As(err, &failure) || failure.phase != "composition" || !missingHandler && !errors.Is(err, cause) {
			t.Fatalf("composition failure lost phase/cause: %v", err)
		}
		if _, err := opened.Store.Pool.Acquire(context.Background()); err == nil {
			t.Fatal("composition failure retained database pool")
		}
		if object, err := opened.Files.Open(context.Background(), "runtime", "composition.txt"); err == nil {
			object.Body.Close()
			t.Fatal("composition failure retained file storage")
		}
		listener, err = net.Listen("tcp", config.ListenAddress)
		if err != nil {
			t.Fatalf("composition failure retained listener: %v", err)
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
