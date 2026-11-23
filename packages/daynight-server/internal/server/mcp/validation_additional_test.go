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
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestSchemaCompilationFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		schema any
	}{
		{"not JSON serializable", make(chan int)},
		{"not a schema", map[string]any{"type": "not-a-json-type"}},
		{"unresolved reference", map[string]any{"$ref": "#/$defs/missing"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := resolveSchema(tc.schema); err == nil {
				t.Fatalf("compiled invalid schema %#v", tc.schema)
			}
		})
	}
}

func TestErrorResultRetainsFactsWhenReferenceCannotEncode(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	result := e.errorResult(RequestActor{}, envelopeError{Code: "version_conflict", Message: "conflict", RequestID: "original", WriteOutcome: "confirmed", Phase: "output", Refs: map[string]any{"bad": make(chan int)}})
	if !result.IsError {
		t.Fatal("expected error")
	}
	failure := object(t, structured(t, result)["error"])
	if failure["code"] != "version_conflict" || failure["requestId"] != "original" || failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" {
		t.Fatalf("lost established facts: %#v", failure)
	}
	if _, ok := failure["refs"]; ok {
		t.Fatalf("unencodable refs included: %#v", failure)
	}
}

func TestErrorResultNormalizesUnknownWriteOutcome(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	result := e.errorResult(RequestActor{}, envelopeError{Code: "internal_error", Message: "failure", RequestID: "original", WriteOutcome: "unsupported"})
	failure := object(t, structured(t, result)["error"])
	if _, ok := failure["writeOutcome"]; ok {
		t.Fatalf("unproven completion was reported: %#v", failure)
	}
}

func TestMapTaskFullConvertsOptionalTimeToUTC(t *testing.T) {
	started := time.Date(2026, 11, 6, 9, 10, 11, 123, time.FixedZone("test", 3*60*60))
	task := model.Task{StartedAt: &started, CancelledAt: &started}
	got := MapTaskFull(task)
	if got.StartedAt == nil || got.StartedAt.Location() != time.UTC || !got.StartedAt.Equal(started) || got.CompletedAt != nil ||
		got.CancelledAt == nil || got.CancelledAt.Location() != time.UTC || !got.CancelledAt.Equal(started) {
		t.Fatalf("unexpected optional timestamps: %+v", got)
	}
	if task.StartedAt.Location() == time.UTC || task.CancelledAt.Location() == time.UTC {
		t.Fatal("mapper changed the source timestamp")
	}
}

func TestMCPResponseWriterSupportsResponseController(t *testing.T) {
	recorder := httptest.NewRecorder()
	writer := &noStoreWriter{ResponseWriter: recorder}
	writer.Header().Set("Cache-Control", "no-store")
	if _, err := writer.Write([]byte("body")); err != nil {
		t.Fatal(err)
	}
	if err := http.NewResponseController(writer).Flush(); err != nil {
		t.Fatal(err)
	}
	if !recorder.Flushed || recorder.Body.String() != "body" || !strings.EqualFold(recorder.Header().Get("Cache-Control"), "no-store") {
		t.Fatalf("response controller did not reach underlying writer: %#v", recorder)
	}
}

func TestMCPDiscoveryRequiresObjectPropertySchemas(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := additionalEntry(t, logger)
	handler := func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: map[string]any{"value": 3}}, nil
	}
	for _, flag := range []bool{false, true} {
		name := fmt.Sprintf("input_%t", flag)
		input := testObjectSchema()
		input["properties"] = map[string]any{"payload": flag}
		if err := e.RegisterTool(simpleTestTool(name, input), BudgetControl, handler); err == nil {
			t.Fatalf("registered %s with a direct boolean property schema", name)
		}
	}
	input := map[string]any{"type": "object", "properties": map[string]any{"payload": map[string]any{"type": "object", "properties": map[string]any{"allowed": true, "forbidden": false}}}}
	if err := e.RegisterTool(simpleTestTool("valid_nested", input), BudgetControl, handler); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(httpx.RequestLogging(logger, e))
	t.Cleanup(server.Close)
	fixture := &entryFixture{entry: e, server: server}
	client := fixture.client(t, "2026-07-28", "alice")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	list, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) != 1 || list.Tools[0].Name != "valid_nested" {
		t.Fatalf("unexpected discovery: %#v", list.Tools)
	}
	result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: "valid_nested", Arguments: map[string]any{"payload": map[string]any{"allowed": 42}}})
	if err != nil || result.IsError {
		t.Fatalf("nested true schema rejected: %#v, %v", result, err)
	}
	result, err = client.CallTool(ctx, &sdk.CallToolParams{Name: "valid_nested", Arguments: map[string]any{"payload": map[string]any{"forbidden": 42}}})
	if err != nil || !result.IsError {
		t.Fatalf("nested false schema not enforced: %#v, %v", result, err)
	}
}

func TestObjectPropertySchemasRejectsMalformedProperties(t *testing.T) {
	if objectPropertySchemas(map[string]any{"properties": true}) {
		t.Fatal("accepted non-object properties")
	}
	if objectPropertySchemas(map[string]any{"properties": map[string]any{"name": false}}) {
		t.Fatal("accepted boolean direct property")
	}
	if !objectPropertySchemas(map[string]any{"properties": map[string]any{"name": map[string]any{}}}) {
		t.Fatal("rejected object direct property")
	}
}
