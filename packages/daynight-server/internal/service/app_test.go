package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	databaseconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/config"
	serverconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/config"
	applicationconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/application/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"
	oauthconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth/config"
	configvalue "github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type compositionOnlyStore struct{ store.Transactions }

func TestOAuthProfileComposition(t *testing.T) {
	c := config.Config{Server: serverconfig.Config{PublicOrigin: "https://daynight.example"}, OAuth: oauthconfig.Config{PreregisteredClients: map[string][]byte{
		"known": []byte(`{"client_id":"known","redirect_uris":["https://client.example/callback"]}`),
	}}}
	app := NewModules(c, compositionOnlyStore{}, nil, nil, nil)
	if app.OAuthError != nil || app.OAuthProfile == nil {
		t.Fatalf("valid OAuth profile: %v", app.OAuthError)
	}
	client, err := app.OAuthProfile.Clients.Resolve(context.Background(), "known", "https://client.example/callback")
	if err != nil || client.Provenance != "preregistered" {
		t.Fatalf("configured client unavailable: %v", err)
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []config.Config{
		{Server: serverconfig.Config{PublicOrigin: "https://daynight.example"}, OAuth: oauthconfig.Config{PreregisteredClients: map[string][]byte{"bad": []byte(`{}`)}}},
		{Server: serverconfig.Config{PublicOrigin: "https://daynight.example/path"}},
	} {
		app := NewModules(invalid, compositionOnlyStore{}, nil, nil, nil)
		if app.OAuthProfile != nil || app.OAuthError == nil {
			t.Fatal("invalid OAuth configuration produced a public profile")
		}
		if err := app.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestUploadUnavailableWithoutPrivateStorage(t *testing.T) {
	app := NewModules(config.Config{}, nil, nil, nil, nil)
	if app.PrivateContent != nil || app.Uploads == nil {
		t.Fatal("unexpected private content composition")
	}
	_, err := app.Uploads.Execute(context.Background(), transfer.Actor{}, "", "", mcptransfer.UploadInput{Action: "inline"})
	if err == nil || !strings.Contains(err.Error(), "upload service unavailable") {
		t.Fatalf("upload without private storage: %v", err)
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func appTestConfig(t *testing.T) config.Config {
	t.Helper()
	base := filepath.Join("..", "..", ".tmp")
	if err := os.MkdirAll(base, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "app-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return config.Config{
		Database: databaseconfig.Config{URL: "postgres://app:app@database.invalid/app?sslmode=disable"},
		Storage:  storageconfig.Config{Root: filepath.Join(root, "storage")},
		Server:   serverconfig.Config{ListenAddress: "127.0.0.1:0", StartupTimeout: 10 * time.Second, ShutdownTimeout: time.Second, PublicOrigin: "https://daynight.example"},
		TaskSync: applicationconfig.TaskSyncConfig{Overlap: 10 * time.Second},
		UniAuth:  identityconfig.Config{URL: "https://auth.example", AppID: "app", AppSecret: "secret", CallbackURL: "https://daynight.example/api/v1/auth/callback"},
	}
}

func TestOpenAppRejectsInvalidConfigurationBeforeOpeningResources(t *testing.T) {
	t.Run("credentials", func(t *testing.T) {
		c := appTestConfig(t)
		c.Database.URL = "invalid-database-configuration"
		c.UniAuth.AppID, c.UniAuth.AppSecret = "private:invalid-app-id", "credential-not-for-diagnostics"
		app, err := OpenApp(context.Background(), c)
		var failure *configvalue.ConfigurationError
		if app != nil || !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
			t.Fatalf("invalid credentials reached composition or lost diagnosis: %v", err)
		}
		cause := errors.Unwrap(failure)
		if cause == nil || !strings.Contains(cause.Error(), "App ID") {
			t.Fatalf("SDK credential validation cause was lost: %v", err)
		}
		for _, message := range []string{err.Error(), cause.Error()} {
			if strings.Contains(message, c.UniAuth.AppID) || strings.Contains(message, c.UniAuth.AppSecret) {
				t.Fatal("configuration diagnostics exposed credential values")
			}
		}
		if _, err := os.Stat(c.Storage.Root); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("invalid credentials touched storage: %v", err)
		}
	})
	for _, path := range []string{
		"/mcp", "/mcp/callback", "/oauth", "/oauth/consent", "/.well-known/oauth-authorization-server", "/api/v1/oauth/requests",
		"/api/v1/webhook-event-types", "/api/v1/webhook-event-types/callback", "/api/v1/me/webhooks", "/api/v1/teams/x/webhooks",
		"/setup", "/setup/callback", "/setup/nested/callback", "/login", "/login/callback", "/login/nested/callback",
		"/projects", "/projects/callback", "/teams", "/teams/callback", "/shared-projects", "/shared-projects/callback",
		"/workers", "/workers/callback", "/workers/nested/callback", "/bots", "/bots/callback", "/bots/nested/callback",
	} {
		t.Run(path, func(t *testing.T) {
			c := appTestConfig(t)
			c.Database.URL = "invalid-database-configuration"
			c.UniAuth.CallbackURL = c.Server.PublicOrigin + path
			app, err := OpenApp(context.Background(), c)
			var failure *configvalue.ConfigurationError
			if app != nil || !errors.As(err, &failure) || failure.Field != "DAYNIGHT_UNIAUTH_CALLBACK_URL" || failure.Rule != "must not overlap an application API, page, asset, or health route" {
				t.Fatalf("conflicting callback reached composition or lost diagnosis: %v", err)
			}
			if _, err := os.Stat(c.Storage.Root); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("conflicting callback touched storage: %v", err)
			}
		})
	}
}

func TestAppCloseRetainsResourcesUntilOperationFinishes(t *testing.T) {
	c := appTestConfig(t)
	app, _, err := openTestApp(t, context.Background(), c, nil)
	if err != nil {
		t.Fatal(err)
	}
	op, err := app.Engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		op.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	deadline, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := app.Close(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close did not wait for operation: %v", err)
	}
	if next, err := app.Engine.BeginOperation(); err == nil {
		next.Close()
		t.Fatal("closing engine admitted a new operation")
	}
	ctx, cancelCheck := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelCheck()
	if err := app.Ready(ctx); err != nil {
		t.Fatalf("database closed while operation was active: %v", err)
	}
	files := app.files.(filestorage.Storage)
	if _, err := files.Put(ctx, "app", "active.txt", strings.NewReader("active")); err != nil {
		t.Fatalf("files closed while operation was active: %v", err)
	}
	op.Close()
	if err := app.Close(ctx); err != nil {
		t.Fatalf("close retry: %v", err)
	}
	if err := app.Ready(ctx); err == nil {
		t.Fatal("database remained open after operation finished")
	}
	if object, err := files.Open(ctx, "app", "active.txt"); err == nil {
		object.Body.Close()
		t.Fatal("files remained open after operation finished")
	}
	if err := app.Close(ctx); err != nil {
		t.Fatalf("repeated close: %v", err)
	}
}

func TestOpenAppValidatesBeforeOpeningStorage(t *testing.T) {
	c := appTestConfig(t)
	c.UniAuth.AppID = "invalid:app"
	app, err := OpenApp(context.Background(), c)
	var failure *configvalue.ConfigurationError
	if app != nil || !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
		t.Fatalf("invalid credentials not rejected: app=%v, error=%v", app, err)
	}
	if _, err := os.Stat(c.Storage.Root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid credentials touched storage: %v", err)
	}
}

func TestOpenAppClosesStorageWhenDatabaseOpenFails(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("storage descriptor inspection requires procfs")
	}
	c := appTestConfig(t)
	if err := os.MkdirAll(c.Storage.Root, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs(c.Storage.Root)
	if err != nil {
		t.Fatal(err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	countOpenRoots := func() int {
		entries, err := os.ReadDir("/proc/self/fd")
		if err != nil {
			t.Skipf("procfs unavailable: %v", err)
		}
		count := 0
		for _, entry := range entries {
			target, err := os.Readlink(filepath.Join("/proc/self/fd", entry.Name()))
			if err == nil && target == root {
				count++
			}
		}
		return count
	}
	before := countOpenRoots()
	c.Database.URL = "postgres://user:secret@bad%host/database"
	app, err := OpenApp(context.Background(), c)
	if app != nil || err == nil {
		t.Fatalf("invalid database accepted: app=%v, error=%v", app, err)
	}
	if after := countOpenRoots(); after != before {
		t.Fatalf("database startup failure leaked storage root: before=%d after=%d", before, after)
	}
}

func TestConcurrentCloseHonorsCallerDeadline(t *testing.T) {
	app, _, err := openTestApp(t, context.Background(), appTestConfig(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	op, err := app.Engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	first := make(chan error, 1)
	go func() { first <- app.Close(context.Background()) }()
	select {
	case <-op.Stopping():
	case <-time.After(5 * time.Second):
		t.Fatal("first close did not stop admission")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := app.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("concurrent close did not honor its deadline: %v", err)
	}
	op.Close()
	select {
	case err := <-first:
		if err != nil {
			t.Fatalf("first close: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first close did not finish")
	}
}

func TestIdentityClientPreservesSafeSDKFailure(t *testing.T) {
	c := appTestConfig(t)
	c.UniAuth.AppID = "invalid:private-id"
	c.UniAuth.AppSecret = "private-secret"
	client, err := NewIdentityClient(c.UniAuth)
	var failure *configvalue.ConfigurationError
	if client != nil || !errors.As(err, &failure) || errors.Unwrap(failure) == nil {
		t.Fatalf("SDK failure lost configuration context or cause: %v", err)
	}
	if strings.Contains(err.Error(), c.UniAuth.AppID) || strings.Contains(err.Error(), c.UniAuth.AppSecret) || strings.Contains(errors.Unwrap(failure).Error(), c.UniAuth.AppSecret) {
		t.Fatal("SDK failure exposed credentials")
	}
}

type observedAppFiles struct {
	persistenceDone         <-chan struct{}
	closes                  atomic.Int32
	closedBeforePersistence atomic.Bool
}

func (f *observedAppFiles) Close() error {
	select {
	case <-f.persistenceDone:
	default:
		f.closedBeforePersistence.Store(true)
	}
	f.closes.Add(1)
	return nil
}

func TestAppCloseWaitsForPersistenceAndReusesTimedOutClose(t *testing.T) {
	app := NewModules(config.Config{}, nil, nil, nil, nil)
	started, release, completed := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseClose := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseClose)
	var calls atomic.Int32
	app.persistence = &Persistence{Close: func() { calls.Add(1); close(started); <-release; close(completed) }}
	files := &observedAppFiles{persistenceDone: completed}
	app.files = files
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := app.Close(canceled); !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("expired caller started closing resources: %v", err)
	}
	first := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer cancel()
		first <- app.Close(ctx)
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("persistence close did not start")
	}
	ctx, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := app.Close(ctx)
	stop()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("concurrent waiter did not time out: %v", err)
	}
	select {
	case err = <-first:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked persistence did not time out: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("first close ignored its deadline")
	}
	if calls.Load() != 1 || files.closes.Load() != 0 {
		t.Fatal("resources closed before persistence completed")
	}
	ctx, stop = context.WithTimeout(context.Background(), 20*time.Millisecond)
	err = app.Close(ctx)
	stop()
	if !errors.Is(err, context.DeadlineExceeded) || calls.Load() != 1 || files.closes.Load() != 0 {
		t.Fatalf("retry duplicated close or released files: %v", err)
	}
	releaseClose()
	select {
	case <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("persistence did not finish")
	}
	if err := app.Close(canceled); !errors.Is(err, context.Canceled) || files.closes.Load() != 0 {
		t.Fatalf("canceled caller released files: %v", err)
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatalf("close retry: %v", err)
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatalf("repeated close: %v", err)
	}
	if calls.Load() != 1 || files.closes.Load() != 1 || files.closedBeforePersistence.Load() {
		t.Fatal("resources closed out of order or more than once")
	}
	if err := app.Close(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("completed app hid canceled caller: %v", err)
	}
}

type blockingAppFiles struct {
	started, release chan struct{}
	calls            atomic.Int32
	err              error
}

func (f *blockingAppFiles) Close() error {
	f.calls.Add(1)
	close(f.started)
	<-f.release
	return f.err
}

func TestAppCloseWaitsForFileCloseAndRetainsFailure(t *testing.T) {
	app := NewModules(config.Config{}, nil, nil, nil, nil)
	var persistenceCalls atomic.Int32
	app.persistence = &Persistence{Close: func() { persistenceCalls.Add(1) }}
	failure := errors.New("file close failed")
	files := &blockingAppFiles{started: make(chan struct{}), release: make(chan struct{}), err: failure}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(files.release) }) }
	t.Cleanup(release)
	app.files = files
	first := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 70*time.Millisecond)
		defer cancel()
		first <- app.Close(ctx)
	}()
	select {
	case <-files.started:
	case <-time.After(5 * time.Second):
		t.Fatal("file close did not start")
	}
	select {
	case err := <-first:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("blocked file close did not time out: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("file close ignored caller deadline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := app.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || files.calls.Load() != 1 || persistenceCalls.Load() != 1 {
		t.Fatalf("retry duplicated pending close: %v", err)
	}
	release()
	if err := app.Close(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("file failure lost on retry: %v", err)
	}
	if err := app.Close(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("file failure lost on repeated close: %v", err)
	}
	if files.calls.Load() != 1 || persistenceCalls.Load() != 1 {
		t.Fatal("resources closed more than once")
	}
}

func TestOpenAppReportsUnusableStorageRoot(t *testing.T) {
	c := appTestConfig(t)
	if err := os.WriteFile(c.Storage.Root, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	app, err := OpenAppWithLogger(context.Background(), c, nil)
	var failure *configvalue.ConfigurationError
	if app != nil || !errors.As(err, &failure) || failure.Field != "DAYNIGHT_STORAGE_ROOT" || errors.Unwrap(failure) == nil {
		t.Fatalf("unusable storage root was not reported with its cause: app=%v, error=%v", app, err)
	}
	contents, readErr := os.ReadFile(c.Storage.Root)
	if readErr != nil || string(contents) != "not a directory" {
		t.Fatalf("startup changed the existing storage root: contents=%q, error=%v", contents, readErr)
	}
}

func TestOpenAppReportsDatabaseStartupFailure(t *testing.T) {
	c := appTestConfig(t)
	c.Database.URL = "postgres://user:secret@bad%host/database"
	app, err := OpenAppWithLogger(context.Background(), c, nil)
	if app != nil || err == nil {
		t.Fatalf("invalid database was accepted: app=%v, error=%v", app, err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("database startup error exposed credentials: %v", err)
	}
}

func TestOpenPersistenceRejectsInvalidDatabaseURL(t *testing.T) {
	persistence, err := OpenPersistence(context.Background(), "postgres://user:secret@bad%host/database")
	if persistence != nil || err == nil {
		t.Fatalf("invalid database was accepted: persistence=%v, error=%v", persistence, err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("database startup error exposed credentials: %v", err)
	}
}
