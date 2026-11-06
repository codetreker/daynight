package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
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
	if err := registerMCPTools(app, endpoint, config.PublicOrigin); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", endpoint)
	auth.RegisterRoutes(mux)
	projecthttp.NewMembershipRoutes(app.Memberships, auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, app.Projects, auth, logger)
	teamhttp.RegisterRoutes(mux, app.Teams, auth, logger)
	workerhttp.RegisterRoutes(mux, app.Workers, auth, logger)
	taskhttp.TaskRoutes(mux, app.Tasks, auth, logger)
	taskhttp.TaskSearchRoutes(mux, app.TaskSearch, auth, logger)
	taskhttp.TaskStepsRoutes(mux, app.TaskSteps, auth, logger)
	taskhttp.TaskThreadRoutes(mux, app.TaskThreads, auth, logger)
	taskhttp.TaskSyncRoutes(mux, app.TaskSync, auth, logger, config.TaskSyncOverlap)
	attachmenthttp.RegisterRoutes(mux, app.Attachments, auth, logger)
	engine := app.Engine
	sessions := app.Sessions
	deletions := app.BotDeletions
	relay := sessionhttp.NewRoutes(sessions, auth, logger)
	bothttp.RegisterRoutes(mux, app.Bots, deletions, auth, logger)
	bothttp.RegisterRuntimeRoutes(mux, sessions, deletions, auth, relay, logger)
	relay.RegisterRoutes(mux)
	healthRoutes(mux, dependencies.Ready, logger)
	web := webhttp.New(webresources.New())
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return &sessionApplication{Handler: attachmenthttp.PathGuard(mux, logger), relay: relay, service: sessions, engine: engine, mcp: endpoint}, nil
}

type sessionApplication struct {
	http.Handler
	relay   *sessionhttp.Routes
	service *sessionservice.Service
	engine  *sessioncore.Engine
	mcp     *mcphttp.Entry
}

func (a *sessionApplication) BeginShutdown() {
	if a.mcp != nil {
		a.mcp.BeginShutdown()
	}
}
func (a *sessionApplication) Shutdown(ctx context.Context) error {
	if a.mcp != nil {
		if err := a.mcp.Shutdown(ctx); err != nil {
			return err
		}
	}
	return errors.Join(a.relay.Shutdown(ctx), a.engine.Stop(ctx))
}

func healthRoutes(mux *http.ServeMux, readiness func(context.Context) error, logger *slog.Logger) {
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
		var err error
		if readiness == nil {
			err = errors.New("readiness is unavailable")
		} else {
			err = readiness(ready)
		}
		if err != nil {
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
func registerMCPTools(app *application.Application, entry *mcphttp.Entry, origin string) error {
	if err := registerMCPAdapters(
		func() error { return mcphttp.RegisterProjectTools(entry, app.Projects, app.Identity, origin) },
		func() error {
			return mcphttp.RegisterInvitationTools(entry, app.Identity, app.Teams, app.Memberships, origin)
		},
		func() error { return mcphttp.RegisterBotTools(entry, app.Bots, app.BotDeletions) },
		func() error { return mcphttp.RegisterTaskTools(entry, app.Tasks) },
		func() error { return mcphttp.RegisterStepReadTools(entry, app.TaskSteps) },
		func() error { return mcphttp.RegisterStepWriteTools(entry, app.TaskSteps) },
	)
}

// Stop registration at the first failure so incomplete adapters are never served.
func registerMCPAdapters(adapters ...func() error) error {
	for _, register := range adapters {
		if err := register(); err != nil {
			return err
		}
	}
	return nil
}
