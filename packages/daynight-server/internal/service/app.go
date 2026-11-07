package service

import (
	"context"
	"errors"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	"github.com/codetreker/uniauth/sdk/go"
)

// App owns the shared modules and their underlying resources.
type App struct {
	*application.Application
	Web              *webresources.Resources
	Ready            func(context.Context) error
	OAuthProfile     *OAuthProfile
	OAuthError       error
	oauthMaintenance *oauthservice.MaintenanceRunner

	closeLock         chan struct{}
	files             interface{ Close() error }
	persistence       *Persistence
	persistenceClosed chan struct{}
	filesClosed       chan struct{}
	closed            bool
	closeErr          error
}

// OAuthProfile composes the public authorization and credential use cases.
type OAuthProfile struct {
	Admission      coreoauth.PublicAdmission
	Clients        *oauthservice.Clients
	Authorizations *oauthservice.Authorizations
	Grants         *coreoauth.GrantLifecycle
	Maintenance    oauthservice.Maintenance
}

// NewIdentityClient constructs the one application client before opening resources.
func NewIdentityClient(c config.Config) (*uniauth.Client, error) {
	client, err := uniauth.New(uniauth.Config{BaseURL: c.UniAuthURL, AppID: c.UniAuthAppID, AppSecret: c.UniAuthAppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP, HTTPClient: identityHTTPClient()})
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
	if database != nil && c.PublicOrigin != "" {
		admission := coreoauth.PublicAdmission{Writer: database}
		clients, err := oauthservice.NewClients(database, admission, c.OAuthClients)
		if err != nil {
			app.OAuthError = err
		} else {
			authorizations, authErr := oauthservice.NewAuthorizations(database, clients, admission, c.PublicOrigin)
			if authErr != nil {
				app.OAuthError = authErr
			} else {
				grants := coreoauth.NewGrantLifecycle(database)
				app.OAuthProfile = &OAuthProfile{Admission: admission, Clients: clients, Authorizations: authorizations, Grants: grants,
					Maintenance: oauthservice.Maintenance{Clients: database, Authorizations: authorizations, Credentials: grants}}
			}
		}
	}
	private, ok := files.(filestorage.TransferStorage)
	if ok {
		budget, reserve := c.MCPTempBudgetBytes, c.MCPReservedFreeBytes
		if budget == 0 {
			budget, reserve = 8<<30, 1<<30
		}
		app.PrivateContent, _ = mcptransfer.New(database, files, private, budget, reserve)
		if app.PrivateContent != nil {
			app.Downloads = mcpdownload.New(app.Attachments, app.PrivateContent, private)
		}
	}
	// Unavailable test dependencies fail explicitly on upload calls. OpenApp
	// refuses startup unless the complete private storage lifecycle is present.
	app.Uploads = mcptransfer.NewUploads(app.PrivateContent, private, app.Attachments)
	return app
}

// OpenApp validates and assembles one set of application dependencies.
func OpenApp(ctx context.Context, c config.Config) (*App, error) {
	return OpenAppWithLogger(ctx, c, slog.Default())
}

// OpenAppWithLogger uses the server's structured logger for owned background work.
func OpenAppWithLogger(ctx context.Context, c config.Config, logger *slog.Logger) (*App, error) {
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
	if app.PrivateContent == nil {
		return nil, errors.Join(errors.New("private transfer storage is unavailable"), app.Close(context.Background()))
	}
	if logger == nil {
		logger = slog.Default()
	}
	if app.OAuthProfile == nil {
		return nil, errors.Join(errors.New("OAuth public profile is unavailable"), app.OAuthError, app.Close(context.Background()))
	}
	app.oauthMaintenance = oauthservice.StartMaintenance(app.OAuthProfile.Maintenance, func(error) {
		logger.Error("OAuth maintenance failed", "component", "oauth", "operation", "maintain")
	})
	app.PrivateContent.SetLogger(logger)
	if err := app.PrivateContent.Start(func(error) {
		logger.Error("private transfer maintenance failed", "component", "mcptransfer", "operation", "maintain")
	}); err != nil {
		return nil, errors.Join(err, app.Close(context.Background()))
	}
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
	if a.oauthMaintenance != nil {
		if err := a.oauthMaintenance.Stop(ctx); err != nil {
			return err
		}
	}
	if a.PrivateContent != nil {
		if err := a.PrivateContent.Close(ctx); err != nil {
			return err
		}
	}
	if a.WorkerReadOnly != nil {
		a.WorkerReadOnly.Close()
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
