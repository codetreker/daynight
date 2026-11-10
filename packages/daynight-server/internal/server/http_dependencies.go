package server

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth"
	oauthauthorization "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	oauthtoken "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type httpDependencies struct {
	Auth             *authhttp.Authentication
	MCP              http.Handler
	Registration     oauthhttp.RegistrationService
	Authorizations   oauthauthorization.AuthorizationService
	TokenAdmission   oauthtoken.TokenAdmission
	TokenCodes       oauthtoken.TokenCodes
	TokenGrants      oauthtoken.GrantLifecycle
	OAuthGrants      oauthGrantOperations
	Projects         projecthttp.ProjectOperations
	Memberships      projecthttp.MembershipOperations
	Teams            teamOperations
	Workers          workerOperations
	Prompts          promptOperations
	WorkerReadOnly   *workerhttp.ReadOnlyRoutes
	Tasks            taskhttp.TaskService
	TaskObservations taskhttp.ObservationService
	TaskInspection   sessionInspection
	TaskHistory      sessionhttp.HistoryReader
	TaskSearch       taskhttp.SearchOperation
	TaskSteps        taskhttp.StepService
	TaskThreads      taskhttp.ThreadService
	TaskSync         taskhttp.SyncOperation
	Attachments      attachmentOperations
	Webhooks         *webhookhttp.Routes
	Relay            *sessionhttp.Routes
	Bots             botOperations
	BotDeletions     botDeletionOperations
	BotRuntime       botRuntimeOperations
	Web              *webhttp.UI
	Ready            func(context.Context) error
}

func httpDependenciesFromApp(app *service.App, auth *authhttp.Authentication, endpoint http.Handler, relay *sessionhttp.Routes, workerReadOnly *workerhttp.ReadOnlyRoutes, logger *slog.Logger) httpDependencies {
	profile := app.OAuthProfile
	deps := httpDependencies{
		Auth: auth, MCP: endpoint, Registration: profile.Clients,
		Authorizations: profile.Authorizations, TokenCodes: profile.Authorizations,
		TokenGrants: profile.Grants, OAuthGrants: app.OAuthGrants,
		TokenAdmission: func(ctx context.Context, source string) (oauthtoken.ClientPermit, bool, error) {
			return profile.Admission.TakeToken(ctx, source)
		},
		Projects: app.Projects, Memberships: app.Memberships, Teams: app.Teams,
		Workers: app.Workers, Prompts: app.Prompts, WorkerReadOnly: workerReadOnly,
		Tasks: app.Tasks, TaskObservations: app.TaskObservations,
		TaskInspection: app.TaskInspection, TaskHistory: app.TaskHistory,
		TaskSearch: func(ctx context.Context, principal model.Principal, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
			return tasksearch.Search(ctx, app.TaskSearch, principal, projectID, input)
		},
		TaskSteps: app.TaskSteps, TaskThreads: app.TaskThreads, TaskSync: app.TaskSync.Get,
		Attachments: app.Attachments, Relay: relay, Bots: app.Bots,
		BotDeletions: app.BotDeletions, BotRuntime: app.Sessions,
		Web: webhttp.New(app.Web), Ready: app.Ready,
	}
	if app.Webhooks != nil {
		deps.Webhooks = webhookhttp.NewRoutes(webhookhttp.Adapter{Service: app.Webhooks}, auth, logger)
	}
	return deps
}
