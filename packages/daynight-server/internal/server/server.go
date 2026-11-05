package server

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
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
	workersRoutes(mux, service.NewWorkers(dependencies.Store), auth, logger)
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(dependencies.Store), auth, logger)
	taskhttp.TaskStepsRoutes(mux, taskservice.NewTaskSteps(dependencies.Store), auth, logger)
	taskhttp.TaskThreadRoutes(mux, taskservice.NewTaskThreads(dependencies.Store), auth, logger)
	taskhttp.TaskSyncRoutes(mux, taskservice.NewTaskSync(dependencies.Store, config.TaskSyncOverlap), auth, logger, config.TaskSyncOverlap)
	attachmentRoutes(mux, service.NewAttachments(dependencies.Store, dependencies.Files), auth, logger)
	relay := newSessionRoutes(sessionrelay.New(dependencies.Store, dependencies.Files), auth, logger)
	botsRoutes(mux, service.NewBots(dependencies.Store), relay.service, auth, logger)
	relay.register(mux)
	healthRoutes(mux, dependencies.Store, logger)
	web := webhttp.New(webresources.New())
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return &sessionApplication{Handler: attachmentPathGuard(mux, logger), relay: relay}, nil
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
