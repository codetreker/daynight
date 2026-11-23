package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type githubRunner interface {
	StartWithClaimContext(context.Context, context.Context) error
	StopClaims()
	Stop(context.Context) error
	Failures() <-chan error
}

type githubRuntime struct {
	runner   githubRunner
	provider interface{ Close(context.Context) error }
	logger   *slog.Logger
	mu       sync.Mutex
	started  bool
	cancel   context.CancelFunc
	done     chan struct{}
	failure  error
}

type githubAppStore interface {
	store.GitHubAppStore
	store.GitHubAppConfigStore
	store.GitHubAppAdminStore
	store.GitHubGrantStore
	store.GitHubAppImpactStore
	store.GitHubProjectAppStore
	store.GitHubAppCredentialReader
	store.GitHubAppWebhookStore
	store.GitHubAppWorkReader
	store.GitHubAppWorkWriter
	store.SnapshotReader
}

func (a *App) assembleGitHub(db store.Transactions, logger *slog.Logger) error {
	backend, ok := db.(githubAppStore)
	if !ok {
		return errors.New("github App store unavailable")
	}
	receiver, err := githubservice.NewAppWebhookReceiver(backend, logger)
	if err != nil {
		return err
	}
	provider, err := githubservice.NewClientProvider(backend)
	if err != nil {
		return err
	}
	executor, err := githubservice.NewAppExecutor(backend, provider, logger)
	if err != nil {
		_ = provider.Close(context.Background())
		return err
	}
	runner, err := githubservice.NewAppRunner(backend, executor, logger)
	if err != nil {
		_ = provider.Close(context.Background())
		return err
	}
	a.GitHubApps = githubservice.NewScopedAppManager(backend, a.Scoped.Credentials.Refresh)
	a.GitHubConfig = githubservice.NewScopedConfigManager(backend, a.Scoped.Credentials.Refresh)
	a.GitHubAdmins = githubservice.NewAdminManager(backend)
	a.GitHubGrants = githubservice.NewScopedGrantManager(backend, backend, a.Scoped.Credentials.Refresh)
	a.GitHubProject = githubservice.NewScopedProjectAppManager(backend, provider, logger, a.Scoped.Credentials.Refresh)
	a.Application.Projects.SetRepositoryObserver(a.GitHubProject)
	a.GitHubWebhook = receiver
	g := &githubRuntime{runner: runner, provider: provider, logger: logger}
	a.githubRuntime = g
	ready := a.Ready
	a.Ready = func(ctx context.Context) error {
		g.mu.Lock()
		failure := g.failure
		g.mu.Unlock()
		if failure != nil {
			return failure
		}
		return ready(ctx)
	}
	return nil
}

func (g *githubRuntime) start(root context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.started {
		return errors.New("github runtime already started")
	}
	ctx, cancel := context.WithCancel(context.WithoutCancel(root))
	if err := g.runner.StartWithClaimContext(ctx, root); err != nil {
		cancel()
		return err
	}
	g.started, g.cancel, g.done = true, cancel, make(chan struct{})
	go g.supervise(ctx)
	return nil
}
func (g *githubRuntime) supervise(ctx context.Context) {
	defer close(g.done)
	select {
	case err := <-g.runner.Failures():
		g.mu.Lock()
		g.failure = fmt.Errorf("github runtime unavailable: %w", err)
		g.mu.Unlock()
		g.runner.StopClaims()
		g.logger.Error("github runtime failed", "component", "github_sync", "phase", "stop")
	case <-ctx.Done():
	}
}
func (g *githubRuntime) cancelWork() {
	g.mu.Lock()
	cancel := g.cancel
	g.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}
func (g *githubRuntime) drain(ctx context.Context) error {
	g.runner.StopClaims()
	g.cancelWork()
	if err := g.runner.Stop(ctx); err != nil {
		return err
	}
	g.mu.Lock()
	done := g.done
	g.mu.Unlock()
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
