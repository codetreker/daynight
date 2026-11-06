package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestTeamItemReadCancellationReleasesLargeAdmission(t *testing.T) {
	f := newEntryFixture(t)
	entered := make(chan struct{})
	canceled := make(chan struct{})
	delivered := make(chan struct{})
	var reads atomic.Int32
	reader := teamItemReaderFunc(func(ctx context.Context, _ teamitem.Authority, _ teamitem.Input) (teamitem.Result, error) {
		if reads.Add(1) == 1 {
			close(entered)
			<-ctx.Done()
			close(canceled)
			return teamitem.Result{}, ctx.Err()
		}
		return teamitem.Result{Metadata: itemMemberMetadata("complete")}, nil
	})
	if err := RegisterTeamItemTool(f.entry, reader); err != nil {
		t.Fatal(err)
	}
	original := f.server.Config.Handler
	deliveryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test-Held-Item") == "1" {
			defer close(delivered)
		}
		original.ServeHTTP(w, r)
	}))
	t.Cleanup(deliveryServer.Close)
	client := f.client(t, "2026-07-28", "alice")
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": "held-item", "method": "tools/call", "params": map[string]any{"name": "team_item_read", "arguments": memberItemArguments("inspect")}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, deliveryServer.URL, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer alice")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("MCP-Protocol-Version", "2025-11-25")
	request.Header.Set("X-Test-Held-Item", "1")
	finished := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		finished <- err
	}()
	select {
	case <-entered:
	case err := <-finished:
		t.Fatalf("held read finished before entering the reader: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("held read did not enter the reader")
	}
	busy, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: memberItemArguments("inspect")})
	if err != nil || !busy.IsError || object(t, mirroredEnvelope(t, busy)["error"])["code"] != "resource_busy" || reads.Load() != 1 {
		t.Fatalf("concurrent read bypassed admission: %+v, %v; reads=%d", busy, err, reads.Load())
	}
	control, err := callTest(t, client, map[string]any{"mode": "ok"})
	if err != nil || control.IsError {
		t.Fatalf("held large read blocked control admission: %+v, %v", control, err)
	}
	cancel()
	select {
	case <-canceled:
	case <-time.After(5 * time.Second):
		t.Fatal("HTTP cancellation did not reach the bounded reader")
	}
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled HTTP call returned %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canceled HTTP call did not finish")
	}
	// The reader's cancellation receipt precedes response teardown. Wait for the
	// real HTTP scope to end before requiring its held permit to be reusable.
	select {
	case <-delivered:
	case <-time.After(5 * time.Second):
		t.Fatal("canceled response scope did not finish")
	}
	recovered, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "team_item_read", Arguments: memberItemArguments("inspect")})
	if err != nil || recovered.IsError || reads.Load() != 2 {
		t.Fatalf("canceled read leaked admission: %+v, %v; reads=%d", recovered, err, reads.Load())
	}
	if object(t, mirroredEnvelope(t, recovered)["data"])["projection"] != "metadata" {
		t.Fatal("recovered read did not return its metadata")
	}
}
