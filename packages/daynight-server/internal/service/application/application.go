// Package application composes the business services shared by protocol adapters.
package application

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// Application owns one set of use cases and the session engine shared by adapters.
// Store and files are borrowed and are closed by the outer runtime.
type Application struct {
	Identity     *identity.Identity
	Memberships  *project.Memberships
	Projects     *project.Projects
	Teams        *team.Teams
	Workers      *worker.Workers
	Bots         *bot.Bots
	BotDeletions *bot.Deletions
	Tasks        *task.Tasks
	TaskSearch   store.TaskSearchReader
	TaskSteps    *task.TaskSteps
	TaskThreads  *task.TaskThreads
	TaskSync     *task.TaskSync
	Attachments  *attachment.Attachments
	Engine       *sessioncore.Engine
	Sessions     *session.Service
}

func New(database store.Transactions, files filestorage.Storage, client *uniauth.Client, callbackURL string, overlap time.Duration) *Application {
	engine := sessioncore.NewEngine(files)
	return &Application{
		Identity:     identity.New(database, client, callbackURL),
		Memberships:  project.NewMemberships(database),
		Projects:     project.NewProjects(database),
		Teams:        team.NewTeams(database),
		Workers:      worker.NewWorkers(database),
		Bots:         bot.New(database),
		BotDeletions: bot.NewDeletions(database, files, engine),
		Tasks:        task.NewTasks(database),
		TaskSearch:   database,
		TaskSteps:    task.NewTaskSteps(database),
		TaskThreads:  task.NewTaskThreads(database),
		TaskSync:     task.NewTaskSync(database, overlap),
		Attachments:  attachment.NewAttachments(database, database, files),
		Engine:       engine,
		Sessions:     session.New(database, engine),
	}
}
