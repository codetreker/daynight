// Package oauth adapts public OAuth operations to HTTP without mounting them.
package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strings"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// RegistrationService applies public admission before allocating a client.
type RegistrationService interface {
	Register(context.Context, string, []byte) (core.ClientMetadata, error)
}

// Handler adapts registration to HTTP. The caller chooses whether and where to
// mount it; the handler never trusts forwarded source-address headers.
func Handler(service RegistrationService) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			httpx.CloseUnreadBody(w, r)
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodPost {
			httpx.CloseUnreadBody(w, r)
			w.Header().Set("Allow", "POST, OPTIONS")
			writeError(w, http.StatusMethodNotAllowed, "invalid_request")
			return
		}
		media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/json" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "utf-8")) {
			httpx.CloseUnreadBody(w, r)
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		body, err := httpx.ReadBody(w, r, core.MetadataLimit, transport.JSONBodyReadTimeout)
		if err != nil {
			httpx.WriteBodyError(w, r, slog.Default(), "oauth", "registration_body", err)
			return
		}
		source := r.RemoteAddr
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			source = host
		}
		metadata, err := service.Register(r.Context(), source, body)
		if err != nil {
			switch {
			case errors.Is(err, core.ErrInvalidClientMetadata):
				writeError(w, http.StatusBadRequest, "invalid_client_metadata")
			case errors.Is(err, core.ErrRateLimited):
				w.Header().Set("Retry-After", "60")
				writeError(w, http.StatusTooManyRequests, "slow_down")
			default:
				writeError(w, http.StatusInternalServerError, "server_error")
			}
			return
		}
		if metadata.ClientID == "" || metadata.TokenEndpointAuthMethod != "none" || len(metadata.RedirectURIs) == 0 {
			writeError(w, http.StatusInternalServerError, "server_error")
			return
		}
		writeJSON(w, http.StatusCreated, metadata)
	})
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{Error: code})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
