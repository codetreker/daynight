package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	githubconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/github/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type githubRunner interface {
	StartWithClaimContext(context.Context, context.Context) error
	StopClaims()
	Stop(context.Context) error
	Failures() <-chan error
}

type githubRuntime struct {
	runner  githubRunner
	client  *remote.Client
	logger  *slog.Logger
	mu      sync.Mutex
	started bool
	cancel  context.CancelFunc
	done    chan struct{}
	failure error
}

func (a *App) assembleGitHub(db store.Transactions, c githubconfig.Config, logger *slog.Logger) error {
	if !c.Enabled {
		return nil
	}
	reader, ok := db.(store.GitHubWorkReader)
	if !ok {
		return errors.New("github work reader unavailable")
	}
	signals, ok := db.(store.GitHubSignalTransaction)
	if !ok {
		return errors.New("github signal transaction unavailable")
	}
	receiver, err := githubservice.NewWebhookReceiver(signals, c.AppID, logger)
	if err != nil {
		return err
	}
	key, err := c.PrivateKey()
	if err != nil {
		return err
	}
	client, err := remote.NewClient(c.AppID, key)
	if err != nil {
		return err
	}
	executor, err := githubservice.NewExecutor(db, client, c.AppID, logger)
	if err != nil {
		client.CloseIdleConnections()
		return err
	}
	runner, err := githubservice.NewRunner(reader, executor, c.AppID, logger)
	if err != nil {
		client.CloseIdleConnections()
		return err
	}
	a.GitHubManager = githubservice.NewManager(db, client, c.AppID)
	a.GitHubWebhook = receiver
	g := &githubRuntime{runner: runner, client: client, logger: logger}
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
