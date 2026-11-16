package mcp

import (
	"encoding/json"
	"fmt"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

func resultDefinitionSchema(tool *sdk.Tool, name string) (*jsonschema.Schema, error) {
	if tool == nil || tool.Name != name || name == "" {
		return nil, fmt.Errorf("invalid tool definition for %q", name)
	}
	data, err := json.Marshal(tool.OutputSchema)
	if err != nil {
		return nil, fmt.Errorf("tool %q output schema: %w", name, err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil || schema == nil || schema["type"] != "object" {
		return nil, fmt.Errorf("tool %q has no object output schema", name)
	}
	compiled, err := resolveSchema(tool.OutputSchema)
	if err != nil {
		return nil, fmt.Errorf("tool %q output schema: %w", name, err)
	}
	return compiled, nil
}

func checkedResultDefinition(tool *sdk.Tool, name string) (*sdk.Tool, error) {
	if _, err := resultDefinitionSchema(tool, name); err != nil {
		return nil, err
	}
	return tool, nil
}

func readArrayResultDefinition(data []byte, name string) (*sdk.Tool, error) {
	var tools []*sdk.Tool
	if err := json.Unmarshal(data, &tools); err != nil {
		return nil, err
	}
	var match *sdk.Tool
	count := 0
	for _, tool := range tools {
		if tool != nil && tool.Name == name {
			match = tool
			count++
		}
	}
	if count != 1 {
		return nil, fmt.Errorf("tool %q has %d definitions", name, count)
	}
	return checkedResultDefinition(match, name)
}

func readSingleResultDefinition(data []byte, name string) (*sdk.Tool, error) {
	var tool *sdk.Tool
	if err := json.Unmarshal(data, &tool); err != nil {
		return nil, err
	}
	return checkedResultDefinition(tool, name)
}

func arrayResultDefinition(t *testing.T, data []byte, name string) *sdk.Tool {
	t.Helper()
	tool, err := readArrayResultDefinition(data, name)
	if err != nil {
		t.Fatal(err)
	}
	return tool
}

func singleResultDefinition(t *testing.T, data []byte, name string) *sdk.Tool {
	t.Helper()
	tool, err := readSingleResultDefinition(data, name)
	if err != nil {
		t.Fatal(err)
	}
	return tool
}

func validateToolResult(t *testing.T, definition *sdk.Tool, result *sdk.CallToolResult) {
	t.Helper()
	if definition == nil || result == nil {
		t.Fatal("missing tool definition or result")
	}
	schema, err := resultDefinitionSchema(definition, definition.Name)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateJSON(schema, raw); err != nil {
		t.Fatalf("%s protocol result violates internal output schema: %v\n%s", definition.Name, err, raw)
	}
}

func assertDiscoveredOutputSchemas(t *testing.T, client *sdk.ClientSession, names ...string) {
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
		if found == nil || found.OutputSchema == nil {
			t.Fatalf("tool %s or its published output schema is missing", name)
		}
		if _, err := resolveSchema(found.OutputSchema); err != nil {
			t.Fatalf("tool %s published output schema: %v", name, err)
		}
	}
}

func TestResultDefinitionSchemaRejectsPermissiveDefinitions(t *testing.T) {
	for _, value := range []any{nil, true, map[string]any{}, map[string]any{"type": "string"}} {
		if _, err := resultDefinitionSchema(&sdk.Tool{Name: "test", OutputSchema: value}, "test"); err == nil {
			t.Fatalf("accepted output schema %#v", value)
		}
	}
	if _, err := resultDefinitionSchema(sessionReadToolDefinition("read"), "task_session_read"); err != nil {
		t.Fatal(err)
	}
}

func TestResultDefinitionReadersRejectInvalidDefinitions(t *testing.T) {
	valid := `{"name":"wanted","outputSchema":{"type":"object"}}`
	for _, tc := range []struct {
		name, input string
		array, want bool
	}{
		{"array valid", `[` + valid + `]`, true, true},
		{"single valid", valid, false, true},
		{"missing", `[]`, true, false},
		{"duplicate", `[` + valid + `,` + valid + `]`, true, false},
		{"wrong name", valid, false, false},
		{"missing schema", `{"name":"wanted"}`, false, false},
		{"null schema", `[{"name":"wanted","outputSchema":null}]`, true, false},
		{"invalid schema", `{"name":"wanted","outputSchema":{"type":"object","required":3}}`, false, false},
		{"invalid json", `[`, true, false},
		{"wrong shape", valid, true, false},
		{"null definition", `null`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			name := "wanted"
			if tc.name == "wrong name" {
				name = "other"
			}
			var err error
			if tc.array {
				_, err = readArrayResultDefinition([]byte(tc.input), name)
			} else {
				_, err = readSingleResultDefinition([]byte(tc.input), name)
			}
			if (err == nil) != tc.want {
				t.Fatalf("error=%v, want success=%t", err, tc.want)
			}
		})
	}
}
