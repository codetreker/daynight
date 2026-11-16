package preview

import (
	"net/http"
	"net/url"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// Require authenticates a task-host request after the mux has parsed its path.
func (h *Routes) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if h.taskHost(r.Host) == "" || r.PathValue("taskId") != h.taskHost(r.Host) {
			httpx.WriteError(w, r, h.logger, "preview", "host", &model.Fault{Code: "not_found", Message: "resource not found"})
			return
		}
		value, present := requestCookie(r, h.SessionCookieName())
		var principal model.Principal
		var err error
		if present {
			principal, _, err = h.ops.Authenticate(r.Context(), value)
		} else {
			err = model.Unauthenticated(nil)
		}
		if err == nil {
			httpx.CloseUnreadBody(w, r)
			next(w, r, principal)
			return
		}
		if httpx.ErrorKind(err) != "unauthenticated" {
			httpx.WriteError(w, r, h.logger, "preview", "authenticate", err)
			return
		}
		if isDocument(r) {
			target := h.preview.Scheme + "://" + r.Host + r.URL.RequestURI()
			login, createErr := h.ops.Create(r.Context(), target)
			if createErr != nil {
				httpx.WriteError(w, r, h.logger, "preview", "create", createErr)
				return
			}
			h.redirect(w, r, "direct", h.preview.String()+StartPath+"?"+url.Values{"login": {login.ID}}.Encode())
			return
		}
		start := h.preview.String() + StartPath
		httpx.CloseUnreadBody(w, r)
		w.Header().Set("Link", "<"+start+">; rel=\"alternate\"")
		httpx.WriteJSON(w, r, h.logger, http.StatusUnauthorized, api.ErrorResponse{Error: api.Error{
			Code: "unauthenticated", Message: "Authentication is required. Sign in at " + start, RequestID: httpx.RequestID(r.Context()),
		}})
	}
}

func isDocument(r *http.Request) bool {
	return r.Method == http.MethodGet && r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		(r.Header.Get("Sec-Fetch-Dest") == "document" || r.Header.Get("Sec-Fetch-Dest") == "iframe")
}

type headWriter struct{ http.ResponseWriter }

func (w headWriter) Write(data []byte) (int, error) { return len(data), nil }
func (w headWriter) Unwrap() http.ResponseWriter    { return w.ResponseWriter }
