package server

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/webui"
)

func uiRoutes(mux *http.ServeMux, logger *slog.Logger) {
	ui := webui.New()
	page := uiHandler(logger, ui.Page)
	asset := uiHandler(logger, ui.Asset)
	for _, pattern := range []string{
		"/{$}", "/projects/{projectId}", "/projects/{projectId}/members", "/projects/{projectId}/settings",
		"/projects/{projectId}/tasks/{taskId}",
		"/projects/{projectId}/tasks/{taskId}/attachments/{path...}", "/account", "/invitations", "/device",
	} {
		mux.HandleFunc("GET "+pattern, page)
		mux.HandleFunc(pattern, methodNotAllowed(logger, "GET, HEAD"))
	}
	mux.HandleFunc("GET /assets/", asset)
	mux.HandleFunc("/assets/", methodNotAllowed(logger, "GET, HEAD"))
}

func uiHandler(logger *slog.Logger, serve func(http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, request *http.Request) {
		if err := serve(w, request); err != nil {
			var responseError *webui.ResponseError
			if errors.As(err, &responseError) {
				LogFailure(logger, request.Context(), "webui", "response", err)
				return
			}
			if errors.Is(err, webui.ErrNotFound) {
				err = &service.Fault{Code: "not_found", Message: "resource not found", Cause: err}
			}
			writeError(w, request, logger, "webui", "read", err)
		}
	}
}
