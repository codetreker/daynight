package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

type Authentication struct {
	identity     *identityservice.Identity
	origin       string
	secure       bool
	callbackPath string
	logger       *slog.Logger
}

func NewAuthentication(identity *identityservice.Identity, settings config.AuthSettings, logger *slog.Logger) (*Authentication, error) {
	origin, callbackPath, err := config.ValidateAuthSettings(settings, identity.CallbackURL())
	if err != nil {
		return nil, err
	}
	return &Authentication{identity: identity, origin: settings.PublicOrigin, secure: origin.Scheme == "https", callbackPath: callbackPath, logger: logger}, nil
}

func (h *Authentication) Origin() string { return h.origin }

func (h *Authentication) SessionCookieName() string {
	if h.secure {
		return "__Host-daynight_session"
	}
	return "daynight_session"
}

func (h *Authentication) scopeCookieName() string {
	if h.secure {
		return "__Host-daynight_login_scope"
	}
	return "daynight_login_scope"
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

func Failure() error {
	return &model.Fault{Code: "unauthenticated", Message: "Authentication is required. Please log in again."}
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

func (h *Authentication) AuthenticateRequest(request *http.Request) (model.Principal, error) {
	if values, present := request.Header["Authorization"]; present {
		if len(values) != 1 {
			return model.Principal{}, Failure()
		}
		parts := strings.Fields(values[0])
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			return model.Principal{}, Failure()
		}
		return h.identity.Authenticate(request.Context(), model.PATCredential, parts[1])
	}
	secret, ok := requestCookie(request, h.SessionCookieName())
	if !ok {
		return model.Principal{}, Failure()
	}
	principal, err := h.identity.Authenticate(request.Context(), model.SessionCredential, secret)
	if err != nil {
		return model.Principal{}, err
	}
	if request.Method != "GET" && request.Method != "HEAD" && request.Method != "OPTIONS" {
		origins := request.Header.Values("Origin")
		if len(origins) != 1 || origins[0] != h.origin {
			return model.Principal{}, &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."}
		}
	}
	return principal, nil
}

func (h *Authentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		principal, err := h.AuthenticateRequest(request)
		if err != nil {
			httpx.CloseUnreadBody(w, request)
			httpx.WriteError(w, request, h.logger, "auth", "authenticate", err)
			return
		}
		w.Header().Set("Daynight-User-ID", principal.UserID)
		h.logger.InfoContext(request.Context(), "credential authenticated", "component", "auth", "phase", "authenticate", "user_id", principal.UserID, "credential_id", principal.CredentialID, "request_id", httpx.RequestID(request.Context()))
		next(w, request, principal)
	}
}

func (h *Authentication) RegisterRoutes(mux *http.ServeMux) {
	h.registerDeviceRoutes(mux)
	mux.HandleFunc("GET /api/v1/auth/login", h.login)
	mux.HandleFunc("GET "+h.callbackPath, h.callback)
	mux.HandleFunc("GET /api/v1/auth/providers", h.providers)
	mux.HandleFunc("HEAD /api/v1/auth/login", httpx.MethodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("HEAD "+h.callbackPath, httpx.MethodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("GET /api/v1/me", h.Require(h.me))
	mux.HandleFunc("POST /api/v1/auth/logout", h.Require(h.logout))
	mux.HandleFunc("GET /api/v1/me/tokens", h.Require(h.listTokens))
	mux.HandleFunc("POST /api/v1/me/tokens", h.Require(h.createToken))
	mux.HandleFunc("PATCH /api/v1/me/tokens/{tokenId}", h.Require(h.updateToken))
	mux.HandleFunc("DELETE /api/v1/me/tokens/{tokenId}", h.Require(h.revokeToken))
	for path, methods := range map[string]string{"/api/v1/auth/login": "GET", h.callbackPath: "GET", "/api/v1/auth/providers": "GET, HEAD", "/api/v1/me": "GET, HEAD", "/api/v1/auth/logout": "POST", "/api/v1/me/tokens": "GET, HEAD, POST", "/api/v1/me/tokens/{tokenId}": "PATCH, DELETE"} {
		fallback := httpx.MethodNotAllowed(h.logger, methods)
		if path == "/api/v1/auth/logout" || strings.HasPrefix(path, "/api/v1/me") {
			mux.HandleFunc(path, h.Require(func(w http.ResponseWriter, request *http.Request, _ model.Principal) { fallback(w, request) }))
		} else {
			mux.HandleFunc(path, fallback)
		}
	}
}

func (h *Authentication) login(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := httpx.QueryValues(request, "provider", "returnPath")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "login", err)
		return
	}
	if err := h.identity.ValidateLogin(values.Get("provider"), values.Get("returnPath")); err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "login", err)
		return
	}
	scope, ok := requestCookie(request, h.scopeCookieName())
	if !ok || !secret.Valid(scope, "") {
		scope = secret.Random("")
		http.SetCookie(w, h.cookie(h.scopeCookieName(), scope, time.Now().Add(identity.LoginLifetime), int(identity.LoginLifetime.Seconds())))
		http.Redirect(w, request, request.URL.RequestURI(), http.StatusSeeOther)
		return
	}
	start, err := h.identity.StartLogin(request.Context(), values.Get("provider"), values.Get("returnPath"), scope)
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "login", err)
		return
	}
	http.SetCookie(w, h.cookie(h.scopeCookieName(), scope, start.ExpiresAt, int(identity.LoginLifetime.Seconds())))
	http.SetCookie(w, h.cookie(h.bindingCookieName(start.State), start.BrowserBinding, start.ExpiresAt, int(identity.LoginLifetime.Seconds())))
	h.logger.InfoContext(request.Context(), "login started", "component", "auth", "phase", "login", "login_id", start.ID, "request_id", httpx.RequestID(request.Context()))
	http.Redirect(w, request, start.AuthorizationURL, http.StatusSeeOther)
}

func (h *Authentication) callback(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values, err := httpx.QueryValues(request, "state", "code", "error")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "callback", err)
		return
	}
	binding, ok := requestCookie(request, h.bindingCookieName(values.Get("state")))
	if !ok {
		httpx.WriteError(w, request, h.logger, "auth", "callback", Failure())
		return
	}
	result, err := h.identity.CompleteLogin(request.Context(), values, binding)
	logger := h.logger.With("login_id", result.LoginID)
	if result.LoginID != "" {
		http.SetCookie(w, h.cookie(h.bindingCookieName(values.Get("state")), "", time.Unix(1, 0), -1))
	}
	if err != nil {
		var identityFailure *model.IdentityProviderError
		if errors.As(err, &identityFailure) && identityFailure.Code == "identity_unavailable" {
			var violation *limit.Violation
			if errors.As(err, &violation) {
				logger = logger.With("size_bytes", violation.Actual, "max_bytes", violation.Max, "size_lower_bound", violation.LowerBound)
			}
			httpx.WriteError(w, request, logger, "auth", "callback", err)
			return
		}
		if result.LoginID != "" {
			httpx.LogFailure(logger, request.Context(), "auth", "callback", err)
			if request.Context().Err() == nil {
				failure := url.Values{"authError": {"login_failed"}, "returnPath": {result.ReturnPath}}
				http.Redirect(w, request, "/login?"+failure.Encode(), http.StatusSeeOther)
			}
		} else {
			httpx.WriteError(w, request, logger, "auth", "callback", err)
		}
		return
	}
	http.SetCookie(w, h.cookie(h.SessionCookieName(), result.Secret, result.Session.ExpiresAt, int(identity.SessionLifetime.Seconds())))
	logger.InfoContext(request.Context(), "login completed", "component", "auth", "phase", "callback", "user_id", result.User.ID, "credential_id", result.Session.ID, "request_id", httpx.RequestID(request.Context()))
	http.Redirect(w, request, result.ReturnPath, http.StatusSeeOther)
}

func userResponse(user model.User) api.User {
	return profileprotocol.UserResponse(user)
}
func tokenResponse(c model.PersonalAccessToken) api.PersonalAccessToken {
	return api.PersonalAccessToken{ID: c.ID, Name: c.Name, CreatedAt: c.CreatedAt.UTC(), ExpiresAt: utcTokenExpiry(c.ExpiresAt)}
}

func (h *Authentication) me(w http.ResponseWriter, request *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	user, err := h.identity.User(request.Context(), p)
	if err != nil {
		httpx.WriteError(w, request, h.logger.With("user_id", p.UserID), "auth", "me", err)
		return
	}
	h.writeCachedUser(w, request, userResponse(user))
}
func (h *Authentication) logout(w http.ResponseWriter, request *http.Request, p model.Principal) {
	if err := h.identity.Logout(request.Context(), p); err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "logout", err)
		return
	}
	http.SetCookie(w, h.cookie(h.SessionCookieName(), "", time.Unix(1, 0), -1))
	w.WriteHeader(http.StatusNoContent)
}
func (h *Authentication) listTokens(w http.ResponseWriter, request *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	tokens, err := h.identity.ListPATs(request.Context(), p)
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "list_tokens", err)
		return
	}
	result := api.PersonalAccessTokenList{Items: make([]api.PersonalAccessToken, 0, len(tokens))}
	for _, token := range tokens {
		result.Items = append(result.Items, tokenResponse(token))
	}
	httpx.WriteJSON(w, request, h.logger, http.StatusOK, result)
}
func (h *Authentication) createToken(w http.ResponseWriter, request *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	fields, err := httpx.DecodeObject(w, request, "name", "expiresAt")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	name, err := httpx.RequiredString(fields, "name")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	expiresAt, err := requiredTokenTimestamp(fields, "expiresAt")
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	result, err := h.identity.CreatePAT(request.Context(), p, identity.CreatePAT{Name: name, ExpiresAt: expiresAt})
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "create_token", err)
		return
	}
	httpx.WriteCreated(w, request, h.logger, "/api/v1/me/tokens/"+result.Credential.ID, api.CreatedPersonalAccessToken{PersonalAccessToken: tokenResponse(result.Credential), Token: result.Secret})
}
func (h *Authentication) revokeToken(w http.ResponseWriter, request *http.Request, p model.Principal) {
	if err := h.identity.RevokePAT(request.Context(), p, request.PathValue("tokenId")); err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "revoke_token", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Authentication) providers(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, err := httpx.QueryValues(request); err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "providers", err)
		return
	}
	providers, err := h.identity.Providers(request.Context())
	if err != nil {
		httpx.WriteError(w, request, h.logger, "auth", "providers", err)
		return
	}
	httpx.WriteJSON(w, request, h.logger, http.StatusOK, struct {
		Providers []string `json:"providers"`
	}{Providers: providers})
}
