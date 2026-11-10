package mcp

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestReadObservationMetadataPreservesPartialResults(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(map[bool]string{false: "complete", true: "partial"}[partial], func(t *testing.T) {
			f := newEntryFixture(t)
			stamp := time.Date(2026, 11, 10, 1, 2, 3, 0, time.UTC)
			tool := &sdk.Tool{Name: "observed_read", InputSchema: map[string]any{"type": "object", "additionalProperties": false}, OutputSchema: map[string]any{"type": "object"}}
			err := f.entry.registerReadTool(tool, func(json.RawMessage) BudgetClass { return BudgetControl }, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
				return ToolResult{Data: map[string]any{"items": []string{"retained-task"}}, Observation: &ReadObservation{ObservedAt: stamp, Partial: partial}, Refs: map[string]any{"projectId": testProjectID}}, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			client := f.client(t, "2026-07-28", "alice")
			result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: tool.Name, Arguments: map[string]any{}})
			if err != nil || result.IsError {
				t.Fatalf("read: %+v, %v", result, err)
			}
			env := structured(t, result)
			meta := object(t, env["meta"])
			if meta["observedAt"] != "2026-11-10T01:02:03Z" || meta["partial"] != partial || object(t, meta["refs"])["projectId"] != testProjectID {
				t.Fatalf("missing observation facts: %#v", meta)
			}
			if _, present := meta["writeOutcome"]; present || env["error"] != nil || object(t, env["data"])["items"].([]any)[0] != "retained-task" {
				t.Fatalf("read observation changed result or became a mutation: %#v", env)
			}
		})
	}
}

func TestSessionCompletionMetadataDoesNotReplaceNativeState(t *testing.T) {
	f := newEntryFixture(t)
	tool := &sdk.Tool{Name: "session_receipt", InputSchema: map[string]any{"type": "object"}, OutputSchema: map[string]any{"type": "object"}}
	err := f.entry.RegisterTool(tool, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		return ToolResult{SuccessMetadata: true, Data: map[string]any{"operation": map[string]any{"state": "accepted"}}, WriteOutcome: "confirmed", Phase: "commit", Refs: map[string]any{"operationId": "original"}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := f.client(t, "2026-07-28", "alice").CallTool(t.Context(), &sdk.CallToolParams{Name: tool.Name, Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("result %#v %v", result, err)
	}
	env := structured(t, result)
	meta := object(t, env["meta"])
	if meta["writeOutcome"] != "confirmed" || meta["phase"] != "commit" || object(t, meta["refs"])["operationId"] != "original" || object(t, object(t, env["data"])["operation"])["state"] != "accepted" {
		t.Fatalf("completion/native facts lost: %#v", env)
	}
}
