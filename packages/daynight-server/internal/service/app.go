package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	coresession "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/imageconfig"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	monitoringredis "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/prometheus/client_golang/prometheus"
)

// App owns the shared modules and their underlying resources.
type App struct {
	*application.Application
	Metrics              *prometheus.Registry
	Web                  *webresources.Resources
	Ready                func(context.Context) error
	Webhooks             *webhook.Service
	webhookRuntime       *webhookRuntime
	OAuthProfile         *OAuthProfile
	OAuthError           error
	ImageValidationError error
	oauthMaintenance     *oauthservice.MaintenanceRunner

	closeLock         chan struct{}
	files             interface{ Close() error }
	monitoring        monitoringBackend
	monitoringClosed  chan struct{}
	monitoringErr     error
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
func NewIdentityClient(c identityconfig.Config) (*uniauth.Client, error) {
	client, err := uniauth.New(uniauth.Config{BaseURL: c.URL, AppID: c.AppID, AppSecret: c.AppSecret, AllowLoopbackHTTP: c.AllowLoopbackHTTP, HTTPClient: identityHTTPClient()})
	if err != nil {
		return nil, &configvalue.ConfigurationError{Field: "DAYNIGHT_UNIAUTH_URL / DAYNIGHT_UNIAUTH_APP_ID / DAYNIGHT_UNIAUTH_APP_SECRET", Rule: "must identify a valid UniAuth origin and backend App credentials", Cause: err}
	}
	return client, nil
}

// NewModules assembles modules from already-owned dependencies. Their owner must
// stop the engine before closing those dependencies.
func NewModules(c config.Config, database store.Transactions, ready func(context.Context) error, files filestorage.Storage, client *uniauth.Client, capture ...task.Capturer) *App {
	app := &App{
		Application: application.New(database, files, client, c.UniAuth.CallbackURL, c.TaskSync.Overlap, capture...),
		Web:         webresources.New(), Ready: ready, closeLock: make(chan struct{}, 1),
	}
	app.closeLock <- struct{}{}
	decoder, err := configuredImageDecoder(c.ImageDecoder, coresession.NewImageDecoder)
	app.ImageValidationError = err
	if decoder != nil {
		app.Engine.SetImageDecoder(decoder)
	}
	if database != nil && c.Server.PublicOrigin != "" {
		admission := coreoauth.PublicAdmission{Writer: database}
		clients, err := oauthservice.NewClients(database, admission, c.OAuth.PreregisteredClients)
		if err != nil {
			app.OAuthError = err
		} else {
			authorizations, authErr := oauthservice.NewAuthorizations(database, clients, admission, c.Server.PublicOrigin)
			if authErr != nil {
				app.OAuthError = authErr
			} else {
				grants := coreoauth.NewGrantLifecycle(database)
				app.OAuthProfile = &OAuthProfile{Admission: admission, Clients: clients, Authorizations: authorizations, Grants: grants,
					Maintenance: oauthservice.NewMaintenance(database, authorizations, grants)}
			}
		}
	}
	private, ok := files.(filestorage.TransferStorage)
	if ok {
		budget, reserve := c.MCP.Transfer.TempBudgetBytes, c.MCP.Transfer.ReservedFreeBytes
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

func configuredImageDecoder(c imageconfig.Config, factory func(coresession.ImageDecoderConfig) (coresession.ImageDecoder, error)) (coresession.ImageDecoder, error) {
	if c.NodePath == "" && c.HelperPath == "" && c.ManifestPath == "" && c.TemporaryDirectory == "" {
		return nil, nil
	}
	decoder, err := factory(coresession.ImageDecoderConfig{NodePath: c.NodePath, HelperPath: c.HelperPath, ManifestPath: c.ManifestPath, TemporaryDirectory: c.TemporaryDirectory})
	if err != nil {
		return nil, &configvalue.ConfigurationError{Field: "image decoder", Rule: "must identify the complete pinned Node 24 validation build", Cause: err}
	}
	return decoder, nil
}

// OpenApp validates and assembles one set of application dependencies.
func OpenApp(ctx context.Context, c config.Config) (*App, error) {
	return OpenAppWithLogger(ctx, c, slog.Default())
}

// OpenAppWithLogger uses the server's structured logger for owned background work.
func OpenAppWithLogger(ctx context.Context, c config.Config, logger *slog.Logger) (*App, error) {
	return openApp(ctx, c, logger, appOpeners{
		files:      func(root string) (appStorage, error) { return local.New(root) },
		database:   openPostgres,
		monitoring: openMonitoring,
	})
}

type appStorage interface {
	filestorage.Storage
	Close() error
}

type monitoringBackend interface {
	store.MonitoringStore
	Close() error
}

// openMonitoring constructs the monitoring dependency without connecting to Redis.
func openMonitoring(rawURL string) (monitoringBackend, error) {
	backend, err := monitoringredis.New(rawURL)
	if err != nil {
		return nil, err
	}
	return backend, nil
}

type appOpeners struct {
	files      func(string) (appStorage, error)
	database   func(context.Context, string) (persistenceBackend, error)
	monitoring func(string) (monitoringBackend, error)
	metrics    func() (*prometheus.Registry, error)
}

func openApp(ctx context.Context, c config.Config, logger *slog.Logger, open appOpeners) (*App, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	client, err := NewIdentityClient(c.UniAuth)
	if err != nil {
		return nil, err
	}
	startup, cancel := context.WithTimeout(ctx, c.Server.StartupTimeout)
	defer cancel()
	files, err := open.files(c.Storage.Root)
	if err != nil {
		return nil, &configvalue.ConfigurationError{Field: "DAYNIGHT_STORAGE_ROOT", Rule: "must identify a writable storage directory with supported filename semantics", Cause: err}
	}
	database, err := openPersistence(startup, c.Database.URL, open.database)
	if err != nil {
		return nil, errors.Join(err, files.Close())
	}
	if err := validateWebhookStartup(startup, database.Transactions); err != nil {
		database.Close()
		return nil, errors.Join(err, files.Close())
	}
	if logger == nil {
		logger = slog.Default()
	}
	capture := &webhook.Capturer{Logger: logger, RequestID: requestid.From}
	app := NewModules(c, database.Transactions, database.Ready, files, client, capture)
	app.files, app.persistence = files, database
	failOpen := func(cause error) (*App, error) {
		cleanup, done := context.WithTimeout(context.Background(), c.Server.ShutdownTimeout)
		defer done()
		return nil, errors.Join(cause, app.Close(cleanup))
	}
	if c.Monitoring.Redis.RedisURL != "" {
		if open.monitoring == nil {
			return failOpen(errors.New("monitoring store opener is unavailable"))
		}
		monitoring, err := open.monitoring(c.Monitoring.Redis.RedisURL)
		if err != nil {
			return failOpen(&configvalue.ConfigurationError{Field: "DAYNIGHT_REDIS_URL", Rule: "must identify a valid monitoring store", Cause: err})
		}
		app.monitoring = monitoring
		app.Workers.SetMonitoringStore(monitoring)
	}
	if c.Monitoring.Metrics.MetricsListenAddress != "" {
		makeMetrics := open.metrics
		if makeMetrics == nil {
			makeMetrics = newMetricsRegistry
		}
		app.Metrics, err = makeMetrics()
		if err != nil {
			return failOpen(err)
		}
		if app.Metrics == nil {
			return failOpen(errors.New("metrics registry is unavailable"))
		}
		if err := app.Metrics.Register(database.MetricsCollector); err != nil {
			return failOpen(fmt.Errorf("register persistence metrics collector: %w", err))
		}
	}
	if err := app.assembleWebhooks(database.Transactions, c.Webhook.Enabled, logger); err != nil {
		return failOpen(err)
	}
	if app.ImageValidationError != nil {
		return failOpen(app.ImageValidationError)
	}
	if app.PrivateContent == nil {
		return failOpen(errors.New("private transfer storage is unavailable"))
	}
	if logger == nil {
		logger = slog.Default()
	}
	if app.OAuthProfile == nil {
		return failOpen(errors.Join(errors.New("OAuth public profile is unavailable"), app.OAuthError))
	}
	app.oauthMaintenance = oauthservice.StartMaintenance(app.OAuthProfile.Maintenance, func(error) {
		logger.Error("OAuth maintenance failed", "component", "oauth", "operation", "maintain")
	})
	app.PrivateContent.SetLogger(logger)
	if err := app.PrivateContent.Start(func(error) {
		logger.Error("private transfer maintenance failed", "component", "mcptransfer", "operation", "maintain")
	}); err != nil {
		return failOpen(err)
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
	if err := a.Drain(ctx); err != nil {
		return err
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
	if a.monitoring != nil {
		if a.monitoringClosed == nil {
			a.monitoringClosed = make(chan struct{})
			go func() {
				a.monitoringErr = a.monitoring.Close()
				close(a.monitoringClosed)
			}()
		}
		select {
		case <-a.monitoringClosed:
		case <-ctx.Done():
			return ctx.Err()
		}
		if err := ctx.Err(); err != nil {
			return err
		}
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
				a.closeErr = errors.Join(a.monitoringErr, a.files.Close())
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
	a.closeErr = a.monitoringErr
	return errors.Join(a.closeErr, ctx.Err())
}
