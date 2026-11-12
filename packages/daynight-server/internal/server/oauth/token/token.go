package token

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

// TokenCodes and GrantLifecycle are supplied by the authorization and grant use cases.
type TokenCodes interface {
	RedeemCode(context.Context, service.RedeemInput) (service.TokenResult, error)
}
type GrantLifecycle interface {
	Rotate(context.Context, string, string, string, func(context.Context, string) error) (core.RotatedTokens, error)
	RevokePublic(context.Context, string, string) error
}

// PublicTokens exposes the complete public token and revocation adapters. The
// owner mounts them only when the complete OAuth profile is available.
type PublicTokens struct {
	Admission core.PublicAdmission
	Resource  string
	Codes     TokenCodes
	Grants    GrantLifecycle
	Logger    *slog.Logger
}

func publicHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Access-Control-Allow-Origin", "*")
}
func publicPost(w http.ResponseWriter, r *http.Request) bool {
	publicHeaders(w)
	if r.Method == http.MethodOptions {
		httpx.CloseUnreadBody(w, r)
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		httpx.CloseUnreadBody(w, r)
		w.Header().Set("Allow", "POST, OPTIONS")
		writeError(w, http.StatusMethodNotAllowed, "invalid_request")
		return false
	}
	return true
}
func publicForm(w http.ResponseWriter, r *http.Request) (url.Values, bool, error) {
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if r.URL.RawQuery != "" || err != nil || media != "application/x-www-form-urlencoded" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "utf-8")) {
		httpx.CloseUnreadBody(w, r)
		return nil, false, nil
	}
	body, err := httpx.ReadBody(w, r, core.MetadataLimit, transport.JSONBodyReadTimeout)
	if err != nil {
		return nil, false, err
	}
	values, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, false, nil
	}
	for key, entries := range values {
		if len(entries) != 1 || !utf8.ValidString(key) || !utf8.ValidString(entries[0]) || strings.ContainsRune(key, 0) || strings.ContainsRune(entries[0], 0) {
			return nil, false, nil
		}
		if entries[0] == "" {
			values.Del(key)
		}
	}
	return values, true, nil
}
func publicError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, core.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "slow_down")
	case errors.Is(err, core.ErrInvalidGrant):
		writeError(w, http.StatusBadRequest, "invalid_grant")
	case errors.Is(err, core.ErrAuthorizationUnknown):
		writeError(w, http.StatusServiceUnavailable, "outcome_unknown")
	default:
		writeError(w, http.StatusInternalServerError, "server_error")
	}
}

// Token consumes one global/source budget before parsing or looking up a secret.
func (h *PublicTokens) Token(w http.ResponseWriter, r *http.Request) {
	if !publicPost(w, r) {
		return
	}
	source := r.RemoteAddr
	if host, _, err := net.SplitHostPort(source); err == nil {
		source = host
	}
	permit, allowed, err := h.Admission.TakeToken(r.Context(), source)
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		publicError(w, err)
		return
	}
	if !allowed {
		httpx.CloseUnreadBody(w, r)
		publicError(w, core.ErrRateLimited)
		return
	}
	v, ok, readErr := publicForm(w, r)
	if readErr != nil {
		httpx.WriteBodyError(w, r, slog.Default(), "oauth", "token_body", readErr)
		return
	}
	if !ok || v.Get("grant_type") == "" || v.Get("client_id") == "" || v.Get("resource") == "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	if v.Get("resource") != h.Resource || h.Resource == "" {
		publicError(w, core.ErrInvalidGrant)
		return
	}
	admit := func(ctx context.Context, id string) error {
		ok, err := permit.TakeClient(ctx, id)
		if err != nil {
			return err
		}
		if !ok {
			return core.ErrRateLimited
		}
		return nil
	}
	var result service.TokenResult
	switch v.Get("grant_type") {
	case "authorization_code":
		if v.Get("code") == "" || v.Get("redirect_uri") == "" || v.Get("code_verifier") == "" || v.Has("refresh_token") || v.Has("scope") {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		result, err = h.Codes.RedeemCode(r.Context(), service.RedeemInput{Code: v.Get("code"), ClientID: v.Get("client_id"), RedirectURI: v.Get("redirect_uri"), Resource: v.Get("resource"), Verifier: v.Get("code_verifier"), AdmitClient: admit})
	case "refresh_token":
		if v.Get("refresh_token") == "" || v.Has("code") || v.Has("redirect_uri") || v.Has("code_verifier") {
			writeError(w, http.StatusBadRequest, "invalid_request")
			return
		}
		if v.Has("scope") && v.Get("scope") != core.Scope {
			writeError(w, http.StatusBadRequest, "invalid_scope")
			return
		}
		var rotated core.RotatedTokens
		rotated, err = h.Grants.Rotate(r.Context(), v.Get("refresh_token"), v.Get("client_id"), v.Get("resource"), admit)
		logger := h.Logger
		if logger == nil {
			logger = slog.Default()
		}
		_ = httpx.PublishCredentialUsageFaults(logger, r.Context())
		result = service.TokenResult{AccessToken: rotated.AccessToken, RefreshToken: rotated.RefreshToken, TokenType: "Bearer", Scope: core.Scope, ExpiresIn: rotated.ExpiresIn}
	default:
		writeError(w, http.StatusBadRequest, "unsupported_grant_type")
		return
	}
	if err != nil {
		publicError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		AccessToken  string `json:"access_token"`
		TokenType    string `json:"token_type"`
		ExpiresIn    int64  `json:"expires_in"`
		RefreshToken string `json:"refresh_token"`
		Scope        string `json:"scope"`
	}{result.AccessToken, result.TokenType, result.ExpiresIn, result.RefreshToken, result.Scope})
}

// Revoke does not reveal whether the supplied token belongs to the client.
func (h *PublicTokens) Revoke(w http.ResponseWriter, r *http.Request) {
	if !publicPost(w, r) {
		return
	}
	v, ok, readErr := publicForm(w, r)
	if readErr != nil {
		httpx.WriteBodyError(w, r, slog.Default(), "oauth", "revoke_body", readErr)
		return
	}
	if !ok || v.Get("token") == "" || v.Get("client_id") == "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	token := v.Get("token")
	if !secret.Valid(token, model.OAuthAccessPrefix) && !secret.Valid(token, core.RefreshPrefix) {
		w.WriteHeader(http.StatusOK)
		return
	}
	if err := h.Grants.RevokePublic(r.Context(), token, v.Get("client_id")); err != nil {
		publicError(w, err)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, struct {
		Error string `json:"error"`
	}{code})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
