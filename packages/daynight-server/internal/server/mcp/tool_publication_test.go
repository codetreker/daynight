package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolPublicationPreservesInternalDefinition(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			definition := &sdk.Tool{
				Name: "publication_probe", Title: "Publication probe", Description: "Descriptive metadata",
				InputSchema:  map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}}},
				OutputSchema: standardOutputSchema(),
				Annotations:  &sdk.ToolAnnotations{ReadOnlyHint: true},
			}
			before, err := json.Marshal(definition)
			if err != nil {
				t.Fatal(err)
			}
			if err := fixture.entry.RegisterTool(definition, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
				return ToolResult{Data: map[string]any{"value": "kept"}}, nil
			}); err != nil {
				t.Fatal(err)
			}
			after, err := json.Marshal(definition)
			if err != nil || string(before) != string(after) || definition.OutputSchema == nil {
				t.Fatalf("registration changed internal definition: before=%s after=%s error=%v", before, after, err)
			}
			listed, err := fixture.client(t, version, "alice").ListTools(t.Context(), nil)
			if err != nil {
				t.Fatal(err)
			}
			var published *sdk.Tool
			for _, tool := range listed.Tools {
				if tool.Name == definition.Name {
					if published != nil {
						t.Fatal("duplicate published tool")
					}
					published = tool
				}
			}
			if published == nil || published.OutputSchema != nil {
				t.Fatalf("published tool: %+v", published)
			}
			var expected, actual map[string]any
			if err := json.Unmarshal(before, &expected); err != nil {
				t.Fatal(err)
			}
			delete(expected, "outputSchema")
			encoded, err := json.Marshal(published)
			if err != nil || json.Unmarshal(encoded, &actual) != nil || !reflect.DeepEqual(expected, actual) {
				t.Fatalf("published metadata changed: expected=%v actual=%s error=%v", expected, encoded, err)
			}
		})
	}
}

func TestToolAuthenticationRefusalDoesNotDispatch(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, fixture.server.URL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"test_only","arguments":{"mode":"ok"}}}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Accept", "application/json, text/event-stream")
			req.Header.Set("Authorization", "Bearer invalid")
			req.Header.Set("MCP-Protocol-Version", version)
			req.Header.Set("MCP-Method", "tools/call")
			req.Header.Set("MCP-Tool-Name", "test_only")
			response, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized || fixture.calls.Load() != 0 {
				t.Fatalf("status=%d business calls=%d", response.StatusCode, fixture.calls.Load())
			}
		})
	}
}
