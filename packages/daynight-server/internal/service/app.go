package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	"github.com/codetreker/uniauth/sdk/go"
)

// App owns the shared modules and their underlying resources.
type App struct {
	*application.Application
	Web   *webresources.Resources
	Ready func(context.Context) error

	closeLock         chan struct{}
	files             interface{ Close() error }
	persistence       *Persistence
	persistenceClosed chan struct{}
	filesClosed       chan struct{}
	closed            bool
	closeErr          error
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
	app := &App{
		Application: application.New(database, files, client, c.UniAuthCallbackURL, c.TaskSyncOverlap),
		Web:         webresources.New(), Ready: ready, closeLock: make(chan struct{}, 1),
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
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-a.closeLock:
		defer func() { a.closeLock <- struct{}{} }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.closed {
		return a.closeErr
	}
	if err := a.Engine.Stop(ctx); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if a.persistence != nil {
		if a.persistenceClosed == nil {
			a.persistenceClosed = make(chan struct{})
			go func() {
				a.persistence.Close()
				close(a.persistenceClosed)
			}()
		}
		select {
		case <-a.persistenceClosed:
		case <-ctx.Done():
			return ctx.Err()
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	if a.files != nil {
		if a.filesClosed == nil {
			done := make(chan struct{})
			a.filesClosed = done
			go func() {
				a.closeErr = a.files.Close()
				close(done)
			}()
		}
		select {
		case <-a.filesClosed:
			a.closed = true
			return errors.Join(a.closeErr, ctx.Err())
		case <-ctx.Done():
			// If closure completed concurrently, retain its result as well as
			// the caller's deadline; the channel synchronizes the error value.
			select {
			case <-a.filesClosed:
				a.closed = true
				return errors.Join(a.closeErr, ctx.Err())
			default:
				return ctx.Err()
			}
		}
	}
	a.closed = true
	return ctx.Err()
}
