package oauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestMetadataPublishesCompletePublicProfile(t *testing.T) {
	mux := http.NewServeMux()
	RegisterMetadata(mux, "https://daynight.example")
	for _, tc := range []struct {
		path     string
		expected map[string]any
	}{
		{"/.well-known/oauth-protected-resource/mcp", map[string]any{
			"resource": "https://daynight.example/mcp", "authorization_servers": []any{"https://daynight.example"}, "scopes_supported": []any{"daynight:mcp"}, "bearer_methods_supported": []any{"header"},
		}},
		{"/.well-known/oauth-authorization-server", map[string]any{
			"issuer": "https://daynight.example", "authorization_endpoint": "https://daynight.example/oauth/authorize", "token_endpoint": "https://daynight.example/oauth/token", "registration_endpoint": "https://daynight.example/oauth/register", "revocation_endpoint": "https://daynight.example/oauth/revoke", "response_types_supported": []any{"code"}, "grant_types_supported": []any{"authorization_code", "refresh_token"}, "token_endpoint_auth_methods_supported": []any{"none"}, "revocation_endpoint_auth_methods_supported": []any{"none"}, "code_challenge_methods_supported": []any{"S256"}, "scopes_supported": []any{"daynight:mcp"}, "client_id_metadata_document_supported": true, "authorization_response_iss_parameter_supported": true,
		}},
	} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
		var got map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || w.Code != http.StatusOK || !reflect.DeepEqual(got, tc.expected) {
			t.Fatalf("%s: %d %#v %v", tc.path, w.Code, got, err)
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "*" || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: unsafe headers", tc.path)
		}
		w = httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, tc.path, nil))
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: POST status %d", tc.path, w.Code)
		}
	}
}
