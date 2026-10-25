package server

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type AuthConfig struct {
	PublicOrigin        string
	AllowHTTPTestOrigin bool
}

type Authentication struct {
	identity     *service.Identity
	origin       string
	secure       bool
	callbackPath string
	logger       *slog.Logger
}

func NewAuthentication(identity *service.Identity, config AuthConfig, logger *slog.Logger) (*Authentication, error) {
	origin, callbackPath, err := validateAuthSettings(config, identity.CallbackURL())
	if err != nil {
		return nil, err
	}
	return &Authentication{identity: identity, origin: config.PublicOrigin, secure: origin.Scheme == "https", callbackPath: callbackPath, logger: logger}, nil
}

func (h *Authentication) SessionCookieName() string {
	if h.secure {
		return "__Host-daynight_session"
	}
	return "daynight_session"
}

func (h *Authentication) bindingCookieName(state string) string {
	hash := sha256.Sum256([]byte(state))
	prefix := "daynight_login_"
	if h.secure {
		prefix = "__Host-daynight_login_"
	}
	return prefix + hex.EncodeToString(hash[:16])
}

func (h *Authentication) cookie(name, value string, expires time.Time, maxAge int) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/", Secure: h.secure, HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge}
}

func authFailure() error {
	return &service.Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
}

func requestCookie(request *http.Request, name string) (string, bool) {
	value, count := "", 0
	for _, cookie := range request.Cookies() {
		if cookie.Name == name {
			value, count = cookie.Value, count+1
		}
	}
	return value, count == 1
}

func (h *Authentication) AuthenticateRequest(request *http.Request) (core.Principal, error) {
	if values, present := request.Header["Authorization"]; present {
		if len(values) != 1 {
			return core.Principal{}, authFailure()
		}
		parts := strings.Fields(values[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return core.Principal{}, authFailure()
		}
		return h.identity.Authenticate(request.Context(), core.PATCredential, parts[1])
	}
	secret, ok := requestCookie(request, h.SessionCookieName())
	if !ok {
		return core.Principal{}, authFailure()
	}
	principal, err := h.identity.Authenticate(request.Context(), core.SessionCredential, secret)
	if err != nil {
		return core.Principal{}, err
	}
	if request.Method != "GET" && request.Method != "HEAD" && request.Method != "OPTIONS" {
		origins := request.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != h.origin {
			return core.Principal{}, &service.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."}
		}
	}
	return principal, nil
}

type AuthenticatedHandler func(http.ResponseWriter, *http.Request, core.Principal)

func (h *Authentication) Require(next AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		principal, err := h.AuthenticateRequest(request)
		if err != nil {
			writeError(w, request, h.logger, "auth", "authenticate", err)
			return
		}
		w.Header().Set("Daynight-User-ID", principal.UserID)
		h.logger.InfoContext(request.Context(), "credential authenticated", "component", "auth", "phase", "authenticate", "user_id", principal.UserID, "credential_id", principal.CredentialID, "request_id", RequestID(request.Context()))
		next(w, request, principal)
	}
}

func (h *Authentication) RegisterRoutes(mux *http.ServeMux) {
	h.registerDeviceRoutes(mux)
	mux.HandleFunc("GET /api/v1/auth/login", h.login)
	mux.HandleFunc("GET "+h.callbackPath, h.callback)
	mux.HandleFunc("GET /api/v1/auth/providers", h.providers)
	mux.HandleFunc("HEAD /api/v1/auth/login", methodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("HEAD "+h.callbackPath, methodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("GET /api/v1/me", h.Require(h.me))
	mux.HandleFunc("POST /api/v1/auth/logout", h.Require(h.logout))
	mux.HandleFunc("GET /api/v1/me/tokens", h.Require(h.listTokens))
	mux.HandleFunc("POST /api/v1/me/tokens", h.Require(h.createToken))
	mux.HandleFunc("PATCH /api/v1/me/tokens/{tokenId}", h.Require(h.updateToken))
	mux.HandleFunc("DELETE /api/v1/me/tokens/{tokenId}", h.Require(h.revokeToken))
	for path, methods := range map[string]string{"/api/v1/auth/login": "GET", h.callbackPath: "GET", "/api/v1/auth/providers": "GET, HEAD", "/api/v1/me": "GET, HEAD", "/api/v1/auth/logout": "POST", "/api/v1/me/tokens": "GET, HEAD, POST", "/api/v1/me/tokens/{tokenId}": "PATCH, DELETE"} {
		fallback := methodNotAllowed(h.logger, methods)
		if path == "/api/v1/auth/logout" || strings.HasPrefix(path, "/api/v1/me") {
			mux.HandleFunc(path, h.Require(func(w http.ResponseWriter, request *http.Request, _ core.Principal) { fallback(w, request) }))
		} else {
			mux.HandleFunc(path, fallback)
		}
	}
}

func (h *Authentication) login(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := queryValues(request, "provider", "returnPath")
	if err != nil {
		writeError(w, request, h.logger, "auth", "login", err)
		return
	}
	start, err := h.identity.StartLogin(request.Context(), values.Get("provider"), values.Get("returnPath"))
	if err != nil {
		writeError(w, request, h.logger, "auth", "login", err)
		return
	}
	http.SetCookie(w, h.cookie(h.bindingCookieName(start.State), start.BrowserBinding, start.ExpiresAt, int(service.LoginLifetime.Seconds())))
	h.logger.InfoContext(request.Context(), "login started", "component", "auth", "phase", "login", "login_id", start.ID, "request_id", RequestID(request.Context()))
	http.Redirect(w, request, start.AuthorizationURL, http.StatusSeeOther)
}

func (h *Authentication) callback(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := queryValues(request, "state", "code", "error")
	if err != nil {
		writeError(w, request, h.logger, "auth", "callback", err)
		return
	}
	binding, ok := requestCookie(request, h.bindingCookieName(values.Get("state")))
	if !ok {
		writeError(w, request, h.logger, "auth", "callback", authFailure())
		return
	}
	result, err := h.identity.CompleteLogin(request.Context(), values, binding)
	logger := h.logger.With("login_id", result.LoginID)
	if result.LoginID != "" {
		http.SetCookie(w, h.cookie(h.bindingCookieName(values.Get("state")), "", time.Unix(1, 0), -1))
	}
	if err != nil {
		if result.LoginID != "" {
			LogFailure(logger, request.Context(), "auth", "callback", err)
			if request.Context().Err() == nil {
				http.Redirect(w, request, "/?authError=login_failed", http.StatusSeeOther)
			}
		} else {
			writeError(w, request, logger, "auth", "callback", err)
		}
		return
	}
	http.SetCookie(w, h.cookie(h.SessionCookieName(), result.Secret, result.Session.ExpiresAt, int(service.SessionLifetime.Seconds())))
	logger.InfoContext(request.Context(), "login completed", "component", "auth", "phase", "callback", "user_id", result.User.ID, "credential_id", result.Session.ID, "request_id", RequestID(request.Context()))
	http.Redirect(w, request, result.ReturnPath, http.StatusSeeOther)
}

func userResponse(user core.User) api.User {
	return api.User{ID: user.ID, Email: user.Email, EmailVerified: user.EmailVerified, Name: user.Name, AvatarURL: user.AvatarURL}
}
func tokenResponse(c core.PersonalAccessToken) api.PersonalAccessToken {
	return api.PersonalAccessToken{ID: c.ID, Name: c.Name, CreatedAt: c.CreatedAt.UTC(), ExpiresAt: utcTokenExpiry(c.ExpiresAt)}
}

func (h *Authentication) me(w http.ResponseWriter, request *http.Request, p core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := h.identity.User(request.Context(), p)
	if err != nil {
		writeError(w, request, h.logger.With("user_id", p.UserID), "auth", "me", err)
		return
	}
	writeJSON(w, request, h.logger, http.StatusOK, userResponse(user))
}
func (h *Authentication) logout(w http.ResponseWriter, request *http.Request, p core.Principal) {
	if err := h.identity.Logout(request.Context(), p); err != nil {
		writeError(w, request, h.logger, "auth", "logout", err)
		return
	}
	http.SetCookie(w, h.cookie(h.SessionCookieName(), "", time.Unix(1, 0), -1))
	w.WriteHeader(http.StatusNoContent)
}
func (h *Authentication) listTokens(w http.ResponseWriter, request *http.Request, p core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	tokens, err := h.identity.ListPATs(request.Context(), p)
	if err != nil {
		writeError(w, request, h.logger, "auth", "list_tokens", err)
		return
	}
	result := api.PersonalAccessTokenList{Items: make([]api.PersonalAccessToken, 0, len(tokens))}
	for _, token := range tokens {
		result.Items = append(result.Items, tokenResponse(token))
	}
	writeJSON(w, request, h.logger, http.StatusOK, result)
}
func (h *Authentication) createToken(w http.ResponseWriter, request *http.Request, p core.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	fields, err := decodeObject(w, request, "name", "expiresAt")
	if err != nil {
		writeError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	name, err := requiredString(fields, "name")
	if err != nil {
		writeError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	expiresAt, err := requiredTokenTimestamp(fields, "expiresAt")
	if err != nil {
		writeError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	result, err := h.identity.CreatePAT(request.Context(), p, service.CreatePAT{Name: name, ExpiresAt: expiresAt})
	if err != nil {
		writeError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	writeCreated(w, request, h.logger, "/api/v1/me/tokens/"+result.Credential.ID, api.CreatedPersonalAccessToken{PersonalAccessToken: tokenResponse(result.Credential), Token: result.Secret})
}
func (h *Authentication) revokeToken(w http.ResponseWriter, request *http.Request, p core.Principal) {
	if err := h.identity.RevokePAT(request.Context(), p, request.PathValue("tokenId")); err != nil {
		writeError(w, request, h.logger, "auth", "revoke_token", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Authentication) providers(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, err := queryValues(request); err != nil {
		writeError(w, request, h.logger, "auth", "providers", err)
		return
	}
	providers, err := h.identity.Providers(request.Context())
	if err != nil {
		writeError(w, request, h.logger, "auth", "providers", err)
		return
	}
	writeJSON(w, request, h.logger, http.StatusOK, struct {
		Providers []string `json:"providers"`
	}{Providers: providers})
}
