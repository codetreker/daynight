package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type installationAuthenticator struct{ t *testing.T }

func (a installationAuthenticator) Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error) {
	a.t.Error("installation manual attempted authentication")
	return model.Principal{}, model.Unauthenticated(nil)
}

func TestMCPInstallationManual(t *testing.T) {
	const origin = "https://tasks.example:8443"
	e, err := New(installationAuthenticator{t}, origin, []string{"https://client.test"}, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	var manual string
	for _, tc := range []struct {
		name, method, accept, auth, host, origin string
		want                                     int
	}{
		{name: "default", method: http.MethodGet, want: 200},
		{name: "curl", method: http.MethodGet, accept: "*/*", want: 200},
		{name: "browser", method: http.MethodGet, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", want: 200},
		{name: "markdown", method: http.MethodGet, accept: "text/markdown", origin: "https://client.test", want: 200},
		{name: "credentials", method: http.MethodGet, auth: "Bearer unused", want: 200},
		{name: "head", method: http.MethodHead, want: 200},
		{name: "foreign host", method: http.MethodGet, host: "foreign.test", want: 403},
		{name: "foreign origin", method: http.MethodGet, origin: "https://foreign.test", want: 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := http.NewRequest(tc.method, server.URL+"/mcp", nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Header.Set("Forwarded", "host=foreign.test;proto=https")
			r.Header.Set("X-Forwarded-Host", "foreign.test")
			if tc.accept != "" {
				r.Header.Set("Accept", tc.accept)
			}
			if tc.auth != "" {
				r.Header.Set("Authorization", tc.auth)
			}
			if tc.host != "" {
				r.Host = tc.host
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			response, err := server.Client().Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.want || response.Header.Get("Cache-Control") != "no-store" {
				t.Fatalf("status %d, headers %#v, body %s", response.StatusCode, response.Header, body)
			}
			if tc.want != http.StatusOK {
				return
			}
			if response.Header.Get("Content-Type") != "text/markdown; charset=utf-8" || response.Header.Get("WWW-Authenticate") != "" {
				t.Fatalf("manual headers %#v", response.Header)
			}
			if tc.origin != "" && response.Header.Get("Access-Control-Allow-Origin") != tc.origin {
				t.Fatalf("manual CORS headers %#v", response.Header)
			}
			if response.Header.Get("Content-Length") != strconv.Itoa(len(e.manual)) {
				t.Fatalf("manual content length %q", response.Header.Get("Content-Length"))
			}
			if tc.method == http.MethodHead {
				if len(body) != 0 {
					t.Fatalf("HEAD returned body: %s", body)
				}
				return
			}
			manual = string(body)
			if !strings.HasPrefix(manual, "# Connect to Daynight MCP\n") || strings.Contains(manual, "foreign.test") || strings.Contains(manual, "{{MCP_") {
				t.Fatalf("invalid manual: %s", body)
			}
			for _, required := range []string{
				"codex mcp add daynight --url '" + origin + "/mcp'",
				"codex mcp login daynight", "codex mcp list",
				"claude mcp add --transport http daynight '" + origin + "/mcp'",
				"claude mcp login daynight", "claude mcp get daynight",
				"daynight:mcp", "account holder", "--no-browser", "team_list", "Authorization: Bearer <PAT>",
			} {
				if !strings.Contains(manual, required) {
					t.Errorf("manual is missing %q", required)
				}
			}
		})
	}
	_, encoded, found := strings.Cut(manual, "```json\n")
	if !found {
		t.Fatal("manual has no client configuration")
	}
	encoded, _, found = strings.Cut(encoded, "\n```")
	if !found {
		t.Fatal("client configuration code fence is not closed")
	}
	var config struct {
		MCPServers map[string]struct{ Type, URL string } `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(encoded), &config); err != nil {
		t.Fatal(err)
	}
	if got := config.MCPServers["daynight"]; got.Type != "http" || got.URL != origin+"/mcp" {
		t.Fatalf("client configuration %#v", config)
	}
	e.BeginShutdown()
	r := httptest.NewRequest(http.MethodGet, origin+"/mcp", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("manual after shutdown status %d", w.Code)
	}
}

func TestMCPInstallationPreservesProtocolRequests(t *testing.T) {
	e := additionalEntry(t, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, tc := range []struct {
		name, method string
		headers      http.Header
	}{
		{"stream", http.MethodGet, http.Header{"Accept": {"text/event-stream"}}},
		{"stream parameters", http.MethodGet, http.Header{"Accept": {"application/json", `TEXT/Event-Stream; charset=utf-8; profile="a,b"`}}},
		{"protocol", http.MethodGet, http.Header{"Mcp-Protocol-Version": {"2025-11-25"}}},
		{"session", http.MethodGet, http.Header{"Mcp-Session-Id": {"session"}}},
		{"resume", http.MethodGet, http.Header{"Last-Event-Id": {"event"}}},
		{"method", http.MethodGet, http.Header{"Mcp-Method": {"tools/list"}}},
		{"name", http.MethodGet, http.Header{"Mcp-Name": {"test"}}},
		{"empty protocol", http.MethodGet, http.Header{"Mcp-Protocol-Version": {""}}},
		{"protocol head", http.MethodHead, http.Header{"Mcp-Protocol-Version": {"2025-11-25"}}},
		{"post", http.MethodPost, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, authenticated := range []bool{false, true} {
				if tc.method == http.MethodPost && authenticated {
					continue
				}
				r := httptest.NewRequest(tc.method, "https://daynight.test/mcp", nil)
				r.Header = tc.headers.Clone()
				if r.Header == nil {
					r.Header = make(http.Header)
				}
				want := http.StatusUnauthorized
				if authenticated {
					r.Header.Set("Authorization", "Bearer alice")
					want = http.StatusMethodNotAllowed
				}
				w := httptest.NewRecorder()
				e.ServeHTTP(w, r)
				if w.Code != want || w.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("authenticated=%v status %d, headers %#v, body %s", authenticated, w.Code, w.Header(), w.Body)
				}
				if !authenticated && w.Header().Get("WWW-Authenticate") != `Bearer resource_metadata="https://daynight.test/.well-known/oauth-protected-resource/mcp"` {
					t.Fatalf("missing discovery challenge: %#v", w.Header())
				}
				if authenticated && w.Header().Get("Allow") != http.MethodPost {
					t.Fatalf("protocol methods %#v", w.Header())
				}
			}
		})
	}
}

func TestMCPInstallationDeliveryFailure(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	e := additionalEntry(t, logger)
	r := httptest.NewRequest(http.MethodGet, "https://daynight.test/mcp", nil)
	r.Header.Set("X-Request-ID", "manual-delivery")
	w := &failedResponseWriter{header: make(http.Header)}
	httpx.RequestLogging(logger, e).ServeHTTP(w, r)
	if w.status != http.StatusOK || !strings.Contains(logs.String(), `"msg":"MCP response delivery failed"`) || !strings.Contains(logs.String(), `"request_id":"manual-delivery"`) {
		t.Fatalf("manual delivery failure not recorded: status %d, logs %s", w.status, logs.String())
	}
}
