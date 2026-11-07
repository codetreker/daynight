package oauth

import (
	"net/http"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
)

// RegisterMetadata publishes only the capabilities supported by the public profile.
func RegisterMetadata(mux *http.ServeMux, issuer string) {
	metadata := func(value any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				writeError(w, http.StatusMethodNotAllowed, "invalid_request")
				return
			}
			writeJSON(w, http.StatusOK, value)
		}
	}
	mux.HandleFunc("/.well-known/oauth-protected-resource/mcp", metadata(map[string]any{
		"resource": issuer + "/mcp", "authorization_servers": []string{issuer},
		"scopes_supported": []string{core.Scope}, "bearer_methods_supported": []string{"header"},
	}))
	mux.HandleFunc("/.well-known/oauth-authorization-server", metadata(map[string]any{
		"issuer": issuer, "authorization_endpoint": issuer + "/oauth/authorize",
		"token_endpoint": issuer + "/oauth/token", "registration_endpoint": issuer + "/oauth/register",
		"revocation_endpoint": issuer + "/oauth/revoke", "response_types_supported": []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported": []string{"none"}, "revocation_endpoint_auth_methods_supported": []string{"none"},
		"code_challenge_methods_supported": []string{"S256"}, "scopes_supported": []string{core.Scope},
		"client_id_metadata_document_supported": true, "authorization_response_iss_parameter_supported": true,
	}))
}
