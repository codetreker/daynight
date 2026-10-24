package server

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

func New(dependencies Dependencies, config Config, logger *slog.Logger) (http.Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	client, err := config.identityClient()
	if err != nil {
		return nil, err
	}
	identity := service.NewIdentity(dependencies.Store, client, config.UniAuthCallbackURL)
	auth, err := NewAuthentication(identity, AuthConfig{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, logger)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	NewMembershipRoutes(service.NewMemberships(dependencies.Store), auth, logger).RegisterRoutes(mux)
	projectRoutes(mux, service.NewProjects(dependencies.Store), auth, logger)
	taskRoutes(mux, service.NewTasks(dependencies.Store), auth, logger)
	taskSyncRoutes(mux, service.NewTaskSync(dependencies.Store, config.TaskSyncOverlap), auth, logger, config.TaskSyncOverlap)
	attachmentRoutes(mux, service.NewAttachments(dependencies.Store, dependencies.Files), auth, logger)
	healthRoutes(mux, dependencies.Store, logger)
	uiRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeError(w, request, logger, "server", "route", &service.Fault{Code: "not_found", Message: "resource not found"})
	})
	return attachmentPathGuard(mux, logger), nil
}

func healthRoutes(mux *http.ServeMux, database *store.Store, logger *slog.Logger) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, request, logger, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ready, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := database.Pool.Ping(ready); err != nil {
			LogFailure(logger, request.Context(), "health", "ready", err)
			writeJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "service_unavailable", Message: "Service is not ready.", RequestID: RequestID(request.Context())}})
			return
		}
		writeJSON(w, request, logger, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ready"})
	})
	for _, path := range []string{"/healthz", "/readyz"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, request *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			methodNotAllowed(logger, "GET, HEAD")(w, request)
		})
	}
}
