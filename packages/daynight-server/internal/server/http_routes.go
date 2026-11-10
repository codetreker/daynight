package server

import (
	"log/slog"
	"net/http"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth"
	oauthauthorization "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	granthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/grants"
	oauthtoken "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	prompthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/prompt"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	teamhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/team"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
)

func newHTTPHandler(deps httpDependencies, config configpkg.Config, logger *slog.Logger) http.Handler {
	auth := deps.Auth
	mux := http.NewServeMux()
	mux.Handle("/mcp", deps.MCP)
	authorization := oauthauthorization.NewAuthorizationHTTP(deps.Authorizations, auth)
	web := deps.Web
	authorization.SetStartErrorPage(web.BadRequestHandler(logger))
	tokens := &oauthtoken.PublicTokens{Admission: deps.TokenAdmission, Resource: config.PublicOrigin + "/mcp", Codes: deps.TokenCodes, Grants: deps.TokenGrants}
	mux.Handle("/oauth/register", oauthhttp.Handler(deps.Registration))
	mux.HandleFunc("/oauth/authorize", authorization.Start)
	mux.HandleFunc("/oauth/token", tokens.Token)
	mux.HandleFunc("/oauth/revoke", tokens.Revoke)
	mux.HandleFunc("/api/v1/oauth/requests/{id}", authorization.Inspect)
	mux.HandleFunc("/api/v1/oauth/requests/{id}/decision", authorization.Decide)
	oauthhttp.RegisterMetadata(mux, config.PublicOrigin)
	auth.RegisterRoutes(mux)
	granthttp.RegisterRoutes(mux, deps.OAuthGrants, auth, logger)
	projecthttp.NewMembershipRoutes(deps.Memberships, auth, logger).RegisterRoutes(mux)
	projecthttp.RegisterRoutes(mux, deps.Projects, auth, logger)
	teamhttp.RegisterRoutes(mux, deps.Teams, auth, logger)
	workerhttp.RegisterRoutes(mux, deps.Workers, auth, logger)
	prompthttp.RegisterRoutes(mux, deps.Prompts, auth, logger)
	workerReadOnly := deps.WorkerReadOnly
	workerReadOnly.RegisterRoutes(mux)
	taskhttp.TaskRoutes(mux, deps.Tasks, deps.TaskObservations, auth, logger)
	sessionhttp.RegisterInspectionRoutes(mux, deps.TaskInspection, auth, logger)
	sessionhttp.RegisterHistoryRoutes(mux, deps.TaskHistory, auth, logger)
	taskhttp.TaskSearchRoutes(mux, deps.TaskSearch, auth, logger)
	taskhttp.TaskStepsRoutes(mux, deps.TaskSteps, auth, logger)
	taskhttp.TaskThreadRoutes(mux, deps.TaskThreads, auth, logger)
	taskhttp.TaskSyncRoutes(mux, deps.TaskSync, auth, logger, config.TaskSyncOverlap)
	attachmenthttp.RegisterRoutes(mux, deps.Attachments, auth, logger)
	if deps.Webhooks != nil {
		deps.Webhooks.RegisterRoutes(mux)
	}
	sessions := deps.BotRuntime
	deletions := deps.BotDeletions
	relay := deps.Relay
	bothttp.RegisterRoutes(mux, deps.Bots, deletions, auth, logger)
	bothttp.RegisterRuntimeRoutes(mux, sessions, deletions, auth, relay, logger)
	relay.RegisterRoutes(mux)
	healthRoutes(mux, deps.Ready, logger)
	web.RegisterRoutes(mux, logger)
	mux.HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	return attachmenthttp.PathGuard(mux, logger)
}
