package service

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ghconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
)

type githubAssemblyStore struct {
	store.Transactions
	scans chan struct{}
}

func (s githubAssemblyStore) DueGitHubProjects(ctx context.Context, id int64, _ time.Time, limit int) ([]string, error) {
	if id != 42 || limit != 32 {
		return nil, errors.New("unexpected scan parameters")
	}
	select {
	case s.scans <- struct{}{}:
	default:
	}
	return nil, nil
}
func (s githubAssemblyStore) WriteGitHubSignals(context.Context, func(store.GitHubSignalWriter) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}
func githubTestConfig(t *testing.T) ghconfig.Config {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "key.pem")
	data := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return ghconfig.Config{Enabled: true, AppID: 42, PrivateKeyFile: path, WebhookSecret: "secret"}
}
func TestGitHubProductionAssemblyStartsAndDrains(t *testing.T) {
	scans := make(chan struct{}, 1)
	db := githubAssemblyStore{scans: scans}
	app := NewModules(config.Config{}, db, func(context.Context) error { return nil }, nil, nil)
	c := githubTestConfig(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := app.assembleGitHub(db, c, logger); err != nil {
		t.Fatal(err)
	}
	if app.GitHubManager == nil || app.GitHubWebhook == nil || app.githubRuntime == nil || app.githubRuntime.client == nil {
		t.Fatal("production dependencies not assembled")
	}
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	select {
	case <-scans:
	case <-ctx.Done():
		t.Fatal("production runner did not scan")
	}
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

type controlledGithubRunner struct {
	mu        sync.Mutex
	failures  chan error
	release   chan struct{}
	work      context.Context
	claims    context.Context
	stopCount int
	startErr  error
}

func (r *controlledGithubRunner) StartWithClaimContext(work, claims context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.work, r.claims = work, claims
	return r.startErr
}
func (r *controlledGithubRunner) StopClaims() { r.mu.Lock(); r.stopCount++; r.mu.Unlock() }
func (r *controlledGithubRunner) Stop(ctx context.Context) error {
	select {
	case <-r.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *controlledGithubRunner) Failures() <-chan error { return r.failures }

func TestGitHubDrainRetainsDatabaseAndCancelsWork(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	app, backend, err := openTestApp(t, ctx, appTestConfig(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	backend.blockWebhookRuntime()
	runner := &controlledGithubRunner{failures: make(chan error, 1), release: make(chan struct{})}
	app.githubRuntime = &githubRuntime{runner: runner, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := app.Start(ctx); err != nil {
		t.Fatal(err)
	}
	app.StopClaims()
	runner.mu.Lock()
	work, stops := runner.work, runner.stopCount
	runner.mu.Unlock()
	if stops != 1 || work.Err() != nil {
		t.Fatal("stop claims did not preserve in-flight work")
	}
	short, done := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer done()
	err = app.Close(short)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected drain timeout: %v", err)
	}
	if work.Err() == nil {
		t.Fatal("work was not canceled")
	}
	backend.mu.Lock()
	closes := backend.closes
	backend.mu.Unlock()
	if closes != 0 {
		t.Fatal("database closed before work drained")
	}
	close(runner.release)
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	closes = backend.closes
	backend.mu.Unlock()
	if closes != 1 {
		t.Fatalf("database close count=%d", closes)
	}
}
func TestGitHubSupervisorRecordsFailureAndStartupFailure(t *testing.T) {
	runner := &controlledGithubRunner{failures: make(chan error, 1), release: make(chan struct{})}
	g := &githubRuntime{runner: runner, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := g.start(context.Background()); err != nil {
		t.Fatal(err)
	}
	runner.failures <- errors.New("stopped")
	select {
	case <-g.done:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not report failure")
	}
	g.mu.Lock()
	failure := g.failure
	g.mu.Unlock()
	if failure == nil {
		t.Fatal("failure not retained")
	}
	close(runner.release)
	if err := g.drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	failed := &controlledGithubRunner{startErr: errors.New("failed"), release: make(chan struct{}), failures: make(chan error, 1)}
	other := &githubRuntime{runner: failed}
	if err := other.start(context.Background()); err == nil {
		t.Fatal("failed runner accepted")
	}
	close(failed.release)
	if err := other.drain(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubAssemblyRejectsMissingDependencies(t *testing.T) {
	c := githubTestConfig(t)
	app := NewModules(config.Config{}, nil, func(context.Context) error { return nil }, nil, nil)
	if err := app.assembleGitHub(nil, ghconfig.Config{}, slog.Default()); err != nil {
		t.Fatalf("disabled assembly: %v", err)
	}
	if err := app.assembleGitHub(nil, c, slog.Default()); err == nil {
		t.Fatal("missing work reader accepted")
	}
	db := githubAssemblyStore{scans: make(chan struct{}, 1)}
	c.PrivateKeyFile = filepath.Join(t.TempDir(), "missing.pem")
	if err := app.assembleGitHub(db, c, slog.Default()); err == nil {
		t.Fatal("missing key accepted")
	}
	if app.githubRuntime != nil {
		t.Fatal("partial assembly published runtime")
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubAssemblyRejectsInvalidAppID(t *testing.T) {
	c := githubTestConfig(t)
	c.AppID = 0
	db := githubAssemblyStore{scans: make(chan struct{}, 1)}
	app := NewModules(config.Config{}, db, func(context.Context) error { return nil }, nil, nil)
	if err := app.assembleGitHub(db, c, slog.Default()); err == nil {
		t.Fatal("accepted invalid App ID")
	}
	if app.githubRuntime != nil {
		t.Fatal("published incomplete runtime")
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubAssemblyExposesSupervisorFailureThroughReadiness(t *testing.T) {
	db := githubAssemblyStore{scans: make(chan struct{}, 1)}
	baseErr := errors.New("database unavailable")
	app := NewModules(config.Config{}, db, func(context.Context) error { return baseErr }, nil, nil)
	if err := app.assembleGitHub(db, githubTestConfig(t), slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
	if err := app.Ready(context.Background()); !errors.Is(err, baseErr) {
		t.Fatalf("base readiness not preserved: %v", err)
	}
	runner := &controlledGithubRunner{failures: make(chan error, 1), release: make(chan struct{})}
	app.githubRuntime.runner = runner
	if err := app.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("runner failure")
	runner.failures <- failure
	select {
	case <-app.githubRuntime.done:
	case <-time.After(time.Second):
		t.Fatal("supervisor did not report failure")
	}
	if err := app.Ready(context.Background()); !errors.Is(err, failure) {
		t.Fatalf("runner failure not exposed through readiness: %v", err)
	}
	close(runner.release)
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}
