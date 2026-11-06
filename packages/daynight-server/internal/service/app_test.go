package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

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
		DatabaseURL: serviceDatabaseURL(t), StorageRoot: filepath.Join(root, "storage"),
		ListenAddress: "127.0.0.1:0", StartupTimeout: 10 * time.Second,
		ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second,
		PublicOrigin: "https://daynight.example", UniAuthURL: "https://auth.example",
		UniAuthAppID: "app", UniAuthAppSecret: "secret",
		UniAuthCallbackURL: "https://daynight.example/api/v1/auth/callback",
	}
}

func TestAppCloseRetainsResourcesUntilOperationFinishes(t *testing.T) {
	c := appTestConfig(t)
	app, err := OpenApp(context.Background(), c)
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
	c.UniAuthAppID = "invalid:app"
	app, err := OpenApp(context.Background(), c)
	var failure *config.ConfigurationError
	if app != nil || !errors.As(err, &failure) || !strings.Contains(failure.Field, "DAYNIGHT_UNIAUTH_APP_ID") {
		t.Fatalf("invalid credentials not rejected: app=%v, error=%v", app, err)
	}
	if _, err := os.Stat(c.StorageRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid credentials touched storage: %v", err)
	}
}

func TestOpenAppClosesStorageWhenDatabaseOpenFails(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("storage descriptor inspection requires procfs")
	}
	c := appTestConfig(t)
	if err := os.MkdirAll(c.StorageRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs(c.StorageRoot)
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
	c.DatabaseURL = "postgres://user:secret@bad%host/database"
	app, err := OpenApp(context.Background(), c)
	if app != nil || err == nil {
		t.Fatalf("invalid database accepted: app=%v, error=%v", app, err)
	}
	if after := countOpenRoots(); after != before {
		t.Fatalf("database startup failure leaked storage root: before=%d after=%d", before, after)
	}
}

func TestConcurrentCloseHonorsCallerDeadline(t *testing.T) {
	app, err := OpenApp(context.Background(), appTestConfig(t))
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
