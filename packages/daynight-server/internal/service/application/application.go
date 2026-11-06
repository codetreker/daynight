// Package application composes the business services shared by protocol adapters.
package application

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

// Application owns one set of use cases and the relay shared by all adapters.
// Store and files are borrowed and are closed by the outer runtime.
type Application struct {
	Identity    *identity.Identity
	Memberships *project.Memberships
	Projects    *project.Projects
	Teams       *team.Teams
	Workers     *service.Workers
	Bots        *service.Bots
	Tasks       *task.Tasks
	TaskSteps   *task.TaskSteps
	TaskThreads *task.TaskThreads
	TaskSync    *task.TaskSync
	Attachments *service.Attachments
	Relay       *sessionrelay.Service
}

func New(database *store.Store, files filestorage.Storage, client *uniauth.Client, callbackURL string, overlap time.Duration) *Application {
	return &Application{
		Identity:    identity.New(database, client, callbackURL),
		Memberships: project.NewMemberships(database),
		Projects:    project.NewProjects(database),
		Teams:       team.NewTeams(database),
		Workers:     service.NewWorkers(database),
		Bots:        service.NewBots(database),
		Tasks:       task.NewTasks(database),
		TaskSteps:   task.NewTaskSteps(database),
		TaskThreads: task.NewTaskThreads(database),
		TaskSync:    task.NewTaskSync(database, overlap),
		Attachments: service.NewAttachments(database, files),
		Relay:       sessionrelay.New(database, files),
	}
}
