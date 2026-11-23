package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type manualTestOAuth struct{}

func (manualTestOAuth) AuthenticateAccess(_ context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	if token != model.OAuthAccessPrefix+"test" || resource != "https://daynight.test/mcp" {
		return store.OAuthAccessIdentity{}, model.Unauthenticated(nil)
	}
	return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: "no-project", CredentialID: "access"}, GrantID: "grant"}, nil
}

const manualOverviewURI = "daynight://manuals/overview.md"

const expectedManualInstructions = "Daynight manages projects, tasks and goals, and agent sessions, helping you organize work, coordinate agents, and track progress.\nBefore using its tools, read `daynight://manuals/overview.md` via `resources/read`.\n"

type manualHandshake struct {
	method       string
	instructions string
}

type manualCacheTransport struct {
	base          http.RoundTripper
	bad           atomic.Bool
	badResultType atomic.Bool
	checked       atomic.Int32
	mu            sync.Mutex
	handshakes    []manualHandshake
}

func (tr *manualCacheTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var method string
	if req.Body != nil {
		data, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		req.Body = io.NopCloser(bytes.NewReader(data))
		var request struct {
			Method string `json:"method"`
		}
		if json.Unmarshal(data, &request) == nil {
			method = request.Method
		}
	}
	response, err := tr.base.RoundTrip(req)
	if err == nil && (method == "initialize" || method == "server/discover") {
		data, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		response.Body = io.NopCloser(bytes.NewReader(data))
		// Streamable HTTP may encode an individual response as an SSE event.
		payload := data
		if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			for _, line := range strings.Split(string(data), "\n") {
				if strings.HasPrefix(line, "data:") {
					payload = []byte(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
					break
				}
			}
		}
		var wire struct {
			Result *struct {
				Instructions string `json:"instructions"`
			} `json:"result"`
		}
		var instructions string
		if json.Unmarshal(payload, &wire) == nil && wire.Result != nil {
			instructions = wire.Result.Instructions
		}
		tr.mu.Lock()
		tr.handshakes = append(tr.handshakes, manualHandshake{method: method, instructions: instructions})
		tr.mu.Unlock()
	}
	if err == nil && response.Header.Get("Cache-Control") != "no-store" {
		tr.bad.Store(true)
	}
	if err == nil && req.Header.Get("MCP-Protocol-Version") == "2026-07-28" && (req.Header.Get("MCP-Method") == "resources/read" || req.Header.Get("MCP-Method") == "resources/list") && response.StatusCode == http.StatusOK {
		data, readErr := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if readErr != nil {
			return nil, readErr
		}
		response.Body = io.NopCloser(bytes.NewReader(data))
		var wire struct {
			Result *struct {
				ResultType string `json:"resultType"`
			} `json:"result"`
		}
		if json.Unmarshal(data, &wire) != nil {
			tr.badResultType.Store(true)
		} else if wire.Result != nil {
			tr.checked.Add(1)
			if wire.Result.ResultType != "complete" {
				tr.badResultType.Store(true)
			}
		}
	}
	return response, err
}

func TestProductManualProtocol(t *testing.T) {
	for _, version := range []string{"2026-07-28", "2025-11-25"} {
		for _, token := range []string{"alice", model.OAuthAccessPrefix + "test"} {
			t.Run(version+"/"+token, func(t *testing.T) {
				f := newEntryFixture(t)
				f.entry.oauth = manualTestOAuth{}
				transport := &manualCacheTransport{base: headerTransport{base: http.DefaultTransport, token: token}}
				client := sdk.NewClient(&sdk.Implementation{Name: "manual-client", Version: "1"}, nil)
				ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
				defer cancel()
				session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: f.server.URL, HTTPClient: &http.Client{Transport: transport}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: version})
				if err != nil {
					t.Fatal(err)
				}
				defer session.Close()
				init := session.InitializeResult()
				instructions, err := fs.ReadFile(productManualFS, "manuals/instructions.md")
				if err != nil || init == nil || init.ProtocolVersion != version || init.Instructions != string(instructions) || init.Capabilities == nil || init.Capabilities.Resources == nil || init.Capabilities.Resources.Subscribe || init.Capabilities.Resources.ListChanged || init.Capabilities.Logging == nil || init.Capabilities.Tools == nil {
					t.Fatalf("initialization = %+v, read error = %v", init, err)
				}
				wantMethod := "initialize"
				if version == "2026-07-28" {
					wantMethod = "server/discover"
				}
				transport.mu.Lock()
				handshakes := append([]manualHandshake(nil), transport.handshakes...)
				transport.mu.Unlock()
				if len(handshakes) != 1 || handshakes[0].method != wantMethod || handshakes[0].instructions != expectedManualInstructions {
					t.Fatalf("wire handshakes = %+v; want %s and exact instructions", handshakes, wantMethod)
				}
				// Read directly from the handshake before listing resources, including for
				// the OAuth principal which has no Project.
				uri := manualURIReference.FindString(handshakes[0].instructions)
				if uri != manualOverviewURI {
					t.Fatalf("handshake URI = %q", uri)
				}
				direct, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: uri})
				overview, sourceErr := fs.ReadFile(productManualFS, "manuals/overview.md")
				if err != nil || sourceErr != nil || direct == nil || len(direct.Contents) != 1 || direct.Contents[0].URI != manualOverviewURI || direct.Contents[0].MIMEType != "text/markdown" || direct.Contents[0].Text != string(overview) || len(direct.Contents[0].Blob) != 0 {
					t.Fatalf("direct overview = %+v, error=%v source error=%v", direct, err, sourceErr)
				}
				tools, err := session.ListTools(ctx, nil)
				if err != nil || tools == nil || len(tools.Tools) != 1 || tools.Tools[0].Name != "test_only" || tools.Tools[0].Description != "Test tool" || tools.Tools[0].InputSchema == nil {
					t.Fatalf("tool discovery = %+v, error=%v", tools, err)
				}
				list, err := session.ListResources(ctx, nil)
				if err != nil || len(list.Resources) != len(productManualManifest) || list.NextCursor != "" {
					t.Fatalf("list = %+v, error = %v", list, err)
				}
				if version == "2026-07-28" && (list.CacheScope != "private" || list.TTLMs != 0) {
					t.Fatalf("list cache policy: %+v", list.Cacheable)
				}
				if version == "2026-07-28" && string(list.ResultType) != "complete" {
					t.Fatalf("list result type: %q", list.ResultType)
				}
				found := make(map[string]*sdk.Resource)
				for _, resource := range list.Resources {
					if found[resource.URI] != nil {
						t.Fatalf("duplicate resource %s", resource.URI)
					}
					found[resource.URI] = resource
				}
				overviewResource := found[manualOverviewURI]
				if overviewResource == nil || overviewResource.Name != "overview" || overviewResource.Title != "Daynight MCP overview" || overviewResource.Description != "Find operation guides, shared conventions and required reading sets." || overviewResource.MIMEType != "text/markdown" || overviewResource.Size != int64(len(overview)) {
					t.Fatalf("overview metadata = %+v", overviewResource)
				}
				for _, expected := range productManualManifest {
					resource := found[expected.Resource.URI]
					if resource == nil || !reflect.DeepEqual(*resource, expected.Resource) {
						t.Fatalf("metadata = %+v, want %+v", resource, expected.Resource)
					}
					read, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: expected.Resource.URI})
					body, readErr := fs.ReadFile(productManualFS, expected.Path)
					if err != nil || readErr != nil || len(read.Contents) != 1 || read.Contents[0].URI != expected.Resource.URI || read.Contents[0].MIMEType != expected.Resource.MIMEType || read.Contents[0].Text != string(body) || len(read.Contents[0].Blob) != 0 {
						t.Fatalf("read %s: result=%+v error=%v source error=%v", expected.Resource.URI, read, err, readErr)
					}
					if version == "2026-07-28" && (read.CacheScope != "private" || read.TTLMs != 0) {
						t.Fatalf("read cache policy: %+v", read.Cacheable)
					}
					if version == "2026-07-28" {
						encoded, err := json.Marshal(read)
						var wire struct {
							ResultType string `json:"resultType"`
						}
						if err != nil || json.Unmarshal(encoded, &wire) != nil || wire.ResultType != "complete" {
							t.Fatalf("read result type: %s (%v)", encoded, err)
						}
					}
					read.Contents[0].Text = "changed by client"
					again, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: expected.Resource.URI})
					if err != nil || len(again.Contents) != 1 || again.Contents[0].Text != string(body) {
						t.Fatalf("subsequent read %s changed: %+v %v", expected.Resource.URI, again, err)
					}
				}
				_, err = session.ReadResource(ctx, &sdk.ReadResourceParams{URI: "daynight://manuals/private-unknown.md"})
				var rpc *jsonrpc.Error
				if !errors.As(err, &rpc) || rpc.Code != jsonrpc.CodeInvalidParams || rpc.Message != "Invalid params" || strings.Contains(err.Error(), "private-unknown") {
					t.Fatalf("unknown URI error = %v", err)
				}
				if transport.bad.Load() {
					t.Fatal("an MCP response lacked Cache-Control: no-store")
				}
				if version == "2026-07-28" && (transport.badResultType.Load() || transport.checked.Load() != int32(2+2*len(productManualManifest))) {
					t.Fatalf("modern wire resultType checks: count=%d, failed=%v", transport.checked.Load(), transport.badResultType.Load())
				}
			})
		}
	}
}

func TestProductManualAuthenticationRequired(t *testing.T) {
	f := newEntryFixture(t)
	f.entry.oauth = manualTestOAuth{}
	for _, token := range []string{"", "invalid", model.OAuthAccessPrefix + "invalid"} {
		request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"resources/list"}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		f.entry.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("credential %q: status=%d body=%s", token, response.Code, response.Body)
		}
	}
}

func TestProductManualPublishedVersionUpdate(t *testing.T) {
	files, _ := manualFixture(t)
	original := string(files["manuals/concepts.md"].Data)
	_, width := utf8.DecodeRuneInString(original)
	replacement := "x"
	if strings.HasPrefix(original, replacement) {
		replacement = "y"
	}
	updated := strings.Repeat(replacement, width) + original[width:]
	if original == updated || len(original) != len(updated) || !utf8.ValidString(updated) {
		t.Fatal("fixture must supply a distinct same-size UTF-8 edition")
	}
	files["manuals/concepts.md"].Data = []byte(updated)
	read := func(source fs.FS) string {
		t.Helper()
		logger := slog.New(slog.NewTextHandler(io.Discard, nil))
		entry, err := newWithManualSource(testAuthenticator{}, "https://daynight.test", nil, logger, nil, source)
		if err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(entry)
		defer server.Close()
		defer entry.Shutdown(context.Background())
		client := sdk.NewClient(&sdk.Implementation{Name: "manual-version-client", Version: "1"}, nil)
		ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
		defer cancel()
		session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: server.URL, HTTPClient: &http.Client{Transport: headerTransport{base: http.DefaultTransport, token: "alice"}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
		if err != nil {
			t.Fatal(err)
		}
		defer session.Close()
		result, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: "daynight://manuals/concepts.md"})
		if err != nil || len(result.Contents) != 1 || result.CacheScope != "private" || result.TTLMs != 0 {
			t.Fatalf("version read = %+v, %v", result, err)
		}
		for _, uri := range manualURIReference.FindAllString(result.Contents[0].Text, -1) {
			linked, err := session.ReadResource(ctx, &sdk.ReadResourceParams{URI: uri})
			if err != nil || len(linked.Contents) != 1 || linked.Contents[0].URI != uri || linked.Contents[0].Text == "" {
				t.Fatalf("version linked resource %s = %+v, %v", uri, linked, err)
			}
		}
		return result.Contents[0].Text
	}
	if first, second := read(productManualFS), read(files); first != original || second != updated || first == second {
		t.Fatal("new Entry did not publish the updated text at the same URI")
	}
}
