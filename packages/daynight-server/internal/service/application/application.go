// Package application composes the business services shared by protocol adapters.
package application

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	oauthcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// Application owns one set of use cases and the session engine shared by adapters.
// Store and files are borrowed and are closed by the outer runtime.
type Application struct {
	Identity         *identity.Identity
	OAuth            *oauth.Authenticator
	OAuthGrants      *oauthcore.GrantLifecycle
	Memberships      *project.Memberships
	Projects         *project.Projects
	Teams            *team.Teams
	Workers          *worker.Workers
	Prompts          *prompt.Prompts
	WorkerReadOnly   *workerreadonly.Broker
	Bots             *bot.Bots
	BotDeletions     *bot.Deletions
	Tasks            *task.Tasks
	TaskObservations *task.Observations
	TaskInspection   *session.Inspection
	TaskSearch       store.TaskSearchReader
	TaskSteps        *task.TaskSteps
	TaskThreads      *task.TaskThreads
	TaskSync         *task.TaskSync
	Attachments      *attachment.Attachments
	PrivateContent   *mcptransfer.Lifecycle
	Downloads        *mcpdownload.Service
	Uploads          *mcptransfer.Uploads
	Engine           *sessioncore.Engine
	Sessions         *session.Service
}

type constructors struct {
	projects    func(store.Transactions, *sessioncore.Engine) *project.Projects
	tasks       func(store.Transactions, task.Capturer) *task.Tasks
	attachments func(store.SnapshotReader, store.AttachmentMutationWriter, filestorage.Storage) *attachment.Attachments
}

func New(database store.Transactions, files filestorage.Storage, client *uniauth.Client, callbackURL string, overlap time.Duration, capture ...task.Capturer) *Application {
	return assemble(database, files, client, callbackURL, overlap, constructors{
		projects: func(database store.Transactions, engine *sessioncore.Engine) *project.Projects {
			return project.NewProjects(database, engine)
		},
		tasks: func(database store.Transactions, capturer task.Capturer) *task.Tasks {
			return task.NewTasks(database, capturer)
		},
		attachments: attachment.NewAttachments,
	}, capture...)
}

func assemble(database store.Transactions, files filestorage.Storage, client *uniauth.Client, callbackURL string, overlap time.Duration, construct constructors, capture ...task.Capturer) *Application {
	var capturer task.Capturer = &webhook.Capturer{}
	if len(capture) != 0 && capture[0] != nil {
		capturer = capture[0]
	}
	engine := sessioncore.NewEngine(files)
	workerReadOnly := worker.NewReadOnly(database)
	return &Application{
		Identity:         identity.New(database, client, callbackURL),
		OAuth:            oauth.NewAuthenticator(database),
		OAuthGrants:      oauthcore.NewGrantLifecycle(database),
		Memberships:      project.NewMemberships(database),
		Projects:         construct.projects(database, engine),
		Teams:            team.NewTeams(database),
		Workers:          worker.NewWorkersWithPrompts(database, database),
		Prompts:          prompt.New(database),
		WorkerReadOnly:   workerReadOnly,
		Bots:             bot.NewWithNativeDiscovery(database, workerReadOnly),
		BotDeletions:     bot.NewDeletions(database, files, engine),
		Tasks:            construct.tasks(database, capturer),
		TaskObservations: task.NewObservations(database, engine),
		TaskInspection:   session.NewInspection(database, engine),
		TaskSearch:       database,
		TaskSteps:        task.NewTaskSteps(database, capturer),
		TaskThreads:      task.NewTaskThreads(database, capturer),
		TaskSync:         task.NewTaskSync(database, engine, overlap),
		Attachments:      construct.attachments(database, database, files),
		Engine:           engine,
		Sessions:         session.New(database, engine),
	}
}
