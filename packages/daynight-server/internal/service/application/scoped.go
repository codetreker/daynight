package application

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialpolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"time"
)

// Scoped owns the policy sources and adapters for the complete public surface.
type Scoped struct {
	Credentials            *credentialpolicy.Source
	Session                *session.SessionAuthorizationSource
	PATCatalog, MCPCatalog scopepolicy.CatalogSnapshot
	Attachments            *attachment.ScopedAttachments
	Steps                  *task.ScopedTaskSteps
	Threads                *task.ScopedTaskThreads
	Observations           *task.Observations
}

func NewScoped(database store.Transactions, files filestorage.Storage, client *uniauth.Client, callbackURL string, preview *identity.PreviewSSO, overlap time.Duration, origin string, unavailable []scopepolicy.ScopeID, limits *sessioncore.ArchiveLimits, capture ...task.Capturer) (*Application, error) {
	a := newWithArchiveLimits(database, files, client, callbackURL, preview, overlap, limits, capture...)
	source := &credentialpolicy.Source{Database: database, Origin: origin}
	pat, err := availableCatalog(scopepolicy.PAT, unavailable)
	if err != nil {
		return nil, err
	}
	mcp, err := availableCatalog(scopepolicy.MCP, unavailable)
	if err != nil {
		return nil, err
	}
	a.TaskObservations = task.WithCurrentObservationAuthorization(a.TaskObservations.(*task.Observations), source.Read)
	a.TaskSync = task.WithCurrentSyncAuthorization(a.TaskSync, source.Read)
	a.Scoped = &Scoped{Credentials: source, Session: session.NewSessionAuthorizationSource(origin), PATCatalog: pat, MCPCatalog: mcp, Observations: a.TaskObservations.(*task.Observations)}
	id := identity.NewScopedWithPreviewSSO(database, client, callbackURL, preview, pat)
	a.Identity = id
	a.WorkerReadOnly, err = worker.NewScopedReadOnly(database, a.OAuth.RecheckAPIAccess)
	if err != nil {
		return nil, err
	}
	a.Workers, err = worker.NewScopedWorkersWithPrompts(database, database, source)
	if err != nil {
		return nil, err
	}
	a.Teams, err = team.NewScopedAppTeams(database, source.Current, source.Read)
	if err != nil {
		return nil, err
	}
	a.Bots, err = newScopedBots(database, a.WorkerReadOnly, source)
	if err != nil {
		return nil, err
	}
	a.Bots = a.Bots.WithSessionObserver(a.Engine)
	a.BotDeletions, err = bot.NewScopedDeletions(database, files, a.Engine, source)
	if err != nil {
		return nil, err
	}
	a.Sessions, err = session.NewScopedCommandsAndProducer(database, a.Engine, source, source.SessionWrite)
	if err != nil {
		return nil, err
	}
	a.TaskHistory = session.NewHistory(a.TaskInspection, a.Sessions)
	a.Prompts, err = prompt.NewScoped(database, source.InScope)
	if err != nil {
		return nil, err
	}
	a.Scoped.Attachments = attachment.NewScopedAttachments(a.Attachments, source.Refresh)
	a.Scoped.Steps = task.NewScopedTaskSteps(database, capture...)
	a.Scoped.Threads = task.NewScopedTaskThreads(a.TaskThreads)
	return a, nil
}

func availableCatalog(kind scopepolicy.CredentialType, unavailable []scopepolicy.ScopeID) (scopepolicy.CatalogSnapshot, error) {
	entries, err := scopepolicy.Catalog(kind)
	if err != nil {
		return scopepolicy.CatalogSnapshot{}, err
	}
	excluded := make(map[scopepolicy.ScopeID]bool, len(unavailable))
	for _, id := range unavailable {
		excluded[id] = true
	}
	ids := make([]scopepolicy.ScopeID, 0, len(entries))
	for _, e := range entries {
		if !excluded[e.ID] {
			ids = append(ids, e.ID)
		}
	}
	return scopepolicy.NewCatalogSnapshot(kind, ids)
}

func newScopedBots(database store.Transactions, broker *workerreadonly.Broker, source *credentialpolicy.Source) (*bot.Bots, error) {
	creationDiscovery, err := worker.NewScopedReadOnlyRequester(database, broker, source.Current)
	if err != nil {
		return nil, err
	}
	return bot.NewScopedWithNativeDiscovery(database, broker, creationDiscovery, source)
}
