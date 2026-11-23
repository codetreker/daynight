package mcp

import (
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"testing"
)

func assertNoDiscoveredOutputSchemas(t *testing.T, client *sdk.ClientSession, names ...string) {
	t.Helper()
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		var found *sdk.Tool
		for _, tool := range listed.Tools {
			if tool.Name == name {
				found = tool
				break
			}
		}
		if found == nil || found.OutputSchema != nil {
			t.Fatalf("tool %s missing or its output schema is published", name)
		}
	}
}
