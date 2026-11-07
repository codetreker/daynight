package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type materializationResult struct {
	Result struct {
		IsError           bool `json:"isError"`
		StructuredContent struct {
			Data  map[string]any `json:"data"`
			Error struct {
				Code      string `json:"code"`
				RequestID string `json:"requestId"`
			} `json:"error"`
		} `json:"structuredContent"`
	} `json:"result"`
	Error any `json:"error"`
}

func materializationCall(ctx context.Context, endpoint, requestID, tool string) (materializationResult, error) {
	var result materializationResult
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + tool + `","arguments":{"returnView":"summary"}}}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	req.Header.Set("X-Request-ID", requestID)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return result, err
	}
	defer resp.Body.Close()
	content, err := io.ReadAll(resp.Body)
	if err != nil {
		return result, err
	}
	if resp.StatusCode != http.StatusOK {
		return result, fmt.Errorf("HTTP %d: %s", resp.StatusCode, content)
	}
	if err := json.Unmarshal(content, &result); err != nil {
		return result, err
	}
	if result.Error != nil {
		return result, fmt.Errorf("JSON-RPC error: %v", result.Error)
	}
	return result, nil
}

func materializationEntry(t *testing.T, large ToolHandler) *Entry {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	schema := map[string]any{"type": "object"}
	if err = e.RegisterTool(&sdk.Tool{Name: "summary_write", InputSchema: schema, OutputSchema: schema}, BudgetLarge, large); err != nil {
		t.Fatal(err)
	}
	if err = e.RegisterTool(&sdk.Tool{Name: "control", InputSchema: schema, OutputSchema: schema}, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return e
}

func waitMaterialization(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}
func expectMaterializationBusy(t *testing.T, endpoint, id string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := materializationCall(ctx, endpoint, id, "summary_write")
	if err != nil {
		t.Fatal(err)
	}
	if !r.Result.IsError || r.Result.StructuredContent.Error.Code != "resource_busy" || r.Result.StructuredContent.Error.RequestID != id {
		t.Fatalf("expected resource_busy for %s: %#v", id, r)
	}
}

type blockedDeliveryWriter struct {
	http.ResponseWriter
	release <-chan struct{}
	signal  func()
}

func (w *blockedDeliveryWriter) Write(data []byte) (int, error) {
	w.signal()
	<-w.release
	return w.ResponseWriter.Write(data)
}
func (w *blockedDeliveryWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func TestMCPMaterializationHeldUntilSummaryDelivery(t *testing.T) {
	entered, releaseHandler := make(chan struct{}), make(chan struct{})
	deliveryStarted, releaseDelivery := make(chan struct{}), make(chan struct{})
	firstHTTPDone := make(chan struct{})
	var handlerReleaseOnce, deliveryReleaseOnce, signalDelivery sync.Once
	unblockHandler := func() { handlerReleaseOnce.Do(func() { close(releaseHandler) }) }
	unblockDelivery := func() { deliveryReleaseOnce.Do(func() { close(releaseDelivery) }) }
	var calls atomic.Int64
	e := materializationEntry(t, func(_ context.Context, _ RequestActor, raw json.RawMessage) (ToolResult, error) {
		var arguments struct {
			ReturnView string `json:"returnView"`
		}
		if err := json.Unmarshal(raw, &arguments); err != nil {
			return ToolResult{}, err
		}
		if calls.Add(1) == 1 {
			close(entered)
			<-releaseHandler
		}
		return ToolResult{Data: map[string]any{"projection": arguments.ReturnView}, Outcome: "changed"}, nil
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-ID") == "first" {
			defer close(firstHTTPDone)
			e.ServeHTTP(&blockedDeliveryWriter{ResponseWriter: w, release: releaseDelivery, signal: func() { signalDelivery.Do(func() { close(deliveryStarted) }) }}, r)
			return
		}
		e.ServeHTTP(w, r)
	})))
	t.Cleanup(server.Close)
	t.Cleanup(unblockDelivery)
	t.Cleanup(unblockHandler)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	first := make(chan error, 1)
	go func() {
		r, err := materializationCall(ctx, server.URL, "first", "summary_write")
		if err == nil && (r.Result.IsError || r.Result.StructuredContent.Data["projection"] != "summary") {
			err = fmt.Errorf("unexpected first result: %#v", r)
		}
		first <- err
	}()
	waitMaterialization(t, entered, "summary write handler")
	expectMaterializationBusy(t, server.URL, "while-handler")
	if calls.Load() != 1 {
		t.Fatalf("busy request entered write handler: %d calls", calls.Load())
	}
	controlCtx, cancelControl := context.WithTimeout(context.Background(), 5*time.Second)
	control, err := materializationCall(controlCtx, server.URL, "control-request", "control")
	cancelControl()
	if err != nil || control.Result.IsError {
		t.Fatalf("control operation blocked: %#v, %v", control, err)
	}
	unblockHandler()
	waitMaterialization(t, deliveryStarted, "blocked response delivery")
	expectMaterializationBusy(t, server.URL, "while-delivering")
	if calls.Load() != 1 {
		t.Fatalf("response delivery released the large permit: %d calls", calls.Load())
	}
	unblockDelivery()
	select {
	case err := <-first:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first response did not finish")
	}
	waitMaterialization(t, firstHTTPDone, "first HTTP handler completion")
	afterCtx, cancelAfter := context.WithTimeout(context.Background(), 5*time.Second)
	after, err := materializationCall(afterCtx, server.URL, "after-delivery", "summary_write")
	cancelAfter()
	if err != nil || after.Result.IsError {
		t.Fatalf("large permit not released after delivery: %#v, %v", after, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("handler count after release: %d", calls.Load())
	}
}

func TestMCPCanceledMaterializationHeldUntilHandlerExits(t *testing.T) {
	entered, canceled, releaseHandler := make(chan struct{}), make(chan struct{}), make(chan struct{})
	firstHTTPDone := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(releaseHandler) }) }
	var calls atomic.Int64
	e := materializationEntry(t, func(ctx context.Context, _ RequestActor, _ json.RawMessage) (ToolResult, error) {
		if calls.Add(1) == 1 {
			close(entered)
			<-ctx.Done()
			close(canceled)
			<-releaseHandler
			return ToolResult{}, ctx.Err()
		}
		return ToolResult{Data: map[string]any{"projection": "summary"}}, nil
	})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Request-ID") == "canceled" {
			defer close(firstHTTPDone)
		}
		e.ServeHTTP(w, r)
	})))
	t.Cleanup(server.Close)
	t.Cleanup(unblock)
	firstCtx, cancelFirst := context.WithCancel(context.Background())
	defer cancelFirst()
	firstDone := make(chan error, 1)
	go func() {
		_, err := materializationCall(firstCtx, server.URL, "canceled", "summary_write")
		firstDone <- err
	}()
	waitMaterialization(t, entered, "canceled write handler")
	cancelFirst()
	waitMaterialization(t, canceled, "handler cancellation")
	expectMaterializationBusy(t, server.URL, "during-canceled-cleanup")
	if calls.Load() != 1 {
		t.Fatalf("canceled operation released permit before handler exit: %d calls", calls.Load())
	}
	unblock()
	waitMaterialization(t, firstHTTPDone, "canceled request completion")
	select {
	case <-firstDone:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled client did not finish")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	after, err := materializationCall(ctx, server.URL, "after-cancel", "summary_write")
	if err != nil || after.Result.IsError {
		t.Fatalf("large permit not released after canceled handler: %#v, %v", after, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("handler count after cancellation: %d", calls.Load())
	}
}
