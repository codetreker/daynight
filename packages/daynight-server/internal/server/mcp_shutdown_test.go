package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
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
	var routes *sessionRoutes
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
		routes = newSessionRoutes(sessionrelay.New(deps.Store, deps.Files), nil, testLogger())
		return &sessionApplication{Handler: endpoint, relay: routes, mcp: endpoint}, nil
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
	if err := await(t, runtimeDone); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected bounded shutdown timeout, got %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("runtime did not return within the shutdown bound")
	}
	probe, stopProbe := context.WithTimeout(context.Background(), time.Second)
	defer stopProbe()
	if err := runtime.Store.Pool.Ping(probe); err != nil {
		t.Fatalf("database closed while MCP work remained active: %v", err)
	}
	if _, err := runtime.Files.Put(probe, "runtime", "shutdown.txt", strings.NewReader("active")); err != nil {
		t.Fatalf("files closed while MCP work remained active: %v", err)
	}
	routes.mutex.Lock()
	closing := routes.closing
	routes.mutex.Unlock()
	if closing {
		t.Fatal("relay stopped before the active MCP handler exited")
	}

	releaseWork()
	await(t, clientDone)
	deadline := time.Now().Add(5 * time.Second)
	for {
		routes.mutex.Lock()
		closing = routes.closing
		routes.mutex.Unlock()
		probe, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		databaseClosed := errors.Is(runtime.Store.Pool.Ping(probe), puddle.ErrClosedPool)
		object, openErr := runtime.Files.Open(probe, "runtime", "shutdown.txt")
		if openErr == nil {
			_ = object.Body.Close()
		}
		cancel()
		filesClosed := errors.Is(openErr, os.ErrClosed)
		if closing && databaseClosed && filesClosed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("resources not released after MCP and relay stop: relay=%v databaseClosed=%v filesClosed=%v", closing, databaseClosed, filesClosed)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
