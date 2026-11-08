package webui

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	resources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
)

func (ui *UI) RegisterRoutes(mux *http.ServeMux, logger *slog.Logger) {
	page := uiHandler(logger, ui.Page)
	asset := uiHandler(logger, ui.Asset)
	for _, pattern := range []string{
		"/{$}", "/login", "/projects", "/teams/{teamId}", "/teams/{teamId}/settings", "/teams/{teamId}/members", "/shared-projects", "/projects/{projectId}", "/projects/{projectId}/members", "/projects/{projectId}/settings",
		"/projects/{projectId}/tasks/{taskId}", "/test-sessions", "/test-sessions/{sessionId}", "/bots", "/bots/{botId}", "/workers", "/workers/{workerId}",
		"/projects/{projectId}/tasks/{taskId}/attachments/{path...}", "/account", "/invitations", "/team-invitations", "/device", "/setup",
	} {
		mux.HandleFunc("GET "+pattern, page)
		mux.HandleFunc(pattern, httpx.MethodNotAllowed(logger, "GET, HEAD"))
	}
	mux.HandleFunc("GET /oauth/consent", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Referrer-Policy", "no-referrer")
		page(w, r)
	})
	mux.HandleFunc("/oauth/consent", httpx.MethodNotAllowed(logger, "GET, HEAD"))
	mux.HandleFunc("GET /assets/", asset)
	mux.HandleFunc("/assets/", httpx.MethodNotAllowed(logger, "GET, HEAD"))
}

func (ui *UI) BadRequestHandler(logger *slog.Logger) http.Handler {
	return uiHandler(logger, ui.BadRequestPage)
}

func uiHandler(logger *slog.Logger, serve func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if err := serve(w, request); err != nil {
			var responseError *ResponseError
			if errors.As(err, &responseError) {
				httpx.LogFailure(logger, request.Context(), "webui", "response", err)
				return
			}
			if errors.Is(err, resources.ErrNotFound) {
				err = &model.Fault{Code: "not_found", Message: "resource not found", Cause: err}
			}
			httpx.WriteError(w, request, logger, "webui", "read", err)
		}
	}
}
