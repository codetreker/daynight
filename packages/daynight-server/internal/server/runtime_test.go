package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func testConfig(t *testing.T) configpkg.Config {
	t.Helper()
	config := configuredTestConfig()
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

func runtimeWaitOperation(t *testing.T, database *runtimeTestStore, entered chan<- struct{}, result chan<- error) http.Handler {
	t.Helper()
	plan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "observed": 1})
	database.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		scope := newHTTPTestSnapshot(t)
		scope.ObservedAtCall = func(inner context.Context) (time.Time, error) {
			plan.Called("observed")
			if inner != ctx {
				unexpectedHTTPCall(t, "runtime snapshot context")
			}
			close(entered)
			<-inner.Done()
			return time.Time{}, inner.Err()
		}
		return fn(scope)
	}
	return http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		result <- database.ReadSnapshot(request.Context(), func(scope store.SnapshotScope) error {
			_, err := scope.ObservedAt(request.Context())
			return err
		})
	})
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
	if err := dependencies.Store.Ready(context.Background()); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("application dependency remained open: %v", err)
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

func TestForcedDrainCancelsAdmittedSnapshot(t *testing.T) {
	config := testConfig(t)
	config.ShutdownTimeout = 30 * time.Millisecond
	entered := make(chan struct{})
	queryResult := make(chan error, 1)
	runtime, _ := startRuntimeTest(t, config, func(dependencies *runtimeTestResources) http.Handler {
		return runtimeWaitOperation(t, dependencies.Store, entered, queryResult)
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
	await(t, entered)
	start := time.Now()
	cancel()
	if err := await(t, result); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("missing bounded shutdown failure: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("shutdown exceeded bound")
	}
	if err := await(t, queryResult); !errors.Is(err, context.Canceled) {
		t.Fatalf("request did not cancel snapshot: %v", err)
	}
	await(t, clientDone)
}

type runtimeTaskDAO struct {
	store.TaskWriteDAO
	t        *testing.T
	expected store.TaskWrite
	returned model.Task
	calls    atomic.Int32
}

func (dao *runtimeTaskDAO) UpdateTask(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
	if ctx.Err() != nil || id != dao.returned.ID || !reflect.DeepEqual(values, dao.expected) || dao.calls.Add(1) != 1 {
		unexpectedHTTPCall(dao.t, "runtime task write")
	}
	return dao.returned, nil
}

type runtimeProjectScope struct {
	store.ProjectWriteScope
	tasks store.TaskWriteDAO
}

func (scope runtimeProjectScope) TaskDAO() store.TaskWriteDAO { return scope.tasks }

func TestRuntimeDrainCompletesOrCancelsAdmittedTaskWrite(t *testing.T) {
	for _, forced := range []bool{false, true} {
		t.Run(map[bool]string{false: "graceful", true: "deadline"}[forced], func(t *testing.T) {
			config := testConfig(t)
			config.ShutdownTimeout = 5 * time.Second
			if forced {
				config.ShutdownTimeout = 250 * time.Millisecond
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			releaseWrite := func() { releaseOnce.Do(func() { close(release) }) }
			defer releaseWrite()
			projectID, taskID := "b7740e45-48ed-4a87-ab82-b5136f21d25f", "e9f44f7e-f1ec-480c-bef2-9b1dc3848b76"
			values := store.TaskWrite{Title: "Drained write", Status: model.TaskTodo, DependsOn: []string{}, ExternalDependsOn: []string{}, Properties: map[string]json.RawMessage{}}
			row := model.Task{ID: taskID, ProjectID: projectID, Title: "Drained write", Status: model.TaskTodo, Version: 2}
			dao := &runtimeTaskDAO{t: t, expected: values, returned: row}
			var transactions atomic.Int32
			writeResult := make(chan error, 1)
			runtime, _ := startRuntimeTest(t, config, func(dependencies *runtimeTestResources) http.Handler {
				dependencies.Store.WriteProjectCall = func(ctx context.Context, id string, callback func(store.ProjectWriteScope) error) (store.Completion, error) {
					if id != projectID || transactions.Add(1) != 1 {
						unexpectedHTTPCall(t, "runtime project write")
					}
					close(entered)
					select {
					case <-ctx.Done():
						return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
					case <-release:
					}
					if err := callback(runtimeProjectScope{tasks: dao}); err != nil {
						return store.Completion{Outcome: store.TransactionNotCommitted}, err
					}
					return store.Completion{Outcome: store.TransactionCommitted}, nil
				}
				return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
					completion, err := dependencies.Store.WriteProject(request.Context(), projectID, func(scope store.ProjectWriteScope) error {
						_, err := scope.TaskDAO().UpdateTask(request.Context(), taskID, values)
						return err
					})
					writeResult <- err
					if err != nil || completion.Outcome != store.TransactionCommitted {
						http.Error(w, "write failed", http.StatusServiceUnavailable)
						return
					}
					_, _ = io.WriteString(w, "committed")
				})
			})
			runContext, stopRuntime := context.WithCancel(context.Background())
			requestContext, stopRequest := context.WithCancel(context.Background())
			clientDone, runtimeDone := make(chan struct{}), make(chan struct{})
			cleanupCancellationRequest(t, stopRequest, stopRuntime, clientDone, runtimeDone)
			runtimeResult := make(chan error, 1)
			go func() { defer close(runtimeDone); runtimeResult <- runtime.Run(runContext) }()
			type clientResult struct {
				status int
				body   string
				err    error
			}
			response := make(chan clientResult, 1)
			client := &http.Client{Timeout: 10 * time.Second}
			defer client.CloseIdleConnections()
			go func() {
				defer close(clientDone)
				request, err := http.NewRequestWithContext(requestContext, http.MethodPut, "http://"+runtime.Address(), nil)
				if err != nil {
					response <- clientResult{err: err}
					return
				}
				result, err := client.Do(request)
				if err != nil {
					response <- clientResult{err: err}
					return
				}
				body, err := io.ReadAll(result.Body)
				response <- clientResult{status: result.StatusCode, body: string(body), err: errors.Join(err, result.Body.Close())}
			}()
			await(t, entered)
			stopRuntime()
			if forced {
				if err := await(t, writeResult); !errors.Is(err, context.Canceled) {
					t.Fatalf("deadline did not cancel blocked task write: %v", err)
				}
				if err := await(t, runtimeResult); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("deadline drain: %v", err)
				}
				if result := await(t, response); result.err == nil && result.status < 500 {
					t.Fatalf("expired drain reported a successful write: %+v", result)
				}
			} else {
				deadline := time.NewTimer(5 * time.Second)
				defer deadline.Stop()
				ticker := time.NewTicker(time.Millisecond)
				defer ticker.Stop()
				for {
					runtime.admission.Lock()
					closing := runtime.closing
					runtime.admission.Unlock()
					if closing {
						break
					}
					select {
					case <-deadline.C:
						t.Fatal("runtime did not begin graceful drain")
					case <-ticker.C:
					}
				}
				select {
				case err := <-writeResult:
					t.Fatalf("write finished before release: %v", err)
				default:
				}
			}
			releaseWrite()
			if !forced {
				if err := await(t, writeResult); err != nil {
					t.Fatalf("drained write failed: %v", err)
				}
				if result := await(t, response); result.err != nil || result.status != http.StatusOK || result.body != "committed" {
					t.Fatalf("drained HTTP response: %+v", result)
				}
				if err := await(t, runtimeResult); err != nil {
					t.Fatalf("graceful drain: %v", err)
				}
			}
			if transactions.Load() != 1 || dao.calls.Load() != map[bool]int32{false: 1, true: 0}[forced] {
				t.Fatalf("unexpected transaction/write calls: %d/%d", transactions.Load(), dao.calls.Load())
			}
		})
	}
}

func TestClientCancellationReachesAdmittedSnapshot(t *testing.T) {
	config := testConfig(t)
	entered := make(chan struct{})
	queryResult := make(chan error, 1)
	runtime, dependencies := startRuntimeTest(t, config, func(dependencies *runtimeTestResources) http.Handler {
		return runtimeWaitOperation(t, dependencies.Store, entered, queryResult)
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
	await(t, entered)
	cancel()
	if err := await(t, response); !errors.Is(err, context.Canceled) {
		t.Fatalf("client cancellation failed: %v", err)
	}
	if err := await(t, queryResult); !errors.Is(err, context.Canceled) {
		t.Fatalf("snapshot cancellation failed: %v", err)
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
		if closed && !errors.Is(err, http.ErrServerClosed) {
			t.Fatalf("unexpected server close was not reported: %v", err)
		}
		if !closed && !errors.Is(err, net.ErrClosed) {
			t.Fatalf("unexpected serve failure: %v", err)
		}
		if err := dependencies.Store.Ready(context.Background()); !errors.Is(err, os.ErrClosed) {
			t.Fatalf("failed server retained application dependency: %v", err)
		}
	}
}

type runtimeTestStore struct {
	*httpTestStore
	closed atomic.Bool
}

func (database *runtimeTestStore) Ready(ctx context.Context) error {
	if database.closed.Load() {
		return os.ErrClosed
	}
	return ctx.Err()
}

func (database *runtimeTestStore) Close() { database.closed.Store(true) }

func (database *runtimeTestStore) ReadSnapshot(ctx context.Context, callback func(store.SnapshotScope) error) error {
	if err := database.Ready(ctx); err != nil {
		return err
	}
	return database.httpTestStore.ReadSnapshot(ctx, callback)
}

func (database *runtimeTestStore) WriteProject(ctx context.Context, id string, callback func(store.ProjectWriteScope) error) (store.Completion, error) {
	if err := database.Ready(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return database.httpTestStore.WriteProject(ctx, id, callback)
}

type runtimeTestResources struct {
	Store *runtimeTestStore
	Files *local.Storage
}

func startRuntimeTest(t *testing.T, config configpkg.Config, handler func(*runtimeTestResources) http.Handler) (*Runtime, *runtimeTestResources) {
	t.Helper()
	files, err := local.New(config.StorageRoot)
	if err != nil {
		t.Fatal(err)
	}
	database := &runtimeTestStore{httpTestStore: newHTTPTestStore(t)}
	resources := &runtimeTestResources{Store: database, Files: files}
	closeApp := func(context.Context) error { database.Close(); return files.Close() }
	runtime, err := Start(context.Background(), config.ListenAddress, config.StartupTimeout, config.ShutdownTimeout, testLogger(), handler(resources), nil, nil, nil, closeApp)
	if err != nil {
		_ = closeApp(context.Background())
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := runtime.Close(ctx); err != nil && !database.closed.Load() {
			t.Errorf("runtime cleanup retained its dependencies: %v", err)
		}
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
	if calls.Load() != 0 {
		t.Fatalf("application closed after the runtime budget: %d", calls.Load())
	}
	if err := runtime.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost grace timeout: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("application closed more than once: %d", calls.Load())
	}
}

type shutdownOrderHandler struct {
	http.Handler
	stop func()
}

func (h shutdownOrderHandler) BeginShutdown() { h.stop() }

func TestRunUsesOneDeadlineForShutdownAndResourceRelease(t *testing.T) {
	stopClaims := make(chan struct{})
	relayStarted := make(chan struct{})
	var closed atomic.Int32
	handler := shutdownOrderHandler{Handler: http.NotFoundHandler(), stop: func() { close(stopClaims) }}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 80*time.Millisecond, testLogger(), handler,
		func(ctx context.Context) error {
			select {
			case <-stopClaims:
			default:
				t.Error("relay shutdown preceded claim stop")
			}
			close(relayStarted)
			<-ctx.Done()
			return ctx.Err()
		}, nil, nil, func(context.Context) error { closed.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- runtime.Run(root) }()
	start := time.Now()
	cancel()
	await(t, relayStarted)
	if err := await(t, result); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost shutdown deadline: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("shutdown exceeded shared budget: %s", elapsed)
	}
	if closed.Load() != 0 {
		t.Fatal("released dependencies without confirming relay drain")
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

// multiCause represents an independently supplied aggregate, including malformed
// or empty aggregates that cannot establish a cancellation-only result.
type multiCause struct{ causes []error }

func (e multiCause) Error() string   { return "aggregate" }
func (e multiCause) Unwrap() []error { return e.causes }

func TestCancellationOnlyErrorClassification(t *testing.T) {
	cleanup := errors.New("cleanup failed")
	cases := []struct {
		name        string
		err         error
		onlyContext bool
	}{
		{"nil", nil, false},
		{"canceled", context.Canceled, true},
		{"wrapped deadline", fmt.Errorf("drain: %w", context.DeadlineExceeded), true},
		{"nested context causes", fmt.Errorf("close: %w", errors.Join(context.Canceled, errors.Join(fmt.Errorf("deadline: %w", context.DeadlineExceeded), context.Canceled))), true},
		{"nested mixed causes", fmt.Errorf("close: %w", errors.Join(context.Canceled, fmt.Errorf("cleanup: %w", cleanup))), false},
		{"empty aggregate", multiCause{}, false},
		{"aggregate with empty cause", multiCause{[]error{context.Canceled, nil}}, false},
		{"unrelated error", cleanup, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := onlyContextError(c.err); got != c.onlyContext {
				t.Fatalf("classify %v = %v, want %v", c.err, got, c.onlyContext)
			}
		})
	}
}

func TestConcurrentCloseWaiterDeadlineDoesNotChangeOwner(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	var relayCalls, closeCalls atomic.Int32
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), func(context.Context) error {
		relayCalls.Add(1)
		close(entered)
		<-release
		return nil
	}, nil, nil, func(context.Context) error { closeCalls.Add(1); return nil })
	if err != nil {
		t.Fatal(err)
	}
	first := make(chan error, 1)
	go func() { first <- runtime.Close(context.Background()) }()
	await(t, entered)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err = runtime.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting close did not respect its deadline: %v", err)
	}
	if relayCalls.Load() != 1 || closeCalls.Load() != 0 {
		t.Fatal("waiting caller changed the active drain")
	}
	close(release)
	if err := await(t, first); err != nil {
		t.Fatalf("owning close failed: %v", err)
	}
	if err := runtime.Close(context.Background()); err != nil {
		t.Fatalf("completed close failed: %v", err)
	}
	if relayCalls.Load() != 1 || closeCalls.Load() != 1 {
		t.Fatalf("unexpected calls: relay=%d close=%d", relayCalls.Load(), closeCalls.Load())
	}
}
