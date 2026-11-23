package auth

import (
	"context"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	credentialhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/credential"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func browserSessionResponse(s model.Session) api.BrowserSession {
	return api.BrowserSession{ID: s.ID, Browser: s.Browser, OS: s.OS, CreatedAt: s.CreatedAt, LastUsedAt: s.LastUsedAt, ExpiresAt: s.ExpiresAt}
}

func (h *Authentication) registerBrowserSessionRoutes(routes accountRouteRegistry) {
	require := h.RequireCredentialSession
	routes.handle("GET /api/v1/me/browser-sessions", require(h.listBrowserSessions), accountBrowser, false)
	routes.handle("HEAD /api/v1/me/browser-sessions", httpx.MethodRejection(require(httpx.ResourceMethodNotAllowed(h.logger, "GET"))), accountBrowserFallback, false)
	routes.handle("/api/v1/me/browser-sessions", httpx.MethodRejection(require(httpx.ResourceMethodNotAllowed(h.logger, "GET"))), accountBrowserFallback, false)
	routes.handle("GET /api/v1/me/browser-sessions/{sessionId}", require(h.getBrowserSession), accountBrowser, false)
	routes.handle("HEAD /api/v1/me/browser-sessions/{sessionId}", httpx.MethodRejection(require(httpx.ResourceMethodNotAllowed(h.logger, "GET"))), accountBrowserFallback, false)
	routes.handle("/api/v1/me/browser-sessions/{sessionId}", httpx.MethodRejection(require(httpx.ResourceMethodNotAllowed(h.logger, "GET"))), accountBrowserFallback, false)
	routes.handle("POST /api/v1/me/browser-sessions/{sessionId}/revoke", require(h.revokeBrowserSession), accountBrowser, false)
	routes.handle("/api/v1/me/browser-sessions/{sessionId}/revoke", httpx.MethodRejection(require(httpx.ResourceMethodNotAllowed(h.logger, "POST"))), accountBrowserFallback, false)
}

func (h *Authentication) listBrowserSessions(w http.ResponseWriter, r *http.Request, p model.Principal) {
	page, err := httpx.PageRequest(r)
	if err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "list_browser_sessions", err)
		return
	}
	cursor := ""
	if page.Cursor != nil {
		cursor = *page.Cursor
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	result, err := h.identity.ListBrowserSessions(ctx, p, cursor, page.Limit)
	if err != nil {
		credentialhttp.WriteReadError(w, r, h.logger.With("user_id", p.UserID), "credential", "list_browser_sessions", err)
		return
	}
	items := make([]api.BrowserSession, 0, len(result.Items))
	for _, s := range result.Items {
		items = append(items, browserSessionResponse(s))
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, api.BrowserSessionList{UserID: result.UserID, Current: browserSessionResponse(result.Current), Items: items, NextCursor: result.NextCursor})
}

func (h *Authentication) getBrowserSession(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id := r.PathValue("sessionId")
	err := credentialhttp.NoQuery(r)
	if err == nil {
		err = credentialhttp.TargetID(id)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "get_browser_session", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	s, err := h.identity.GetBrowserSession(ctx, p, id)
	if err != nil {
		credentialhttp.WriteReadError(w, r, h.logger.With("user_id", p.UserID), "credential", "get_browser_session", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, browserSessionResponse(s))
}

func (h *Authentication) revokeBrowserSession(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id := r.PathValue("sessionId")
	fields, err := credentialhttp.Fields(w, r, "expectedUserId", "expectedSessionId")
	var user, session string
	if err == nil {
		err = credentialhttp.TargetID(id)
	}
	if err == nil {
		user, err = httpx.RequiredString(fields, "expectedUserId")
	}
	if err == nil {
		err = credentialhttp.TargetID(user)
	}
	if err == nil {
		session, err = httpx.RequiredString(fields, "expectedSessionId")
	}
	if err == nil {
		err = credentialhttp.TargetID(session)
	}
	if err != nil {
		httpx.WriteError(w, r, h.logger, "credential", "revoke_browser_session", err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	err = h.identity.RevokeBrowserSession(ctx, p, id, user, session)
	if err != nil {
		credentialhttp.WriteOperationError(w, r, h.logger.With("user_id", p.UserID, "credential_id", id), "credential", "revoke_browser_session", err, false)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
