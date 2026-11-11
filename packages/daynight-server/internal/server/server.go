package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth"
	oauthauthorization "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	granthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/grants"
	oauthtoken "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	prompthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/prompt"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
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
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
)

type Handler interface {
	http.Handler
	BeginShutdown()
	Shutdown(context.Context) error
}

func New(app *service.App, config configpkg.Config, logger *slog.Logger) (Handler, error) {
	auth, err := authhttp.NewAuthentication(app.Identity, authconfig.AuthSettings{PublicOrigin: config.Server.PublicOrigin, AllowHTTPTestOrigin: config.Server.AllowHTTPTestOrigin}, logger)
	if err != nil {
		return nil, err
	}
	endpoint, err := mcphttp.New(app.Identity, config.Server.PublicOrigin, config.MCP.Origins.AllowedOrigins, logger, app.OAuth)
	if err != nil {
		return nil, err
	}
	if app.OAuthProfile == nil {
		endpoint.BeginShutdown()
		return nil, errors.Join(errors.New("OAuth public profile is unavailable"), app.OAuthError)
	}
	if err := registerMCPTools(app.Application, endpoint, config.Server.PublicOrigin); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", endpoint)
	profile := app.OAuthProfile
	authorization := oauthauthorization.NewAuthorizationHTTP(profile.Authorizations, auth)
	web := webhttp.New(app.Web)
	authorization.SetStartErrorPage(web.BadRequestHandler(logger))
	tokens := &oauthtoken.PublicTokens{Admission: profile.Admission, Resource: config.Server.PublicOrigin + "/mcp", Codes: profile.Authorizations, Grants: profile.Grants}
	mux.Handle("/oauth/register", oauthhttp.Handler(profile.Clients))
	mux.HandleFunc("/oauth/authorize", authorization.Start)
	mux.HandleFunc("/oauth/token", tokens.Token)
	mux.HandleFunc("/oauth/revoke", tokens.Revoke)
	mux.HandleFunc("/api/v1/oauth/requests/{id}", authorization.Inspect)
	mux.HandleFunc("/api/v1/oauth/requests/{id}/decision", authorization.Decide)
	oauthhttp.RegisterMetadata(mux, config.Server.PublicOrigin)
	auth.RegisterRoutes(mux)
	granthttp.RegisterRoutes(mux, app.OAuthGrants, auth, logger)
	projecthttp.NewMembershipRoutes(app.Memberships, auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, app.Projects, auth, logger)
	teamhttp.RegisterRoutes(mux, app.Teams, auth, logger)
	workerhttp.RegisterRoutes(mux, app.Workers, auth, logger)
	prompthttp.RegisterRoutes(mux, app.Prompts, auth, logger)
	workerReadOnly := workerhttp.NewReadOnlyRoutes(app.WorkerReadOnly, auth, logger)
	workerReadOnly.RegisterRoutes(mux)
	taskhttp.TaskRoutes(mux, app.Tasks, app.TaskObservations, auth, logger)
	sessionhttp.RegisterInspectionRoutes(mux, app.TaskInspection, auth, logger)
	sessionhttp.RegisterHistoryRoutes(mux, app.TaskHistory, auth, logger)
	taskhttp.TaskSearchRoutes(mux, func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		return tasksearch.Search(ctx, app.TaskSearch, principal, projectID, input)
	}, auth, logger)
	taskhttp.TaskStepsRoutes(mux, app.TaskSteps, auth, logger)
	taskhttp.TaskThreadRoutes(mux, app.TaskThreads, auth, logger)
	taskhttp.TaskSyncRoutes(mux, app.TaskSync.Get, auth, logger, config.TaskSync.Overlap)
	attachmenthttp.RegisterRoutes(mux, app.Attachments, auth, logger)
	if app.Webhooks != nil {
		webhookhttp.NewRoutes(app.Webhooks, auth, logger).RegisterRoutes(mux)
	}
	sessions := app.Sessions
	deletions := app.BotDeletions
	relay := sessionhttp.NewRoutes(sessions, auth, logger, app.TaskHistory)
	bothttp.RegisterRoutes(mux, app.Bots, deletions, auth, logger)
	bothttp.RegisterRuntimeRoutes(mux, sessions, deletions, auth, relay, logger)
	relay.RegisterRoutes(mux)
	healthRoutes(mux, app.Ready, logger)
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return &sessionApplication{Handler: attachmenthttp.PathGuard(mux, logger), relay: relay, service: sessions, engine: app.Engine, mcp: endpoint, workerReadOnly: workerReadOnly, stopClaims: app.StopClaims}, nil
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
