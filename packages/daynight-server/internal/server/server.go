package server

import (
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

type Handler interface {
	http.Handler
	BeginShutdown()
	Shutdown(context.Context) error
}

func New(app *service.App, config configpkg.Config, logger *slog.Logger) (Handler, error) {
	auth, err := authhttp.NewAuthentication(app.Identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, logger)
	if err != nil {
		return nil, err
	}
	endpoint, err := mcphttp.New(app.Identity, config.PublicOrigin, config.MCPAllowedOrigins, logger, app.OAuth)
	if err != nil {
		return nil, err
	}
	if app.OAuthProfile == nil {
		endpoint.BeginShutdown()
		return nil, errors.Join(errors.New("OAuth public profile is unavailable"), app.OAuthError)
	}
	if err := registerMCPTools(app.Application, endpoint, config.PublicOrigin); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	relay := sessionhttp.NewRoutes(app.Sessions, auth, logger, app.TaskHistory)
	workerReadOnly := workerhttp.NewReadOnlyRoutes(app.WorkerReadOnly, auth, logger)
	deps := httpDependenciesFromApp(app, auth, endpoint, relay, workerReadOnly, logger)
	return &sessionApplication{Handler: newHTTPHandler(deps, config, logger), relay: relay, service: app.Sessions, engine: app.Engine, mcp: endpoint, workerReadOnly: workerReadOnly, stopClaims: app.StopClaims}, nil
}

type sessionApplication struct {
	http.Handler
	relay          *sessionhttp.Routes
	service        *sessionservice.Service
	engine         *sessioncore.Engine
	mcp            *mcphttp.Entry
	workerReadOnly *workerhttp.ReadOnlyRoutes
	stopClaims     func()
}

func (a *sessionApplication) BeginShutdown() {
	if a.stopClaims != nil {
		a.stopClaims()
	}
	if a.workerReadOnly != nil {
		a.workerReadOnly.BeginShutdown()
	}
	if a.mcp != nil {
		a.mcp.BeginShutdown()
	}
}

func (a *sessionApplication) Shutdown(ctx context.Context) error {
	if a.workerReadOnly != nil {
		if err := a.workerReadOnly.Shutdown(ctx); err != nil {
			return err
		}
	}
	if a.mcp != nil {
		if err := a.mcp.Shutdown(ctx); err != nil {
			return err
		}
	}
	return a.relay.Shutdown(ctx)
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
	return registerMCPAdapters(
		func() error { return mcphttp.RegisterProjectTools(entry, app.Projects, app.Identity, origin) },
		func() error { return mcphttp.RegisterTeamTools(entry, app.Teams, app.Projects, app.Identity) },
		func() error {
			return mcphttp.RegisterInvitationTools(entry, app.Identity, app.Teams, app.Memberships, origin)
		},
		func() error { return mcphttp.RegisterBotTools(entry, app.Bots, app.BotDeletions) },
		func() error { return mcphttp.RegisterThreadTools(entry, app.TaskThreads) },
		func() error { return mcphttp.RegisterTaskTools(entry, app.Tasks, app.TaskObservations) },
		func() error { return mcphttp.RegisterTaskQueryTools(entry, app.Tasks, app.TaskObservations) },
		func() error { return mcphttp.RegisterTaskWorkTools(entry, app.TaskObservations) },
		func() error {
			return mcphttp.RegisterSessionTools(entry, func(e *mcphttp.Entry) error {
				return mcphttp.RegisterSessionReadTools(e, app.TaskHistory, app.TaskInspection)
			}, mcphttp.SessionSendModule(app.Sessions))
		},
		func() error { return mcphttp.RegisterStepReadTools(entry, app.TaskSteps) },
		func() error { return mcphttp.RegisterStepWriteTools(entry, app.TaskSteps) },
		func() error { return mcphttp.RegisterAttachmentTools(entry, app.Attachments) },
		func() error { return mcphttp.RegisterDownloadTool(entry, app.Downloads) },
		func() error {
			if app.Uploads == nil {
				return errors.New("upload service is required")
			}
			return mcphttp.RegisterUploadTools(entry, app.Uploads)
		},
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
