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
	"sync/atomic"
	"testing"
	"time"

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

type manualCacheTransport struct {
	base          http.RoundTripper
	bad           atomic.Bool
	badResultType atomic.Bool
	checked       atomic.Int32
}

func (tr *manualCacheTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	response, err := tr.base.RoundTrip(req)
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
				if version == "2026-07-28" && (transport.badResultType.Load() || transport.checked.Load() != int32(1+2*len(productManualManifest))) {
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
	updated := strings.Replace(original, "Daynight", "DAYNIGHT", 1)
	if original == updated || len(original) != len(updated) {
		t.Fatal("fixture must supply a same-size updated edition")
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
