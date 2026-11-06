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

func TestSchemaErrorObjectCompatibility(t *testing.T) {
	str := map[string]any{"type": "string"}
	fields := func() map[string]any {
		return map[string]any{"code": str, "message": str, "requestId": str, "writeOutcome": map[string]any{"enum": []any{"confirmed", "not_committed", "unknown"}}, "phase": str, "refs": map[string]any{"type": "object"}}
	}
	cases := []struct {
		name   string
		schema any
		want   bool
	}{
		{"any object", true, true},
		{"deny all", false, false},
		{"type object", map[string]any{"type": "object"}, true},
		{"non-object type", map[string]any{"type": "string"}, false},
		{"non-schema value", "object", false},
		{"restricted field", map[string]any{"type": "object", "properties": map[string]any{"code": map[string]any{"type": "string", "pattern": "^internal"}}}, false},
		{"unknown top-level constraint", map[string]any{"type": "object", "maxProperties": 1}, false},
		{"optional field required", map[string]any{"required": []any{"code", "refs"}}, false},
		{"closed without optional fields", map[string]any{"properties": map[string]any{"code": str, "message": str, "requestId": str}, "additionalProperties": false}, false},
		{"closed with all fields", map[string]any{"type": "object", "properties": fields(), "required": []any{"code", "message", "requestId"}, "additionalProperties": false}, true},
		{"non-object refs", map[string]any{"properties": map[string]any{"refs": map[string]any{"type": "string"}}}, false},
		{"non-string phase", map[string]any{"properties": map[string]any{"phase": map[string]any{"type": "number"}}}, false},
		{"incomplete outcomes", map[string]any{"properties": map[string]any{"writeOutcome": map[string]any{"enum": []any{"unknown", "confirmed"}}}}, false},
		{"unknown field schema", map[string]any{"properties": map[string]any{"code": true}}, true},
		{"false field schema", map[string]any{"properties": map[string]any{"code": false}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := acceptsErrorObject(tc.schema); got != tc.want {
				t.Fatalf("schema %#v: got %v want %v", tc.schema, got, tc.want)
			}
		})
	}
}

func TestErrorResultRetainsFactsWhenReferenceCannotEncode(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	schema, err := resolveSchema(map[string]any{"type": "object"})
	if err != nil {
		t.Fatal(err)
	}
	result := e.errorResult(schema, RequestActor{}, envelopeError{Code: "version_conflict", Message: "conflict", RequestID: "original", WriteOutcome: "confirmed", Phase: "output", Refs: map[string]any{"bad": make(chan int)}})
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
	schema, err := resolveSchema(map[string]any{"type": "object"})
	if err != nil {
		t.Fatal(err)
	}
	result := e.errorResult(schema, RequestActor{}, envelopeError{Code: "internal_error", Message: "failure", RequestID: "original", WriteOutcome: "unsupported"})
	failure := object(t, structured(t, result)["error"])
	if _, ok := failure["writeOutcome"]; ok {
		t.Fatalf("unproven completion was reported: %#v", failure)
	}
}

func TestErrorResultFallbackWithIncompatibleSchema(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	// This schema cannot be registered, but fallback remains useful if a future
	// caller passes a mismatched validator after operation completion.
	schema, err := resolveSchema(map[string]any{"type": "object", "properties": map[string]any{"error": map[string]any{"type": "object", "properties": map[string]any{"code": map[string]any{"const": "internal_error"}}, "required": []string{"code"}}}})
	if err != nil {
		t.Fatal(err)
	}
	result := e.errorResult(schema, RequestActor{}, envelopeError{Code: "version_conflict", Message: "conflict", RequestID: "original", WriteOutcome: "confirmed", Phase: "output"})
	failure := object(t, structured(t, result)["error"])
	if failure["code"] != "internal_error" || failure["requestId"] != "original" || failure["writeOutcome"] != "confirmed" || failure["phase"] != "output" {
		t.Fatalf("fallback lost facts: %#v", failure)
	}
	b, err := json.Marshal(result.StructuredContent)
	if err != nil || validateJSON(schema, b) != nil {
		t.Fatalf("fallback violates schema: %s %v", b, err)
	}
}

func TestMapTaskFullConvertsOptionalTimeToUTC(t *testing.T) {
	started := time.Date(2026, 11, 6, 9, 10, 11, 123, time.FixedZone("test", 3*60*60))
	task := model.Task{StartedAt: &started}
	got := MapTaskFull(task)
	if got.StartedAt == nil || got.StartedAt.Location() != time.UTC || !got.StartedAt.Equal(started) || got.CompletedAt != nil {
		t.Fatalf("unexpected optional timestamps: %+v", got)
	}
	if task.StartedAt.Location() == time.UTC {
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

// Output discovery requires the schema's root type even when the schema would
// otherwise accept an error object under JSON Schema validation.
func TestMCPDiscoveryRejectsOutputWithoutObjectType(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := additionalEntry(t, logger)
	handler := func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	}
	for _, tc := range []struct {
		name   string
		output any
	}{
		{"empty", map[string]any{}},
		{"properties_only", map[string]any{"properties": map[string]any{"error": map[string]any{"type": "object"}}}},
		{"wrong_type", map[string]any{"type": "string"}},
	} {
		if err := e.RegisterTool(simpleTestTool(tc.name, testObjectSchema(), tc.output), BudgetControl, handler); err == nil {
			t.Fatalf("registered %s with invalid output schema", tc.name)
		}
	}
	if err := e.RegisterTool(simpleTestTool("valid", testObjectSchema(), testObjectSchema()), BudgetControl, handler); err != nil {
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
	if len(list.Tools) != 1 || list.Tools[0].Name != "valid" {
		t.Fatalf("unexpected discovery: %#v", list.Tools)
	}
	data, err := json.Marshal(list.Tools[0].OutputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var output struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &output); err != nil || output.Type != "object" {
		t.Fatalf("output schema %s: %v", data, err)
	}
}

// Direct property schemas must be objects for standard client discovery, while
// JSON Schema still allows boolean schemas beneath those properties.
func TestMCPDiscoveryRequiresObjectPropertySchemas(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	e := additionalEntry(t, logger)
	handler := func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{Data: map[string]any{"value": 3}}, nil
	}
	for _, flag := range []bool{false, true} {
		for _, surface := range []string{"input", "output"} {
			name := fmt.Sprintf("%s_%t", surface, flag)
			input, output := testObjectSchema(), testObjectSchema()
			if surface == "input" {
				input["properties"] = map[string]any{"payload": flag}
			} else {
				output["properties"] = map[string]any{"data": flag}
			}
			if err := e.RegisterTool(simpleTestTool(name, input, output), BudgetControl, handler); err == nil {
				t.Fatalf("registered %s with a direct boolean property schema", name)
			}
		}
	}
	input := map[string]any{"type": "object", "properties": map[string]any{"payload": map[string]any{"type": "object", "properties": map[string]any{"allowed": true, "forbidden": false}}}}
	output := map[string]any{"type": "object", "properties": map[string]any{"data": map[string]any{"type": "object", "properties": map[string]any{"value": true, "forbidden": false}}}}
	if err := e.RegisterTool(simpleTestTool("valid_nested", input, output), BudgetControl, handler); err != nil {
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
