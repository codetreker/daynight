package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpCatalogTransport struct {
	capture bool
	body    []byte
}

func (tr *mcpCatalogTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := (mcpPATTransport{token: defaultHTTPToken()}).RoundTrip(req)
	if err != nil || !tr.capture {
		return response, err
	}
	tr.body, err = io.ReadAll(response.Body)
	_ = response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(tr.body))
	return response, err
}

func TestMCPProductionCatalogOmitsOutputSchemas(t *testing.T) {
	var first map[string]map[string]any
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		t.Run(version, func(t *testing.T) {
			database := newHTTPTestStore(t)
			configureMCPPrincipals(t, database, map[string]model.Principal{defaultHTTPToken(): defaultHTTPPrincipal()})
			server, _ := newMCPHTTPServer(t, database, attachmentTestFiles(t))
			transport := &mcpCatalogTransport{}
			client := sdk.NewClient(&sdk.Implementation{Name: "mcp-catalog", Version: "1"}, nil)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: version})
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			if session.InitializeResult().ProtocolVersion != version {
				t.Fatalf("negotiated version: %s", session.InitializeResult().ProtocolVersion)
			}
			transport.capture = true
			list, err := session.ListTools(ctx, nil)
			transport.capture = false
			if err != nil {
				t.Fatal(err)
			}
			assertMCPProductionTools(t, list.Tools)
			if list.NextCursor != "" {
				t.Fatalf("unexpected catalog continuation: %q", list.NextCursor)
			}
			var wire struct {
				Result struct {
					Tools []map[string]any `json:"tools"`
				} `json:"result"`
			}
			if err := json.Unmarshal(transport.body, &wire); err != nil {
				t.Fatalf("raw tools/list JSON: %v", err)
			}
			if len(wire.Result.Tools) != len(list.Tools) {
				t.Fatalf("raw tool count %d, SDK tool count %d", len(wire.Result.Tools), len(list.Tools))
			}
			metadata := make(map[string]map[string]any, len(wire.Result.Tools))
			for _, tool := range wire.Result.Tools {
				name, ok := tool["name"].(string)
				if !ok || name == "" || metadata[name] != nil {
					t.Fatalf("missing or duplicate name: %#v", tool)
				}
				if _, present := tool["outputSchema"]; present {
					t.Errorf("%s has outputSchema in raw discovery", name)
				}
				for key := range tool {
					switch key {
					case "name", "title", "description", "inputSchema", "annotations", "icons", "_meta", "execution":
					default:
						t.Errorf("%s has unexpected metadata field %q", name, key)
					}
				}
				metadata[name] = tool
			}
			for _, tool := range list.Tools {
				if tool.OutputSchema != nil || metadata[tool.Name] == nil {
					t.Errorf("SDK tool differs from wire: %+v", tool)
				}
			}
			if first == nil {
				first = metadata
			} else if !reflect.DeepEqual(first, metadata) {
				t.Error("tool metadata differs across protocol versions")
			}
		})
	}
}
