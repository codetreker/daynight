package preview

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

const (
	StartPath     = "/auth/sso/start"
	AuthorizePath = "/api/v1/auth/preview/authorize"
	CallbackPath  = "/auth/sso/callback"
	CompletePath  = "/auth/sso/complete"
)

type Operations interface {
	Create(context.Context, string) (model.PreviewSSOLogin, error)
	Start(context.Context, string) (identity.PreviewSSOStart, error)
	Authorize(context.Context, string, string, model.Principal) (identity.PreviewSSOAuthorization, error)
	Redeem(context.Context, string, string, string) (identity.PreviewSSORedemption, error)
	Complete(context.Context, string, string) (string, error)
}

type Routes struct {
	ops           Operations
	authenticate  func(*http.Request) (model.Principal, error)
	main, preview *url.URL
	logger        *slog.Logger
}

func New(ops Operations, authenticate func(*http.Request) (model.Principal, error), mainOrigin, previewOrigin string, logger *slog.Logger) (*Routes, error) {
	parse := func(value string) (*url.URL, error) {
		u, err := url.Parse(value)
		if err != nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Scheme != "https" && u.Scheme != "http") || value != u.Scheme+"://"+u.Host {
			return nil, errors.New("preview SSO requires exact configured origins")
		}
		return u, nil
	}
	main, err := parse(mainOrigin)
	if err != nil {
		return nil, err
	}
	preview, err := parse(previewOrigin)
	if err != nil {
		return nil, err
	}
	if ops == nil || authenticate == nil || logger == nil {
		return nil, errors.New("preview SSO dependencies are unavailable")
	}
	return &Routes{ops: ops, authenticate: authenticate, main: main, preview: preview, logger: logger}, nil
}

func (h *Routes) RegisterMain(mux *http.ServeMux) {
	mux.HandleFunc(AuthorizePath, h.navigation("authorize", h.authorize))
}

func (h *Routes) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.EscapedPath() {
		case StartPath:
			h.navigation("start", h.start)(w, r)
		case CallbackPath:
			h.navigation("callback", h.callback)(w, r)
		case CompletePath:
			h.navigation("complete", h.complete)(w, r)
		default:
			securityHeaders(w)
			http.NotFound(w, r)
		}
	})
}

func securityHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (h *Routes) navigation(phase string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		securityHeaders(w)
		if r.Context().Err() != nil {
			return
		}
		if phase == "authorize" && r.URL.EscapedPath() != AuthorizePath {
			h.failure(w, r, phase, http.StatusBadRequest, "invalid_input", "")
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			h.failure(w, r, phase, http.StatusMethodNotAllowed, "method_not_allowed", "")
			return
		}
		next(w, r)
	}
}

func (h *Routes) start(w http.ResponseWriter, r *http.Request) {
	q, err := httpx.QueryValues(r, "login")
	if err != nil {
		h.fail(w, r, "start", err, "")
		return
	}
	id := q.Get("login")
	if id == "" {
		login, err := h.ops.Create(r.Context(), h.main.String()+"/projects")
		if err != nil {
			h.fail(w, r, "start", err, "")
			return
		}
		id = login.ID
	}
	started, err := h.ops.Start(r.Context(), id)
	if err != nil {
		h.fail(w, r, "start", err, "")
		return
	}
	if r.Context().Err() != nil {
		return
	}
	cookie := h.cookie(h.bindingCookieName(started.State), started.State, started.ExpiresAt)
	if err := cookie.Valid(); err != nil {
		h.fail(w, r, "start", err, "")
		return
	}
	http.SetCookie(w, cookie)
	h.redirect(w, r, "start", h.main.String()+AuthorizePath+"?"+url.Values{"login": {started.LoginID}, "state": {started.State}}.Encode())
}

func (h *Routes) authorize(w http.ResponseWriter, r *http.Request) {
	q, err := requiredQuery(r, "login", "state")
	if err != nil {
		h.fail(w, r, "authorize", err, "")
		return
	}
	principal, err := h.authenticate(r)
	if err != nil {
		h.fail(w, r, "authorize", err, r.URL.RequestURI())
		return
	}
	authorized, err := h.ops.Authorize(r.Context(), q.Get("login"), q.Get("state"), principal)
	if err != nil {
		h.fail(w, r, "authorize", err, "")
		return
	}
	h.redirect(w, r, "authorize", h.preview.String()+CallbackPath+"?"+url.Values{"code": {authorized.Code}, "state": {q.Get("state")}}.Encode())
}

func (h *Routes) callback(w http.ResponseWriter, r *http.Request) {
	q, err := requiredQuery(r, "code", "state")
	if err != nil {
		h.fail(w, r, "callback", err, "")
		return
	}
	binding, ok := requestCookie(r, h.bindingCookieName(q.Get("state")))
	if !ok || !secret.Valid(q.Get("state"), "") || !secret.Valid(binding, "") || subtle.ConstantTimeCompare([]byte(binding), []byte(q.Get("state"))) != 1 {
		h.fail(w, r, "callback", model.Unauthenticated(nil), "")
		return
	}
	result, err := h.ops.Redeem(r.Context(), q.Get("code"), q.Get("state"), binding)
	if err != nil {
		h.fail(w, r, "callback", err, "")
		return
	}
	if r.Context().Err() != nil {
		return
	}
	cookie := h.cookie(h.SessionCookieName(), result.Secret, result.ExpiresAt)
	// Numeric loopback fixtures have no subdomain namespace; IPv6 literals also
	// cannot appear in a Cookie Domain attribute.
	if net.ParseIP(h.preview.Hostname()) == nil {
		cookie.Domain = h.preview.Hostname()
	}
	if err := cookie.Valid(); err != nil {
		h.fail(w, r, "callback", err, "")
		return
	}
	http.SetCookie(w, cookie)
	clear := h.cookie(h.bindingCookieName(q.Get("state")), "", time.Unix(1, 0))
	clear.MaxAge = -1
	http.SetCookie(w, clear)
	h.redirect(w, r, "callback", h.preview.String()+CompletePath+"?"+url.Values{"login": {result.LoginID}}.Encode())
}

func (h *Routes) complete(w http.ResponseWriter, r *http.Request) {
	q, err := requiredQuery(r, "login")
	if err != nil {
		h.fail(w, r, "complete", err, "")
		return
	}
	value, ok := requestCookie(r, h.SessionCookieName())
	if !ok {
		h.fail(w, r, "complete", model.Unauthenticated(nil), "")
		return
	}
	target, err := h.ops.Complete(r.Context(), q.Get("login"), value)
	if err != nil {
		h.fail(w, r, "complete", err, "")
		return
	}
	h.redirect(w, r, "complete", target)
}

func requiredQuery(r *http.Request, names ...string) (url.Values, error) {
	q, err := httpx.QueryValues(r, names...)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if q.Get(name) == "" {
			return nil, httpx.InvalidInput("required SSO query parameter is missing")
		}
	}
	return q, nil
}

func (h *Routes) redirect(w http.ResponseWriter, r *http.Request, phase, target string) {
	if r.Context().Err() != nil {
		return
	}
	w.Header().Set("Location", target)
	w.WriteHeader(http.StatusSeeOther)
	h.logger.InfoContext(r.Context(), "preview SSO navigation completed", "component", "preview-sso", "phase", phase, "result", "redirect", "request_id", httpx.RequestID(r.Context()))
}
