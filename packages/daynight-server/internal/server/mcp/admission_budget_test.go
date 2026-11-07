package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestFailedContentAdmissionRetainsControlUntilDelivery(t *testing.T) {
	e := materializationEntry(t, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) { return ToolResult{}, nil })
	schema := map[string]any{"type": "object"}
	if err := e.registerReadTool(&sdk.Tool{Name: "promote", InputSchema: schema, OutputSchema: schema}, func(json.RawMessage) BudgetClass { return BudgetControl }, func(ctx context.Context, a RequestActor, _ json.RawMessage) (ToolResult, error) {
		return ToolResult{}, a.admitContent(ctx)
	}); err != nil {
		t.Fatal(err)
	}
	releases := make([]func(), 0, 19)
	for i := 0; i < 4; i++ {
		release, err := e.budget.Acquire(t.Context(), BudgetContent)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	for i := 0; i < 15; i++ {
		release, err := e.budget.Acquire(t.Context(), BudgetControl)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	t.Cleanup(func() {
		for _, release := range releases {
			release()
		}
	})
	started, allow := make(chan struct{}), make(chan struct{})
	served := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(allow) }) }
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(served)
		e.ServeHTTP(&blockedDeliveryWriter{ResponseWriter: w, release: allow, signal: func() {
			select {
			case <-started:
			default:
				close(started)
			}
		}}, r)
	})))
	t.Cleanup(server.Close)
	t.Cleanup(unblock)
	result := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		r, err := materializationCall(ctx, server.URL, "busy", "promote")
		if err == nil && (!r.Result.IsError || r.Result.StructuredContent.Error.Code != "resource_busy") {
			err = errors.New("expected resource_busy")
		}
		result <- err
	}()
	waitMaterialization(t, started, "busy response delivery")
	if release, err := e.budget.Acquire(t.Context(), BudgetControl); !errors.Is(err, ErrResourceBusy) {
		if err == nil {
			release()
		}
		t.Fatalf("control released before busy delivery: %v", err)
	}
	unblock()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("response did not finish")
	}
	select {
	case <-served:
	case <-time.After(5 * time.Second):
		t.Fatal("handler did not finish")
	}
	release, err := e.budget.Acquire(t.Context(), BudgetControl)
	if err != nil {
		t.Fatalf("control not released: %v", err)
	}
	release()
}
