package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/codetreker/uniauth/sdk/go"
)

// App owns the shared modules and their underlying resources.
type App struct {
	Identity    *identityservice.Identity
	Memberships *projectservice.Memberships
	Projects    *projectservice.Projects
	Teams       *teamservice.Teams
	Workers     *workerservice.Workers
	Tasks       *taskservice.Tasks
	TaskSearch  store.TaskSearchReader
	TaskSteps   *taskservice.TaskSteps
	TaskThreads *taskservice.TaskThreads
	TaskSync    *taskservice.TaskSync
	Attachments *attachmentservice.Attachments
	Sessions    *sessionservice.Service
	Bots        *botservice.Bots
	Deletions   *botservice.Deletions
	Web         *webresources.Resources
	Engine      *sessioncore.Engine
	Ready       func(context.Context) error

	closeLock   chan struct{}
	files       interface{ Close() error }
	persistence *Persistence
	closed      bool
	closeErr    error
}

// NewIdentityClient constructs the one application client before opening resources.
func NewIdentityClient(c config.Config) (*uniauth.Client, error) {
	client, err := uniauth.New(uniauth.Config{BaseURL: c.UniAuthURL, AppID: c.UniAuthAppID, AppSecret: c.UniAuthAppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP})
	if err != nil {
		return nil, &config.ConfigurationError{Field: "DAYNIGHT_UNIAUTH_URL / DAYNIGHT_UNIAUTH_APP_ID / DAYNIGHT_UNIAUTH_APP_SECRET", Rule: "must identify a valid UniAuth origin and backend App credentials", Cause: err}
	}
	return client, nil
}

// NewModules assembles modules from already-owned dependencies. Their owner must
// stop the engine before closing those dependencies.
func NewModules(c config.Config, database store.Transactions, ready func(context.Context) error, files filestorage.Storage, client *uniauth.Client) *App {
	engine := sessioncore.NewEngine(files)
	app := &App{
		closeLock:   make(chan struct{}, 1),
		Identity:    identityservice.New(database, client, c.UniAuthCallbackURL),
		Memberships: projectservice.NewMemberships(database), Projects: projectservice.NewProjects(database),
		Teams: teamservice.NewTeams(database), Workers: workerservice.NewWorkers(database),
		Tasks: taskservice.NewTasks(database), TaskSearch: database, TaskSteps: taskservice.NewTaskSteps(database),
		TaskThreads: taskservice.NewTaskThreads(database), TaskSync: taskservice.NewTaskSync(database, c.TaskSyncOverlap),
		Attachments: attachmentservice.NewAttachments(database, database, files),
		Sessions:    sessionservice.New(database, engine), Bots: botservice.New(database),
		Deletions: botservice.NewDeletions(database, files, engine), Web: webresources.New(), Engine: engine, Ready: ready,
	}
	app.closeLock <- struct{}{}
	return app
}

// OpenApp validates and assembles one set of application dependencies.
func OpenApp(ctx context.Context, c config.Config) (*App, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := NewIdentityClient(c)
	if err != nil {
		return nil, err
	}
	startup, cancel := context.WithTimeout(ctx, c.StartupTimeout)
	defer cancel()
	files, err := local.New(c.StorageRoot)
	if err != nil {
		return nil, &config.ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "must identify a writable storage directory with supported filename semantics", Cause: err}
	}
	database, err := OpenPersistence(startup, c.DatabaseURL)
	if err != nil {
		return nil, errors.Join(err, files.Close())
	}
	app := NewModules(c, database.Transactions, database.Ready, files, client)
	app.files, app.persistence = files, database
	return app, nil
}

// Close retains resources if operations have not stopped. It may be retried.
func (a *App) Close(ctx context.Context) error {
	select {
	case <-a.closeLock:
		defer func() { a.closeLock <- struct{}{} }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if a.closed {
		return a.closeErr
	}
	if err := a.Engine.Stop(ctx); err != nil {
		return err
	}
	if a.persistence != nil {
		a.persistence.Close()
	}
	if a.files != nil {
		a.closeErr = a.files.Close()
	}
	a.closed = true
	return a.closeErr
}
