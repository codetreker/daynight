//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Compare the actual MCP and REST search paths over the same persisted data.
func serverAPIMCPTaskSearchNormalFlow(t *testing.T, f *fixture, project, tag, otherTag, goal, first, second, child string) {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "daynight-search-integration", Version: "1"}, nil)
	session, err := client.Connect(f.context, &sdk.StreamableClientTransport{Endpoint: f.origin + "/mcp", HTTPClient: f.client, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	for _, tc := range []struct {
		name   string
		filter map[string]any
		want   map[string]bool
	}{
		{"paginated tasks", map[string]any{"query": "tagged", "tagIds": []string{tag}, "tagMatch": "all", "limit": 1}, map[string]bool{first: true, second: true}},
		{"goal", map[string]any{"query": "tagged", "tagIds": []string{tag}, "type": "goal", "limit": 1}, map[string]bool{goal: true}},
		{"child", map[string]any{"query": "tagged", "tagIds": []string{otherTag}, "type": "task", "parentId": goal, "limit": 1}, map[string]bool{child: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			restArgs, mcpArgs := map[string]any{}, map[string]any{"projectId": project}
			for k, v := range tc.filter {
				restArgs[k], mcpArgs[k] = v, v
			}
			seen := map[string]bool{}
			for {
				rest := requestJSON[map[string]any](t, f, http.MethodPost, "/api/v1/projects/"+project+"/tasks/search", restArgs, http.StatusOK)
				result, err := session.CallTool(f.context, &sdk.CallToolParams{Name: "task_search", Arguments: mcpArgs})
				if err != nil || result == nil || result.IsError {
					t.Fatalf("MCP search: result=%+v err=%v", result, err)
				}
				raw, err := json.Marshal(result.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				var envelope struct {
					Data map[string]any `json:"data"`
				}
				if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Data == nil {
					t.Fatalf("MCP envelope: %s (%v)", raw, err)
				}
				mcp := envelope.Data
				if mcp["projectId"] != rest["projectId"] || mcp["total"] != rest["total"] {
					t.Fatalf("page differs: REST=%+v MCP=%+v", rest, mcp)
				}
				restItems, mcpItems := rest["items"].([]any), mcp["items"].([]any)
				if len(restItems) != 1 || len(mcpItems) != 1 {
					t.Fatalf("items differ: REST=%+v MCP=%+v", restItems, mcpItems)
				}
				r, m := restItems[0].(map[string]any), mcpItems[0].(map[string]any)
				for _, field := range []string{"assignedTo", "updatedAt", "cancelledAt"} {
					delete(r, field)
				}
				if !reflect.DeepEqual(r, m) {
					t.Fatalf("item differs: REST=%+v MCP=%+v", r, m)
				}
				id := m["id"].(string)
				if seen[id] || !tc.want[id] {
					t.Fatalf("unexpected result: %+v", m)
				}
				seen[id] = true
				rc, mc := rest["nextCursor"], mcp["nextCursor"]
				if (rc == nil) != (mc == nil) {
					t.Fatalf("pagination differs: REST=%v MCP=%v", rc, mc)
				}
				if rc == nil {
					break
				}
				if len(seen) >= len(tc.want) {
					t.Fatal("pagination did not end")
				}
				restArgs["cursor"], mcpArgs["cursor"] = rc, mc
			}
			if !reflect.DeepEqual(seen, tc.want) {
				t.Fatalf("identities: got=%v want=%v", seen, tc.want)
			}
		})
	}
}
