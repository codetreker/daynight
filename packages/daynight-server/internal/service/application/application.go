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
	Identity         IdentityOperations
	OAuth            OAuthOperations
	OAuthGrants      *oauthcore.GrantLifecycle
	Memberships      MembershipOperations
	Projects         ProjectOperations
	Teams            TeamOperations
	Workers          *worker.Workers
	Prompts          *prompt.Prompts
	WorkerReadOnly   *workerreadonly.Broker
	Bots             BotOperations
	BotDeletions     BotDeletionOperations
	Tasks            TaskOperations
	TaskObservations TaskObservationOperations
	TaskInspection   *session.Inspection
	TaskHistory      *session.History
	TaskSearch       store.TaskSearchReader
	TaskSteps        TaskStepsOperations
	TaskThreads      TaskThreadOperations
	TaskSync         *task.TaskSync
	Attachments      AttachmentOperations
	PrivateContent   *mcptransfer.Lifecycle
	Downloads        DownloadOperations
	Uploads          UploadOperations
	Engine           *sessioncore.Engine
	Sessions         *session.Service
}

type constructors struct {
	identity         func(store.IdentityWriter, *uniauth.Client, string) *identity.Identity
	taskObservations func(store.SnapshotReader, task.SessionObserver) *task.Observations
	projects         func(store.Transactions, *sessioncore.Engine) *project.Projects
	tasks            func(store.Transactions, task.Capturer) *task.Tasks
	taskSteps        func(task.StepsStore, ...task.Capturer) *task.TaskSteps
	attachments      func(store.SnapshotReader, store.AttachmentMutationWriter, filestorage.Storage) *attachment.Attachments
}

func New(database store.Transactions, files filestorage.Storage, client *uniauth.Client, callbackURL string, overlap time.Duration, capture ...task.Capturer) *Application {
	return assemble(database, files, client, callbackURL, overlap, constructors{
		identity:         identity.New,
		taskObservations: task.NewObservations,
		projects: func(database store.Transactions, engine *sessioncore.Engine) *project.Projects {
			return project.NewProjects(database, engine)
		},
		tasks: func(database store.Transactions, capturer task.Capturer) *task.Tasks {
			return task.NewTasks(database, capturer)
		},
		taskSteps:   task.NewTaskSteps,
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
	sessions := session.New(database, engine)
	inspection := session.NewInspection(database, engine)
	return &Application{
		Identity:         construct.identity(database, client, callbackURL),
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
		TaskObservations: construct.taskObservations(database, engine),
		TaskInspection:   inspection,
		TaskHistory:      session.NewHistory(inspection, sessions),
		TaskSearch:       database,
		TaskSteps:        construct.taskSteps(database, capturer),
		TaskThreads:      task.NewTaskThreads(database, capturer),
		TaskSync:         task.NewTaskSync(database, engine, overlap),
		Attachments:      construct.attachments(database, database, files),
		Engine:           engine,
		Sessions:         sessions,
	}
}
