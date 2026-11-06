package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
)

func New(dependencies Dependencies, config Config, logger *slog.Logger) (http.Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	client, err := config.identityClient()
	if err != nil {
		return nil, err
	}
	app := application.New(dependencies.Store, dependencies.Files, client, config.UniAuthCallbackURL, config.TaskSyncOverlap)
	auth, err := authhttp.NewAuthentication(app.Identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, logger)
	if err != nil {
		return nil, err
	}
	endpoint, err := mcphttp.New(app.Identity, config.PublicOrigin, config.MCPAllowedOrigins, logger)
	if err != nil {
		return nil, err
	}
	if err := registerMCPTools(app, endpoint); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", endpoint)
	auth.RegisterRoutes(mux)
	projecthttp.NewMembershipRoutes(app.Memberships, auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, app.Projects, auth, logger)
	teamhttp.RegisterRoutes(mux, app.Teams, auth, logger)
	workersRoutes(mux, app.Workers, auth, logger)
	taskhttp.TaskRoutes(mux, app.Tasks, auth, logger)
	taskhttp.TaskStepsRoutes(mux, app.TaskSteps, auth, logger)
	taskhttp.TaskThreadRoutes(mux, app.TaskThreads, auth, logger)
	taskhttp.TaskSyncRoutes(mux, app.TaskSync, auth, logger, config.TaskSyncOverlap)
	attachmentRoutes(mux, app.Attachments, auth, logger)
	relay := newSessionRoutes(app.Relay, auth, logger)
	botsRoutes(mux, app.Bots, relay.service, auth, logger)
	relay.register(mux)
	healthRoutes(mux, dependencies.Store, logger)
	web := webhttp.New(webresources.New())
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return &sessionApplication{Handler: attachmentPathGuard(mux, logger), relay: relay, mcp: endpoint}, nil
}

func healthRoutes(mux *http.ServeMux, database *store.Store, logger *slog.Logger) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ready, cancel := context.WithTimeout(request.Context(), 2*time.Second)
		defer cancel()
		if err := database.Pool.Ping(ready); err != nil {
			httpx.LogFailure(logger, request.Context(), "health", "ready", err)
			httpx.WriteJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "service_unavailable", Message: "Service is not ready.", RequestID: httpx.RequestID(request.Context())}})
			return
		}
		httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
			Status string `json:"status"`
		}{Status: "ready"})
	})
	for _, path := range []string{"/healthz", "/readyz"} {
		mux.HandleFunc(path, func(w http.ResponseWriter, request *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			httpx.MethodNotAllowed(logger, "GET, HEAD")(w, request)
		})
	}
}

// registerMCPTools is the composition point for complete domain adapters.
// The entry starts with an empty discovery list until such adapters are registered.
func registerMCPTools(_ *application.Application, _ *mcphttp.Entry) error { return nil }
