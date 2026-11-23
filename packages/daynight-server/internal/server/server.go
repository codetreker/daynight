package server

import (
	"encoding/json"
	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	assistanttaskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/assistanttask"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/cors"
	githubhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	oauthhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth"
	oauthauthorization "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/authorization"
	granthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/grants"
	s2shttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/s2s"
	oauthtoken "github.com/codetreker/daynight/packages/daynight-server/internal/server/oauth/token"
	previewhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/preview"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	prompthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/prompt"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	taghttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/tag"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	usagehttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/usage"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	webhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webui"
	workerhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

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
	if app.ScopeError != nil {
		return nil, app.ScopeError
	}
	if app.Scoped == nil {
		return nil, errors.New("credential scope assembly is unavailable")
	}
	if app.PreviewSSOError != nil {
		return nil, app.PreviewSSOError
	}
	if app.UsageError != nil {
		return nil, app.UsageError
	}
	if app.Identity.PreviewSSO() == nil {
		return nil, errors.New("preview SSO is unavailable")
	}
	if err := config.S2S.Validate(config.Server.AllowHTTPTestOrigin); err != nil {
		return nil, err
	}
	if app.CredentialUsage == nil {
		return nil, errors.New("credential usage recorder is unavailable")
	}
	observe := func(ctx context.Context, source usage.Source, event model.CredentialUsageEvent) error {
		_, err := app.CredentialUsage.Record(credentialusage.WithSource(ctx, source), event)
		return err
	}
	auth, err := authhttp.NewAuthentication(app.Identity, authconfig.AuthSettings{PublicOrigin: config.Server.PublicOrigin, AllowHTTPTestOrigin: config.Server.AllowHTTPTestOrigin}, logger, observe)
	if err != nil {
		return nil, err
	}
	if app.OAuth != nil {
		auth.BindAPIAccess(app.OAuth.AuthenticateAPIAccess, config.S2S.AllowedOrigin)
	}
	endpoint, err := mcphttp.New(app.Identity, config.Server.PublicOrigin, config.MCP.Origins.AllowedOrigins, logger, app.OAuth, observe)
	if err != nil {
		return nil, err
	}
	if app.OAuthProfile == nil {
		endpoint.BeginShutdown()
		return nil, errors.Join(errors.New("OAuth public profile is unavailable"), app.OAuthError)
	}
	if err := endpoint.EnableScopedAuthentication(mcphttp.PolicyAuthenticator{Source: app.Scoped.Credentials}); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := registerScopedMCPTools(app.Application, endpoint, config.Server.PublicOrigin); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	mux := http.NewServeMux()
	routes := newScopeRegistry(mux, "main")
	routes.fixed("mcp-per-request-policy").Handle("/mcp", endpoint)
	profile := app.OAuthProfile
	authorization := oauthauthorization.NewAuthorizationHTTP(profile.Authorizations, auth)
	web := webhttp.New(app.Web, config.Server.PreviewOrigin)
	authorization.SetStartErrorPage(web.BadRequestHandler(logger))
	tokens := &oauthtoken.PublicTokens{Admission: profile.Admission, Resource: config.Server.PublicOrigin + "/mcp", APIResource: config.Server.PublicOrigin + "/api/v1", Codes: profile.Authorizations, Grants: profile.Grants, Logger: logger}
	routes.fixed("s2s-api-issuer").Handle("/api/v1/oauth/s2s/token", s2shttp.New(app.APIIssuer, config.S2S.SharedKey, logger))
	routes.fixed("public-oauth").Handle("/oauth/register", oauthhttp.Handler(profile.Clients))
	routes.fixed("public-oauth").HandleFunc("/oauth/authorize", authorization.Start)
	routes.fixed("public-oauth").HandleFunc("/oauth/token", tokens.Token)
	routes.fixed("public-oauth").HandleFunc("/oauth/revoke", tokens.Revoke)
	routes.fixed("browser-oauth-binding").HandleFunc("/api/v1/oauth/requests/{id}", httpx.MethodDispatch(authorization.Inspect, http.MethodGet))
	routes.fixed("browser-oauth-binding").HandleFunc("/api/v1/oauth/requests/{id}/decision", httpx.MethodDispatch(authorization.Decide, http.MethodPost))
	oauthhttp.RegisterMetadata(routes.fixed("public-oauth-discovery"), config.Server.PublicOrigin)
	scopedAuth := authhttp.WithCredentialPolicy(auth, app.Scoped.Credentials.Current)
	if err := auth.RegisterScopedAccountRoutes(routes.scoped("account-and-browser-credential-management"), scopedAuth, app.Identity.(authhttp.ScopedProfile), app.Scoped.Credentials.ProfileWrite, observeScopeRoutes[authhttp.ScopeRoute](routes)); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := auth.RegisterScopedDeviceRoutesWithScopeObserver(routes.fixed("browser-device-selection-and-public-device-protocol"), app.Scoped.MCPCatalog, observeScopeRoutes[authhttp.ScopeRoute](routes)); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := authorization.RegisterScopedRoutesWithScopeObserver(routes.fixed("browser-oauth-selection"), observeScopeRoutes[oauthauthorization.ScopeRoute](routes)); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	preview, err := previewhttp.New(app.Identity.PreviewSSO(), auth.AuthenticateSessionRequest, config.Server.PublicOrigin, config.Server.PreviewOrigin, logger)
	if err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	preview.RegisterMain(routes.fixed("browser-preview-sso"))
	auth.BindPreviewLogin(preview.StartAfterLogin)
	grantManagement, err := coreoauth.NewScopedGrantManagement(app.OAuthGrants, app.Scoped.MCPCatalog)
	if err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	granthttp.RegisterScopedRoutesWithScopeObserver(routes.fixed("browser-grant-management"), app.OAuthGrants, grantManagement, auth, logger, observeScopeRoutes[granthttp.ScopeRoute](routes))
	if err := projecthttp.RegisterScopedRoutes(routes.scoped("project-fields-and-projection"), projectservice.NewScopedProjects(app.Projects), projectservice.NewScopedMemberships(app.Memberships, app.Scoped.Credentials.Read), projectservice.NewScopedDirectMembers(app.ProjectDirectMembers, app.Scoped.Credentials.ProjectWrite), scopedAuth, logger); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	taghttp.RegisterScopedRoutes(routes.scoped("tag-operation-and-response"), tagservice.NewScoped(app.Scoped.Credentials.Database), scopedAuth, logger)
	githubRoutes := githubhttp.NewRouteRegistry(routes.scoped("github-operation-and-profile"), observeScopeRoutes[githubhttp.ScopeRoute](routes))
	githubhttp.RegisterScopedPullRequestRoutes(githubRoutes, app.GitHubRead, scopedAuth, logger)
	githubhttp.RegisterScopedAppRoutes(githubRoutes, app.GitHubApps, app.GitHubConfig, scopedAuth, config.Server.PublicOrigin, logger)
	githubhttp.RegisterScopedAdminRoutes(githubRoutes, app.GitHubAdmins, scopedAuth, config.Server.PublicOrigin, logger)
	githubhttp.RegisterScopedGrantRoutes(githubRoutes, app.GitHubGrants, scopedAuth, logger)
	githubhttp.RegisterScopedProjectAppRoutes(githubRoutes, app.GitHubProject, scopedAuth, logger)
	if app.GitHubWebhook != nil {
		githubhttp.RegisterAppWebhookRoute(routes.fixed("github-signed-delivery"), app.GitHubWebhook, logger)
	}
	teamhttp.RegisterRoutes(routes.scoped("team-operation-and-response"), app.Teams, auth, logger)
	teamhttp.RegisterDirectMemberRoutes(routes.scoped("team-members-current-policy"), app.DirectMembers, auth, logger)
	workerhttp.RegisterScopedRoutes(routes.scoped("worker-report-configuration-and-read"), app.Workers, scopedAuth, logger, observeScopeRoutes[workerhttp.ScopeRoute](routes))
	prompthttp.RegisterScopedRoutes(routes.scoped("prompt-read-and-write"), app.Prompts, scopedAuth, logger, observeScopeRoutes[prompthttp.ScopeRoute](routes))
	workerReadOnly := workerhttp.NewScopedReadOnlyRoutes(app.WorkerReadOnly, scopedAuth, logger)
	workerReadOnly.RegisterRoutesWithScopeObserver(routes.scoped("worker-readonly-requester-and-producer"), observeScopeRoutes[workerhttp.ScopeRoute](routes))
	if err := taskhttp.ScopedReadRoutes(routes.scoped("task-query-and-projection"), app.Tasks, app.Scoped.Observations, app.TaskSync, scopedAuth, logger, config.TaskSync.Overlap); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := taskhttp.RegisterScopedWriteRoutes(routes.scoped("task-fields-response-and-claim-completion"), app.Tasks, app.Tasks, scopedAuth, logger); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := taskhttp.RegisterScopedWorkerClaimRoutes(routes.scoped("worker-claim-lifecycle"), app.Tasks, scopedAuth, logger); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	usagehttp.RegisterScopedRoutesWithScopeObserver(routes.scoped("usage-user-and-producer-profile"), app.Usage, auth, scopedAuth, logger, observeScopeRoutes[usagehttp.ScopeRoute](routes))
	taskhttp.PersonalTaskRoutes(routes.scoped("task-personal-projection"), func(ctx context.Context, p model.Principal, limit int, cursor *string) (taskservice.PersonalTaskPage, error) {
		a, err := app.Scoped.Credentials.Current(ctx, p)
		if err != nil {
			return taskservice.PersonalTaskPage{}, err
		}
		return taskservice.NewScopedObservations(app.Scoped.Observations, a).PersonalTasks(ctx, p, limit, cursor)
	}, auth, logger)
	readBind, err := sessionhttp.NewScopedReadContextBinder(scopedAuth.Resolve, app.Scoped.Session.SessionWrite, app.Scoped.Session.SessionSnapshot)
	if err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := sessionhttp.RegisterScopedInspectionRoutes(routes.scoped("session-inspection-current-policy"), app.TaskInspection, auth, readBind, logger); err != nil {
		return nil, err
	}
	if err := sessionhttp.RegisterScopedHistoryRoutes(routes.scoped("session-history-current-policy"), app.TaskHistory, auth, readBind, logger); err != nil {
		return nil, err
	}
	if err := sessionhttp.RegisterScopedGroupDirectoryRoutes(routes.scoped("session-directory-current-policy"), app.HistoryDirectory, auth, readBind, logger); err != nil {
		return nil, err
	}
	if err := taskhttp.ScopedTaskSearchRoutes(routes.scoped("task-search-snapshot"), func(ctx context.Context, authorization model.CredentialAuthorization, projectID string, input tasksearch.Request) (tasksearch.Page, error) {
		return tasksearch.SearchScoped(ctx, app.TaskSearch, authorization, projectID, input)
	}, scopedAuth, logger); err != nil {
		return nil, err
	}
	taskhttp.TaskStepsScopedRoutes(routes.scoped("step-operation-and-response"), app.Scoped.Steps, scopedAuth, logger)
	taskhttp.ScopedTaskThreadRoutesObserved(routes.scoped("thread-operation-and-response"), app.Scoped.Threads, scopedAuth, logger, observeScopeRoutes[taskhttp.ThreadScopeRoute](routes))
	attachmenthttp.RegisterScopedRoutesWithScopeObserver(routes.scoped("attachment-method-host-and-response"), app.Scoped.Attachments, scopedAuth, logger, config.Server.PreviewOrigin, observeScopeRoutes[attachmenthttp.ScopeRoute](routes))
	taskPreviewMux := http.NewServeMux()
	previewRoutes := newScopeRegistry(taskPreviewMux, "task-preview")
	attachmenthttp.RegisterPreviewRoutesWithScopeObserver(previewRoutes.fixed("preview-cookie-only"), app.Attachments, preview.Require, logger, observeScopeRoutes[attachmenthttp.ScopeRoute](previewRoutes), preview.RenewAuthorized)
	if app.Webhooks != nil {
		if err := webhookhttp.RegisterScopedRoutes(routes.scoped("webhook-mutation-fields-and-delivery"), app.Webhooks, scopedAuth, logger, observeScopeRoutes[webhookhttp.ScopeRoute](routes)); err != nil {
			return nil, err
		}
	}
	sessions := app.Sessions
	deletions := app.BotDeletions
	relay := sessionhttp.NewRoutes(sessions, auth, logger, app.TaskHistory)
	channelAdmission, err := sessionhttp.NewScopedUserChannelAdmission(scopedAuth.Resolve, sessionservice.NewScopedReadChecker(sessions, app.Scoped.Session.SessionWrite))
	if err != nil {
		return nil, err
	}
	if err := relay.EnableScopedSessionReads(readBind, channelAdmission); err != nil {
		return nil, err
	}
	if err := assistanttaskhttp.RegisterScopedRoutes(routes.scoped("assistant-task-action-and-profile"), app.AssistantTasks, auth, logger, app.Scoped.Credentials.Current, observeScopeRoutes[assistanttaskhttp.RouteClassification](routes)); err != nil {
		return nil, err
	}
	if app.AssistantTaskInbox != nil {
		// Public: the inbox token or a verified Daynight delivery is the credential.
		assistanttaskhttp.RegisterInboxRoute(routes.fixed("assistant-inbox-token-or-signed-delivery"), app.AssistantTaskInbox)
	}
	bothttp.RegisterRoutes(routes.scoped("bot-definition-and-projection"), app.Bots, deletions, auth, logger)
	bothttp.RegisterRuntimeRoutesWithScopeObserver(routes.scoped("bot-session-command-and-producer"), sessions, deletions, auth, relay, logger, observeScopeRoutes[bothttp.RuntimeScopeRoute](routes))
	bothttp.RegisterRecoveryRoutesWithScopeObserver(routes.scoped("bot-session-recovery"), sessions, auth, relay, logger, observeScopeRoutes[bothttp.RuntimeScopeRoute](routes))
	relay.RegisterRoutesWithScopeObservers(routes.scoped("session-command-read-producer-and-child-token"), observeScopeRoutes[sessionhttp.ProducerRoute](routes), observeScopeRoutes[sessionhttp.ImageOccurrenceRoute](routes))
	healthRoutes(routes.fixed("public-health"), app.Ready, logger)
	web.RegisterRoutes(routes.fixed("public-web-assets-and-navigation"), logger)
	routes.fixed("not-found-fallback").HandleFunc("/", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteError(w, request, logger, "server", "route", &model.Fault{Code: "not_found", Message: "resource not found"})
	})
	if err := routes.validate(); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	if err := previewRoutes.validate(); err != nil {
		endpoint.BeginShutdown()
		return nil, err
	}
	main := cors.Wrap(attachmenthttp.PathGuard(mux, logger), mux, config.S2S.AllowedOrigin, logger, auth.CallbackPath(), previewhttp.AuthorizePath, previewhttp.RetryPath)
	return &sessionApplication{Handler: preview.Wrap(main, attachmenthttp.PathGuard(taskPreviewMux, logger)), relay: relay, service: sessions, engine: app.Engine, mcp: endpoint, workerReadOnly: workerReadOnly, stopClaims: app.StopClaims, scopeRoutes: append(routes.inventory(), previewRoutes.inventory()...), scopeDetails: append(routes.details, previewRoutes.details...)}, nil
}

type sessionApplication struct {
	scopeRoutes  []routeClassification
	scopeDetails []json.RawMessage
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

func healthRoutes(mux httpx.RouteRegistrar, readiness func(context.Context) error, logger *slog.Logger) {
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

// Stop registration at the first failure so incomplete adapters are never served.
func registerMCPAdapters(adapters ...func() error) error {
	for _, register := range adapters {
		if err := register(); err != nil {
			return err
		}
	}
	return nil
}
