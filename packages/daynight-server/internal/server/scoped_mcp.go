package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	mcphttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/mcp"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
)

func registerScopedMCPTools(app *application.Application, entry *mcphttp.Entry, origin string) error {
	s := app.Scoped
	projects := projectservice.NewScopedProjects(app.Projects)
	if err := registerMCPAdapters(
		func() error { return mcphttp.RegisterScopedProjectTools(entry, projects, app.Identity, origin) },
		func() error {
			return mcphttp.RegisterCombinedScopedTeamTools(entry, app.Teams, projects, app.Identity, s.Credentials.Current)
		},
		func() error {
			return mcphttp.RegisterCombinedScopedInvitationTools(entry, app.Identity, app.Teams, projectservice.NewScopedMemberships(app.Memberships, s.Credentials.Read), origin, s.Credentials.Current)
		},
		func() error { return mcphttp.RegisterScopedBotTools(entry, app.Bots, app.BotDeletions) },
		func() error {
			return mcphttp.RegisterScopedTagTools(entry, tagservice.NewScoped(s.Credentials.Database), mcphttp.TagAuthorizationFromActor)
		},
		func() error { return mcphttp.RegisterScopedThreadTools(entry, s.Threads) },
		func() error { return mcphttp.RegisterScopedTaskReadTools(entry, app.Tasks, s.Observations) },
		func() error { return mcphttp.RegisterScopedTaskWriteTools(entry, app.Tasks, app.TaskObservations) },
		func() error { return mcphttp.RegisterScopedGoalDependencyWriteTools(entry, app.Tasks) },
		func() error {
			return mcphttp.RegisterScopedTaskSearchTool(entry, func(ctx context.Context, a model.CredentialAuthorization, project string, in tasksearch.Request) (tasksearch.Page, error) {
				return tasksearch.SearchScoped(ctx, app.TaskSearch, a, project, in)
			})
		},
		func() error {
			return mcphttp.RegisterSessionTools(entry, func(e *mcphttp.Entry) error {
				return mcphttp.RegisterScopedSessionReadTools(e, app.TaskHistory, app.TaskInspection, sessionservice.NewScopedReadChecker(app.Sessions, s.Session.SessionWrite), s.Session.SessionWrite, s.Session.SessionSnapshot)
			}, mcphttp.ScopedSessionCommandSendModule(app.Sessions, s.Session.SessionWrite, s.Session.SessionSnapshot))
		},
		func() error { return mcphttp.RegisterScopedStepTools(entry, s.Steps) },
		func() error {
			return mcphttp.RegisterScopedAttachmentTools(entry, s.Attachments, mcphttp.AttachmentAuthorizationFromActor)
		},
		func() error { return mcphttp.RegisterScopedDownloadTool(entry, app.Downloads) },
		func() error { return mcphttp.RegisterScopedUploadTools(entry, app.Uploads) },
	); err != nil {
		return err
	}
	return entry.ValidateScopeCoverage()
}
