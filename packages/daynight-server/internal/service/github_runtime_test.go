package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

var _ githubAppStore = (*postgres.Store)(nil)

// These interfaces are unused by lifecycle-only fixtures; an unexpected call
// fails instead of manufacturing a database result.
type unusedGitHubCapabilities struct {
	store.GitHubAppStore
	store.GitHubAppConfigStore
	store.GitHubAppAdminStore
	store.GitHubGrantStore
	store.GitHubAppImpactStore
	store.GitHubProjectAppStore
	store.GitHubAppCredentialReader
	store.GitHubAppWebhookStore
	store.GitHubAppWorkWriter
}

func (unusedGitHubCapabilities) DueGitHubAppProjects(context.Context, time.Time, int) ([]string, error) {
	return nil, nil
}

type githubAssemblyStore struct {
	store.Transactions
	unusedGitHubCapabilities
	scans      chan struct{}
	adminReads *int
}

var errAssemblyAdminRead = errors.New("controlled administrator store")

func (s githubAssemblyStore) ReadGitHubAppAdmins(context.Context, func(store.GitHubAppAdminReader) error) error {
	if s.adminReads != nil {
		*s.adminReads++
	}
	return errAssemblyAdminRead
}

func (s githubAssemblyStore) DueGitHubAppProjects(ctx context.Context, _ time.Time, limit int) ([]string, error) {
	if limit != 32 {
		return nil, errors.New("unexpected scan parameters")
	}
	select {
	case s.scans <- struct{}{}:
	default:
	}
	return nil, nil
}
func TestGitHubProductionAssemblyStartsAndDrains(t *testing.T) {
	scans := make(chan struct{}, 1)
	adminReads := 0
	db := githubAssemblyStore{scans: scans, adminReads: &adminReads}
	app := NewModules(config.Config{}, db, func(context.Context) error { return nil }, nil, nil)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := app.assembleGitHub(db, logger); err != nil {
		t.Fatal(err)
	}
	if app.GitHubApps == nil || app.GitHubConfig == nil || app.GitHubAdmins == nil || app.GitHubGrants == nil || app.GitHubProject == nil || app.GitHubWebhook == nil || app.githubRuntime == nil || app.githubRuntime.provider == nil {
		t.Fatal("production dependencies not assembled")
	}
	_, err := app.GitHubAdmins.ListAdmins(context.Background(), model.Principal{}, "", coregithub.ListAppsInput{})
	if !errors.Is(err, errAssemblyAdminRead) || adminReads != 1 {
		t.Fatalf("administrator manager was not bound to the assembly store: reads=%d err=%v", adminReads, err)
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

type controlledGitHubProvider struct {
	release chan struct{}
	called  chan struct{}
}

func (p *controlledGitHubProvider) Close(ctx context.Context) error {
	select {
	case p.called <- struct{}{}:
	default:
	}
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func TestGitHubDrainRetainsDatabaseAndCancelsWork(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	app, backend, err := openTestApp(t, ctx, appTestConfig(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	backend.blockWebhookRuntime()
	runner := &controlledGithubRunner{failures: make(chan error, 1), release: make(chan struct{})}
	provider := &controlledGitHubProvider{release: make(chan struct{}), called: make(chan struct{}, 2)}
	app.githubRuntime = &githubRuntime{runner: runner, provider: provider, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
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
	select {
	case <-provider.called:
		t.Fatal("provider closed before runner drained")
	default:
	}
	close(runner.release)
	shortProvider, stopProvider := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer stopProvider()
	if err := app.Close(shortProvider); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected provider timeout: %v", err)
	}
	backend.mu.Lock()
	closes = backend.closes
	backend.mu.Unlock()
	if closes != 0 {
		t.Fatal("database closed while provider still borrowed")
	}
	close(provider.release)
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

// This fixture has every runtime capability except administrator storage.
type githubAssemblyWithoutAdminStore struct {
	store.Transactions
	store.GitHubAppStore
	store.GitHubAppConfigStore
	store.GitHubGrantStore
	store.GitHubAppImpactStore
	store.GitHubProjectAppStore
	store.GitHubAppCredentialReader
	store.GitHubAppWebhookStore
	store.GitHubAppWorkReader
	store.GitHubAppWorkWriter
}

func TestGitHubAssemblyRejectsMissingDependencies(t *testing.T) {
	app := NewModules(config.Config{}, compositionOnlyStore{}, func(context.Context) error { return nil }, nil, nil)
	if err := app.assembleGitHub(nil, slog.Default()); err == nil {
		t.Fatal("missing App store accepted")
	}
	if err := app.assembleGitHub(githubAssemblyWithoutAdminStore{}, slog.Default()); err == nil {
		t.Fatal("missing administrator store accepted")
	}
	if app.githubRuntime != nil || app.GitHubWebhook != nil {
		t.Fatal("partial assembly published")
	}
	if err := app.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestGitHubAssemblyExposesSupervisorFailureThroughReadiness(t *testing.T) {
	db := githubAssemblyStore{scans: make(chan struct{}, 1)}
	baseErr := errors.New("database unavailable")
	app := NewModules(config.Config{}, db, func(context.Context) error { return baseErr }, nil, nil)
	if err := app.assembleGitHub(db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
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
