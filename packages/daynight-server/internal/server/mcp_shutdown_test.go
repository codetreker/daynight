package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/puddle/v2"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type shutdownTestAuthenticator struct{}

func (shutdownTestAuthenticator) Authenticate(_ context.Context, kind model.CredentialKind, _ string) (model.Principal, error) {
	return model.Principal{Kind: kind, UserID: "test-user", CredentialID: "test-credential"}, nil
}

func TestMCPShutdownTimeoutRetainsDependenciesUntilWorkAndRelayStop(t *testing.T) {
	config := testConfig(t)
	config.ShutdownTimeout = 80 * time.Millisecond
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseWork := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseWork)
	fixture := sessionHTTPSetup(t)
	controller, _ := fixture.controller(t, uuid.NewString())
	routes := fixture.application.relay
	engine := fixture.application.engine
	runtime, err := Start(context.Background(), config, testLogger(), func(deps Dependencies) (http.Handler, error) {
		endpoint, err := mcphttp.New(shutdownTestAuthenticator{}, "https://daynight.test", nil, testLogger())
		if err != nil {
			return nil, err
		}
		schema := map[string]any{"type": "object"}
		if err := endpoint.RegisterTool(&sdk.Tool{Name: "wait", InputSchema: schema, OutputSchema: schema}, mcphttp.BudgetControl,
			func(ctx context.Context, _ mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
				close(entered)
				<-ctx.Done()
				close(canceled)
				// Simulate cleanup that cannot stop immediately when its request is canceled.
				<-release
				return mcphttp.ToolResult{}, ctx.Err()
			}); err != nil {
			return nil, err
		}
		return &sessionApplication{Handler: endpoint, relay: routes, engine: engine, mcp: endpoint}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runtimeDone := make(chan error, 1)
	go func() { runtimeDone <- runtime.Run(ctx) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		request, err := http.NewRequest(http.MethodPost, "http://"+runtime.Address(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wait","arguments":{}}}`))
		if err != nil {
			return
		}
		request.Header.Set("Authorization", "Bearer test")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("MCP-Protocol-Version", "2025-11-25")
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	t.Cleanup(func() {
		releaseWork()
		cancel()
		select {
		case <-clientDone:
		case <-time.After(5 * time.Second):
			t.Error("MCP client did not stop")
		}
	})
	await(t, entered)
	started := time.Now()
	cancel()
	await(t, canceled)
	select {
	case err := <-runtimeDone:
		t.Fatalf("runtime returned before the canceled MCP handler exited: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	probe, stopProbe := context.WithTimeout(context.Background(), time.Second)
	defer stopProbe()
	if err := runtime.Store.Pool.Ping(probe); err != nil {
		t.Fatalf("database closed while MCP work remained active: %v", err)
	}
	if _, err := runtime.Files.Put(probe, "runtime", "shutdown.txt", strings.NewReader("active")); err != nil {
		t.Fatalf("files closed while MCP work remained active: %v", err)
	}
	if routes.ActiveConnections() != 1 {
		t.Fatal("relay stopped its controller before the active MCP handler exited")
	}
	operation, err := engine.BeginOperation()
	if err != nil {
		t.Fatalf("session engine stopped before the active MCP handler exited: %v", err)
	}
	operation.Close()

	releaseWork()
	if err := await(t, runtimeDone); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected forced shutdown deadline, got %v", err)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatal("runtime did not finish after the MCP handler exited")
	}
	await(t, clientDone)
	read, stopRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRead()
	if _, _, err := controller.Read(read); err == nil {
		t.Fatal("relay retained controller connection after shutdown")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		closing := routes.ActiveConnections() == 0
		op, operationErr := engine.BeginOperation()
		if operationErr == nil {
			op.Close()
		}
		engineClosed := operationErr != nil
		probe, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		databaseClosed := errors.Is(runtime.Store.Pool.Ping(probe), puddle.ErrClosedPool)
		object, openErr := runtime.Files.Open(probe, "runtime", "shutdown.txt")
		if openErr == nil {
			_ = object.Body.Close()
		}
		cancel()
		filesClosed := errors.Is(openErr, os.ErrClosed)
		if closing && engineClosed && databaseClosed && filesClosed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("resources not released after MCP and relay stop: relay=%v engine=%v databaseClosed=%v filesClosed=%v", closing, engineClosed, databaseClosed, filesClosed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A canceled database query may finish locally before pgx's asynchronous
// CancelRequest reaches PostgreSQL. Runtime must join pool cleanup before
// returning to a caller that can terminate the process.
func TestForcedShutdownJoinsDatabaseCancellationWithIdleMCP(t *testing.T) {
	config := testConfig(t)
	config.ShutdownTimeout = 30 * time.Millisecond
	query := "select pg_sleep(30) /* " + uuid.NewString() + " */"
	queryDone := make(chan error, 1)
	runtime, err := Start(context.Background(), config, testLogger(), func(deps Dependencies) (http.Handler, error) {
		endpoint, err := mcphttp.New(shutdownTestAuthenticator{}, "https://daynight.test", nil, testLogger())
		if err != nil {
			return nil, err
		}
		engine := sessioncore.NewEngine(deps.Files)
		sessions := sessionservice.New(deps.Store, engine)
		relay := sessionhttp.NewRoutes(sessions, nil, testLogger())
		mux := http.NewServeMux()
		mux.Handle("/mcp", endpoint)
		mux.HandleFunc("/wait", func(w http.ResponseWriter, r *http.Request) {
			_, err := deps.Store.Pool.Exec(r.Context(), query)
			queryDone <- err
		})
		return &sessionApplication{Handler: mux, relay: relay, engine: engine, mcp: endpoint}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runtime.Run(ctx) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		response, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + runtime.Address() + "/wait")
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	t.Cleanup(func() { cancel(); await(t, clientDone) })
	awaitSleepingQuery(t, config.DatabaseURL, query)
	cancel()
	if err := await(t, done); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected forced shutdown deadline, got %v", err)
	}
	if err := await(t, queryDone); !errors.Is(err, context.Canceled) {
		t.Fatalf("database operation did not observe cancellation: %v", err)
	}
	probe, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	observer, err := pgx.Connect(probe, config.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = observer.Close(context.Background()) }()
	var active int
	if err := observer.QueryRow(probe, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query=$1 AND state='active'`, query).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatal("runtime returned before PostgreSQL stopped the canceled query")
	}
	await(t, clientDone)
}

func TestRequestDrainRejectsAdmissionAfterShutdown(t *testing.T) {
	drain := newRequestDrain()
	called := false
	handler := drain.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	<-drain.stop()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if response.Code != http.StatusServiceUnavailable || called {
		t.Fatalf("shutdown admitted a new handler: status=%d called=%v", response.Code, called)
	}
	<-drain.stop()
}

func TestApplicationShutdownWaitsForMCPBeforeStoppingRelay(t *testing.T) {
	fixture := sessionHTTPSetup(t)
	controller, _ := fixture.controller(t, uuid.NewString())
	entered, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseWork := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseWork)
	schema := map[string]any{"type": "object"}
	err := fixture.application.mcp.RegisterTool(&sdk.Tool{Name: "test_shutdown", InputSchema: schema, OutputSchema: schema}, mcphttp.BudgetControl,
		func(ctx context.Context, _ mcphttp.RequestActor, _ json.RawMessage) (mcphttp.ToolResult, error) {
			close(entered)
			<-ctx.Done()
			close(canceled)
			<-release
			return mcphttp.ToolResult{}, ctx.Err()
		})
	if err != nil {
		t.Fatal(err)
	}
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		request, err := http.NewRequest(http.MethodPost, fixture.server.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test_shutdown","arguments":{}}}`))
		if err != nil {
			return
		}
		request.Header.Set("Authorization", "Bearer "+fixture.handler.token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		request.Header.Set("MCP-Protocol-Version", "2025-11-25")
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()
	t.Cleanup(func() {
		releaseWork()
		select {
		case <-clientDone:
		case <-time.After(5 * time.Second):
			t.Error("MCP client did not stop")
		}
	})
	await(t, entered)
	shutdown, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	err = fixture.application.Shutdown(shutdown)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected MCP drain timeout, got %v", err)
	}
	await(t, canceled)
	if fixture.application.relay.ActiveConnections() != 1 {
		t.Fatal("MCP drain timeout stopped the controller relay")
	}
	operation, err := fixture.application.engine.BeginOperation()
	if err != nil {
		t.Fatalf("MCP drain timeout stopped the session engine: %v", err)
	}
	operation.Close()

	releaseWork()
	await(t, clientDone)
	shutdown, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := fixture.application.Shutdown(shutdown); err != nil {
		t.Fatalf("shutdown after MCP handler exit: %v", err)
	}
	if fixture.application.relay.ActiveConnections() != 0 {
		t.Fatal("controller relay retained its connection after shutdown")
	}
	if operation, err := fixture.application.engine.BeginOperation(); err == nil {
		operation.Close()
		t.Fatal("session engine admitted work after shutdown")
	}
	read, stopRead := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopRead()
	if _, _, err := controller.Read(read); err == nil {
		t.Fatal("controller connection remained open after shutdown")
	}
}
