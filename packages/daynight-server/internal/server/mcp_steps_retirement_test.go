package server

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPProductionRetiresStepsWithoutChangingOtherTools(t *testing.T) {
	database := newHTTPTestStore(t)
	token := defaultHTTPToken()
	configureMCPPrincipals(t, database, map[string]model.Principal{token: defaultHTTPPrincipal()})
	production, _ := newMCPHTTPServer(t, database, attachmentTestFiles(t))
	client := mcpPATClient(t, production.URL, token)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tools, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	assertMCPProductionTools(t, tools.Tools)
	_, err = client.CallTool(ctx, &sdk.CallToolParams{Name: "missing_tool", Arguments: map[string]any{}})
	var unknown *jsonrpc.Error
	if !errors.As(err, &unknown) {
		t.Fatalf("unknown tool did not produce a protocol error: %v", err)
	}
	for _, operation := range []string{"list", "show", "add", "update", "set_status", "move", "delete"} {
		name := "task_step_" + operation
		result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: map[string]any{"projectId": "c3333333-3333-4333-8333-333333333333", "taskId": "d4444444-4444-4444-8444-444444444444"}})
		var failure *jsonrpc.Error
		if result != nil || !errors.As(err, &failure) || failure.Code != unknown.Code || failure.Message != unknown.Message {
			t.Fatalf("retired tool %s: result=%+v error=%v; want existing unknown-tool error %+v", name, result, err, unknown)
		}
	}
	resources, err := client.ListResources(ctx, nil)
	if err != nil || len(resources.Resources) == 0 || resources.NextCursor != "" {
		t.Fatalf("manual discovery: %+v %v", resources, err)
	}
	for _, resource := range resources.Resources {
		if resource.URI == "daynight://manuals/steps.md" {
			t.Fatal("retired Steps manual remains discoverable")
		}
		body, err := client.ReadResource(ctx, &sdk.ReadResourceParams{URI: resource.URI})
		if err != nil || len(body.Contents) != 1 || strings.TrimSpace(body.Contents[0].Text) == "" {
			t.Fatalf("remaining manual %s unreadable: %+v %v", resource.URI, body, err)
		}
	}
	if _, err := client.ReadResource(ctx, &sdk.ReadResourceParams{URI: "daynight://manuals/steps.md"}); err == nil {
		t.Fatal("retired Steps manual remains readable")
	}
}
