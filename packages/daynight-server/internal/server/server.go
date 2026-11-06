package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

func New(dependencies Dependencies, config Config, logger *slog.Logger) (http.Handler, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	client, err := config.identityClient()
	if err != nil {
		return nil, err
	}
	identity := identityservice.New(dependencies.Store, client, config.UniAuthCallbackURL)
	auth, err := authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: config.PublicOrigin, AllowHTTPTestOrigin: config.AllowHTTPTestOrigin}, logger)
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	auth.RegisterRoutes(mux)
	projecthttp.NewMembershipRoutes(projectservice.NewMemberships(dependencies.Store), auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, projectservice.NewProjects(dependencies.Store), auth, logger)
	teamhttp.RegisterRoutes(mux, teamservice.NewTeams(dependencies.Store), auth, logger)
	workerhttp.RegisterRoutes(mux, workerservice.NewWorkers(dependencies.Store), auth, logger)
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(dependencies.Store), auth, logger)
	taskhttp.TaskSearchRoutes(mux, taskservice.NewTaskSearch(dependencies.Store), auth, logger)
	taskhttp.TaskStepsRoutes(mux, taskservice.NewTaskSteps(dependencies.Store), auth, logger)
	taskhttp.TaskThreadRoutes(mux, taskservice.NewTaskThreads(dependencies.Store), auth, logger)
	taskhttp.TaskSyncRoutes(mux, taskservice.NewTaskSync(dependencies.Store, config.TaskSyncOverlap), auth, logger, config.TaskSyncOverlap)
	attachmenthttp.RegisterRoutes(mux, attachmentservice.NewAttachments(dependencies.Store, dependencies.Files), auth, logger)
	engine := sessioncore.NewEngine(dependencies.Files)
	sessions := sessionservice.New(dependencies.Store, engine)
	deletions := botservice.NewDeletions(dependencies.Store, dependencies.Files, engine)
	relay := sessionhttp.NewRoutes(sessions, auth, logger)
	bothttp.RegisterRoutes(mux, botservice.New(dependencies.Store), deletions, auth, logger)
	bothttp.RegisterRuntimeRoutes(mux, sessions, deletions, auth, relay, logger)
	relay.RegisterRoutes(mux)
	healthRoutes(mux, dependencies.Store, logger)
	web := webhttp.New(webresources.New())
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return &sessionApplication{Handler: attachmenthttp.PathGuard(mux, logger), relay: relay, service: sessions, engine: engine}, nil
}

type sessionApplication struct {
	http.Handler
	relay   *sessionhttp.Routes
	service *sessionservice.Service
	engine  *sessioncore.Engine
}

func (a *sessionApplication) Shutdown(ctx context.Context) error {
	return errors.Join(a.relay.Shutdown(ctx), a.engine.Stop(ctx))
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
