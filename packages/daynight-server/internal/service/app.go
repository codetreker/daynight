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
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	coresession "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/imageconfig"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	monitoringredis "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcpdownload"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	webresources "github.com/codetreker/daynight/packages/daynight-server/internal/service/webui"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/prometheus/client_golang/prometheus"
)

// App owns the shared modules and their underlying resources.
type App struct {
	*application.Application
	GitHubRead           *coregithub.Reader
	GitHubManager        *githubservice.Manager
	GitHubWebhook        *githubservice.WebhookReceiver
	Metrics              *prometheus.Registry
	Web                  *webresources.Resources
	Ready                func(context.Context) error
	Webhooks             *webhook.Service
	webhookRuntime       *webhookRuntime
	githubRuntime        *githubRuntime
	OAuthProfile         *OAuthProfile
	OAuthError           error
	DirectMembers        *team.DirectMembers
	APIIssuer            *oauthservice.UserAPIIssuer
	ImageValidationError error
	oauthMaintenance     *oauthservice.MaintenanceRunner

	closeLock         chan struct{}
	drainLock         chan struct{}
	drained           bool
	drainErr          error
	usageStarted      bool
	files             interface{ Close() error }
	monitoring        monitoringBackend
	monitoringClosed  chan struct{}
	monitoringErr     error
	persistence       *Persistence
	persistenceClosed chan struct{}
	filesClosed       chan struct{}
	filesErr          error
	closed            bool
	producersStopped  bool
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
		Application:   application.New(database, files, client, c.UniAuth.CallbackURL, c.TaskSync.Overlap, capture...),
		GitHubRead:    coregithub.NewReader(database, c.GitHub.Enabled),
		GitHubManager: githubservice.NewManager(database, nil, 0),
		Web:           webresources.New(), Ready: ready, closeLock: make(chan struct{}, 1), drainLock: make(chan struct{}, 1),
	}
	app.OAuth.SetOrigin(c.Server.PublicOrigin)
	app.closeLock <- struct{}{}
	app.DirectMembers = team.NewDirectMembers(database, app.Identity.EnsureUser, c.Server.PublicOrigin+"/api/v1")
	app.drainLock <- struct{}{}
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
				issuer, issuerErr := oauthservice.NewUserAPIIssuer(database, app.Identity.EnsureUser, c.Server.PublicOrigin)
				if issuerErr != nil {
					app.OAuthError = issuerErr
				} else {
					app.APIIssuer = issuer
					grants := coreoauth.NewGrantLifecycle(database)
					app.OAuthProfile = &OAuthProfile{Admission: admission, Clients: clients, Authorizations: authorizations, Grants: grants,
						Maintenance: oauthservice.NewMaintenance(database, authorizations, grants)}
				}
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

// ErrAppCleanupIncomplete indicates that a failed open could not finish stopping
// its producers. The process must retain resources those producers may still use.
var ErrAppCleanupIncomplete = errors.New("application startup cleanup incomplete")

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
		if err := app.Close(cleanup); err != nil {
			if !app.ProducersStopped() {
				return nil, errors.Join(cause, ErrAppCleanupIncomplete, err)
			}
			return nil, errors.Join(cause, err)
		}
		return nil, cause
	}
	app.CredentialUsage, err = credentialusage.New(database.Transactions, logger, nil)
	if err != nil {
		return failOpen(err)
	}
	app.OAuthGrants.SetRotationObserver(app.CredentialUsage.ObserveRotation)
	if app.OAuthProfile != nil {
		app.OAuthProfile.Grants.SetRotationObserver(app.CredentialUsage.ObserveRotation)
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
	if err := app.assembleGitHub(database.Transactions, c.GitHub, logger); err != nil {
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
		return a.closedResult(nil)
	}
	if err := a.Drain(ctx); err != nil {
		if completed, ok := err.(interface{ Drained() bool }); !ok || !completed.Drained() {
			return err
		}
		if a.closeErr == nil {
			a.closeErr = err
		}
	}
	a.producersStopped = true
	if a.githubRuntime != nil && a.githubRuntime.client != nil {
		a.githubRuntime.client.CloseIdleConnections()
	}
	if err := ctx.Err(); err != nil {
		return errors.Join(a.closeErr, err)
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
			return errors.Join(a.closeErr, ctx.Err())
		}
		if err := ctx.Err(); err != nil {
			return errors.Join(a.closeErr, err)
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
			return errors.Join(a.closeErr, ctx.Err())
		}
		if err := ctx.Err(); err != nil {
			return errors.Join(a.closeErr, err)
		}
	}
	if a.files != nil {
		if a.filesClosed == nil {
			done := make(chan struct{})
			a.filesClosed = done
			go func() {
				a.filesErr = a.files.Close()
				close(done)
			}()
		}
		select {
		case <-a.filesClosed:
			a.closed = true
			a.closeErr = errors.Join(a.closeErr, a.monitoringErr, a.filesErr)
			return a.closedResult(ctx.Err())
		case <-ctx.Done():
			// If closure completed concurrently, retain its result as well as
			// the caller's deadline; the channel synchronizes the error value.
			select {
			case <-a.filesClosed:
				a.closed = true
				a.closeErr = errors.Join(a.closeErr, a.monitoringErr, a.filesErr)
				return a.closedResult(ctx.Err())
			default:
				return errors.Join(a.closeErr, ctx.Err())
			}
		}
	}
	a.closed = true
	a.closeErr = errors.Join(a.closeErr, a.monitoringErr)
	return a.closedResult(ctx.Err())
}

// appCloseError describes the completion of the whole application, independently
// of completion facts on errors returned by an individual dependency.
type appCloseError struct{ cause error }

func (e appCloseError) Error() string { return e.cause.Error() }
func (e appCloseError) Unwrap() error { return e.cause }
func (e appCloseError) Closed() bool  { return true }

func (a *App) closedResult(extra error) error {
	if err := errors.Join(a.closeErr, extra); err != nil {
		return appCloseError{cause: err}
	}
	return nil
}

// ProducersStopped reports whether all application-owned log producers stopped.
func (a *App) ProducersStopped() bool {
	<-a.closeLock
	defer func() { a.closeLock <- struct{}{} }()
	return a.producersStopped
}
