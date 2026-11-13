// Package application composes the business services shared by protocol adapters.
package application

import (
	"context"
	"net/url"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	oauthcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	taskwork "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// IdentityOperations is the identity output consumed by protocol adapters.
type IdentityOperations interface {
	CallbackURL() string
	ValidateLogin(string, string) error
	StartLogin(context.Context, string, string, string) (identitycore.LoginStart, error)
	CompleteLogin(context.Context, url.Values, string) (identitycore.LoginCompletion, error)
	Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error)
	User(context.Context, model.Principal) (model.User, error)
	PatchUser(context.Context, model.Principal, model.UserProfilePatch) (model.User, error)
	EnsureUser(context.Context, model.User) (model.User, error)
	Logout(context.Context, model.Principal) error
	CreatePAT(context.Context, model.Principal, identitycore.CreatePAT) (identitycore.MintedPAT, error)
	ListPATs(context.Context, model.Principal) ([]model.PersonalAccessToken, error)
	RevokePAT(context.Context, model.Principal, string) error
	UpdatePATExpiry(context.Context, model.Principal, string, identitycore.UpdatePATExpiry) (model.PersonalAccessToken, error)
	Providers(context.Context) ([]string, error)
	StartDevice(context.Context, string, string) (identitycore.DeviceStart, error)
	InspectDevice(context.Context, model.Principal, string) (identitycore.DeviceInspection, error)
	DecideDevice(context.Context, model.Principal, string, string, string) error
	RedeemDevice(context.Context, string, string, string, string) (identitycore.MintedPAT, error)
	LogoutDevice(context.Context, model.Principal) error
	PersonalTeamID(context.Context, model.Principal) (string, error)
}

// TaskObservationOperations is the observation output consumed by protocol adapters.
type TaskObservationOperations interface {
	ObserveGet(context.Context, model.Principal, string, string) (task.ObservedTask, error)
	ObserveList(context.Context, model.Principal, string, task.TaskListRequest) (task.ObservedTaskPage, error)
	ObserveGraph(context.Context, model.Principal, string, string) (task.ObservedGraph, error)
	ObservedMCPList(context.Context, model.Principal, string, taskcore.MCPListRequest) (task.ObservedMCPPage, error)
	WorkList(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)
}

// TaskStepsOperations is the task step output consumed by protocol adapters.
type TaskStepsOperations interface {
	ListPage(context.Context, model.Principal, string, string, int64, int, *int64, bool) (task.StepsPage, error)
	GetSummary(context.Context, model.Principal, string, string, string) (task.StepSummary, error)
	List(context.Context, model.Principal, string, string) (task.StepsDocument, error)
	Get(context.Context, model.Principal, string, string, string) (task.StepDocument, error)
	Add(context.Context, model.Principal, string, string, task.AddTaskStep) (task.StepsWriteResult, error)
	Update(context.Context, model.Principal, string, string, string, task.UpdateTaskStep) (task.StepsWriteResult, error)
	SetStatus(context.Context, model.Principal, string, string, string, task.SetTaskStepStatus) (task.StepsWriteResult, error)
	Move(context.Context, model.Principal, string, string, string, task.MoveTaskStep) (task.StepsWriteResult, error)
	Delete(context.Context, model.Principal, string, string, string, task.DeleteTaskStep) (task.StepsWriteResult, error)
}

// Application owns one set of use cases and the session engine shared by adapters.
// Store and files are borrowed and are closed by the outer runtime.
type Application struct {
	CredentialUsage  *credentialusage.Recorder
	Identity         IdentityOperations
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
	Tags             *tag.Tags
	Tasks            *task.Tasks
	TaskObservations TaskObservationOperations
	TaskInspection   *session.Inspection
	TaskHistory      *session.History
	TaskSearch       store.TaskSearchReader
	TaskSteps        TaskStepsOperations
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
	oauthAuthenticator := oauth.NewAuthenticator(database)
	workerReadOnly := worker.NewReadOnly(database, oauthAuthenticator.RecheckAPIAccess)
	sessions := session.New(database, engine)
	inspection := session.NewInspection(database, engine)
	return &Application{
		Identity:         construct.identity(database, client, callbackURL),
		OAuth:            oauthAuthenticator,
		OAuthGrants:      oauthcore.NewGrantLifecycle(database),
		Memberships:      project.NewMemberships(database),
		Projects:         construct.projects(database, engine),
		Teams:            team.NewTeams(database),
		Workers:          worker.NewWorkersWithPrompts(database, database),
		Prompts:          prompt.New(database),
		WorkerReadOnly:   workerReadOnly,
		Bots:             bot.NewWithNativeDiscovery(database, workerReadOnly),
		BotDeletions:     bot.NewDeletions(database, files, engine),
		Tags:             tag.New(database),
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
