// Package authorization adapts OAuth authorization use cases to HTTP.
package authorization

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/google/uuid"
)

// AuthorizationService is the transaction-backed authorization use case. It
// returns secrets only after a confirmed commit.
type AuthorizationService interface {
	Start(context.Context, service.StartInput) (service.StartResult, error)
	Inspect(context.Context, string, string, model.Principal) (service.AuthorizationView, error)
	Decide(context.Context, service.DecisionInput) (service.DecisionResult, error)
	RedeemCode(context.Context, service.RedeemInput) (service.TokenResult, error)
}

// BrowserAuthentication is implemented by the existing browser authenticator.
type BrowserAuthentication interface {
	AuthenticateRequest(*http.Request) (model.Principal, error)
	Origin() string
}

// AuthorizationHTTP provides unmounted handlers for the authorization flow.
// Production route selection and the complete token endpoint belong to their
// respective integrators. The origin must be the configured issuer origin.
type AuthorizationHTTP struct {
	service        AuthorizationService
	auth           BrowserAuthentication
	secure         bool
	startErrorPage http.Handler
}

func NewAuthorizationHTTP(s AuthorizationService, auth BrowserAuthentication) *AuthorizationHTTP {
	return &AuthorizationHTTP{service: s, auth: auth, secure: strings.HasPrefix(auth.Origin(), "https://")}
}

// SetStartErrorPage supplies the local browser error page. Non-browser callers
// continue to receive OAuth JSON error responses.
func (h *AuthorizationHTTP) SetStartErrorPage(page http.Handler) { h.startErrorPage = page }

func (h *AuthorizationHTTP) startError(w http.ResponseWriter, r *http.Request, code string) {
	w.Header().Add("Vary", "Accept")
	if h.startErrorPage != nil && strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.Header().Set("X-OAuth-Error", code)
		h.startErrorPage.ServeHTTP(w, r)
		return
	}
	writeError(w, http.StatusBadRequest, code)
}

func (h *AuthorizationHTTP) cookieName(id string) string {
	sum := sha256.Sum256([]byte(id))
	prefix := "daynight_oauth_"
	if h.secure {
		prefix = "__Host-daynight_oauth_"
	}
	return prefix + hex.EncodeToString(sum[:16])
}

func (h *AuthorizationHTTP) binding(r *http.Request, id string) (string, bool) {
	value, count := "", 0
	for _, cookie := range r.Cookies() {
		if cookie.Name == h.cookieName(id) {
			value, count = cookie.Value, count+1
		}
	}
	return value, count == 1 && value != ""
}

func safeHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Referrer-Policy", "no-referrer")
}

func validID(id string) bool {
	parsed, err := uuid.Parse(id)
	return err == nil && parsed != uuid.Nil && parsed.String() == id
}

func singleValues(raw string, allowed ...string) (url.Values, bool) {
	if len(raw) > core.MetadataLimit {
		return nil, false
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, false
	}
	for key, entries := range values {
		found := false
		for _, candidate := range allowed {
			if key == candidate {
				found = true
				break
			}
		}
		if !found || len(entries) != 1 || (entries[0] == "" && key != "state") || !utf8.ValidString(key) || !utf8.ValidString(entries[0]) || strings.ContainsRune(entries[0], 0) {
			return nil, false
		}
	}
	return values, true
}

func sourceAddress(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// Start validates the public request before allocating a browser-bound request.
func (h *AuthorizationHTTP) Start(w http.ResponseWriter, r *http.Request) {
	safeHeaders(w)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "invalid_request")
		return
	}
	v, ok := singleValues(r.URL.RawQuery, "client_id", "redirect_uri", "response_type", "scope", "resource", "state", "code_challenge", "code_challenge_method")
	if !ok {
		h.startError(w, r, "invalid_request")
		return
	}
	result, err := h.service.Start(r.Context(), service.StartInput{Source: sourceAddress(r), ClientID: v.Get("client_id"), RedirectURI: v.Get("redirect_uri"), ResponseType: v.Get("response_type"), Scope: v.Get("scope"), Resource: v.Get("resource"), State: v.Get("state"), StatePresent: v.Has("state"), CodeChallenge: v.Get("code_challenge"), CodeChallengeMethod: v.Get("code_challenge_method")})
	if err != nil {
		if errors.Is(err, core.ErrInvalidClient) {
			h.startError(w, r, "invalid_client")
			return
		}
		if errors.Is(err, core.ErrInvalidAuthorization) {
			h.startError(w, r, "invalid_request")
			return
		}
		authorizationError(w, err)
		return
	}
	if !validID(result.RequestID) || result.Binding == "" {
		writeError(w, http.StatusInternalServerError, "server_error")
		return
	}
	// Each request has a distinct cookie so opening a second tab cannot replace
	// the binding for an earlier pending or completed request.
	http.SetCookie(w, &http.Cookie{Name: h.cookieName(result.RequestID), Value: result.Binding, Path: "/", MaxAge: 25 * 60 * 60, Secure: h.secure, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	http.Redirect(w, r, "/oauth/consent?"+url.Values{"request": {result.RequestID}}.Encode(), http.StatusSeeOther)
}

func (h *AuthorizationHTTP) session(r *http.Request, write bool) (model.Principal, error) {
	if write {
		origins := r.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != h.auth.Origin() {
			return model.Principal{}, &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."}
		}
	}
	p, err := h.auth.AuthenticateRequest(r)
	if err != nil {
		return model.Principal{}, err
	}
	if p.Kind != model.SessionCredential || model.RequirePrincipal(p) != nil {
		return model.Principal{}, model.Unauthenticated(nil)
	}
	return p, nil
}

func sessionError(w http.ResponseWriter, err error) {
	switch httpx.ErrorKind(err) {
	case "unauthenticated":
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case "forbidden", "permission_denied":
		writeError(w, http.StatusForbidden, "forbidden")
	default:
		writeError(w, http.StatusInternalServerError, "server_error")
	}
}

// Inspect returns only the use case's safe view. It never returns state or code.
func (h *AuthorizationHTTP) Inspect(w http.ResponseWriter, r *http.Request) {
	safeHeaders(w)
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "invalid_request")
		return
	}
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	p, err := h.session(r, false)
	if err != nil {
		sessionError(w, err)
		return
	}
	id := r.PathValue("id")
	binding, ok := h.binding(r, id)
	if !validID(id) || !ok {
		writeError(w, http.StatusNotFound, "invalid_request")
		return
	}
	view, err := h.service.Inspect(r.Context(), id, binding, p)
	if err != nil {
		authorizationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// Decide requires the displayed account and exact origin on every write.
func (h *AuthorizationHTTP) Decide(w http.ResponseWriter, r *http.Request) {
	safeHeaders(w)
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "invalid_request")
		return
	}
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	p, err := h.session(r, true)
	if err != nil {
		sessionError(w, err)
		return
	}
	id := r.PathValue("id")
	binding, ok := h.binding(r, id)
	if !validID(id) || !ok {
		writeError(w, http.StatusNotFound, "invalid_request")
		return
	}
	fields, err := httpx.DecodeObject(w, r, "expectedUserId", "decision")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	expected, err := httpx.RequiredString(fields, "expectedUserId")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	decision, err := httpx.RequiredString(fields, "decision")
	if err != nil || (decision != "approve" && decision != "deny") {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	result, err := h.service.Decide(r.Context(), service.DecisionInput{RequestID: id, Binding: binding, Principal: p, ExpectedUserID: expected, Decision: decision})
	if err != nil {
		authorizationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, struct {
		RedirectURI string `json:"redirectUri"`
	}{result.RedirectURI})
}

// RedeemCode is a controlled code-only adapter; the final token endpoint must
// budget and route both code and refresh grants before invoking the use case.
func (h *AuthorizationHTTP) RedeemCode(w http.ResponseWriter, r *http.Request) {
	safeHeaders(w)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		writeError(w, http.StatusMethodNotAllowed, "invalid_request")
		return
	}
	if r.URL.RawQuery != "" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/x-www-form-urlencoded" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "utf-8")) {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, core.MetadataLimit))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	v, ok := singleValues(string(body), "grant_type", "code", "client_id", "redirect_uri", "resource", "code_verifier")
	if !ok || v.Get("grant_type") != "authorization_code" {
		writeError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	result, err := h.service.RedeemCode(r.Context(), service.RedeemInput{Code: v.Get("code"), ClientID: v.Get("client_id"), RedirectURI: v.Get("redirect_uri"), Resource: v.Get("resource"), Verifier: v.Get("code_verifier")})
	if err != nil {
		authorizationError(w, err)
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

func authorizationError(w http.ResponseWriter, err error) {
	switch {
	case httpx.ErrorKind(err) == "unauthenticated":
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, core.ErrRateLimited):
		w.Header().Set("Retry-After", "60")
		writeError(w, http.StatusTooManyRequests, "slow_down")
	case errors.Is(err, core.ErrInvalidClient):
		writeError(w, http.StatusBadRequest, "invalid_client")
	case errors.Is(err, core.ErrInvalidAuthorization):
		writeError(w, http.StatusBadRequest, "invalid_request")
	case errors.Is(err, core.ErrInvalidGrant):
		writeError(w, http.StatusBadRequest, "invalid_grant")
	case errors.Is(err, core.ErrAuthorizationCapacity):
		writeError(w, http.StatusServiceUnavailable, "temporarily_unavailable")
	case errors.Is(err, core.ErrAuthorizationUnknown):
		writeError(w, http.StatusServiceUnavailable, "outcome_unknown")
	default:
		writeError(w, http.StatusInternalServerError, "server_error")
	}
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
