package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const runnerWorkers = 4
const runnerCandidates = 32

type projectExecutor interface {
	ExecuteWithClaimContext(context.Context, context.Context, string) error
}

// Runner discovers due Projects and runs at most four independent executors.
// Construction does not start background work.
type Runner struct {
	reader     store.GitHubWorkReader
	executor   projectExecutor
	appID      int64
	logger     *slog.Logger
	interval   time.Duration
	mu         sync.Mutex
	cancel     context.CancelFunc
	stopClaims context.CancelFunc
	done       chan struct{}
	failures   chan error
	active     map[string]bool
}

func NewRunner(reader store.GitHubWorkReader, executor *Executor, appID int64, logger *slog.Logger) (*Runner, error) {
	if reader == nil || executor == nil || appID <= 0 {
		return nil, errors.New("github runner requires work reader, executor and app ID")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Runner{reader: reader, executor: executor, appID: appID, logger: logger, interval: time.Second, failures: make(chan error, 1)}, nil
}

func (r *Runner) Failures() <-chan error { return r.failures }

// StartWithClaimContext separates stopping admission from cancelling in-flight work.
func (r *Runner) StartWithClaimContext(work, claims context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil {
		return errors.New("github runner already started")
	}
	if work == nil || claims == nil || work.Err() != nil || claims.Err() != nil || r.reader == nil || r.executor == nil || r.appID <= 0 || r.interval <= 0 {
		return errors.New("invalid github runner dependencies")
	}
	workCtx, cancel := context.WithCancel(work)
	claimCtx, stop := context.WithCancel(claims)
	r.cancel, r.stopClaims, r.done, r.active = cancel, stop, make(chan struct{}), make(map[string]bool)
	go r.loop(workCtx, claimCtx)
	return nil
}

func (r *Runner) fail() {
	select {
	case r.failures <- errors.New("github runner failed unexpectedly"):
	default:
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopClaims != nil {
		r.stopClaims()
	}
	if r.cancel != nil {
		r.cancel()
	}
}

func (r *Runner) loop(work, claims context.Context) {
	var workers sync.WaitGroup
	defer func() {
		if recover() != nil {
			r.fail()
		}
		workers.Wait()
		close(r.done)
	}()
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		if claims.Err() != nil || work.Err() != nil {
			return
		}
		ctx, cancel := context.WithTimeout(claims, core.OperationTimeout)
		projects, err := r.reader.DueGitHubProjects(ctx, r.appID, time.Now(), runnerCandidates)
		cancel()
		if err != nil && claims.Err() == nil && work.Err() == nil {
			r.logger.WarnContext(work, "github scan failed", "component", "github_sync", "phase", "claim", "result_code", "github_unavailable")
		}
		if err != nil {
			projects = nil
		}
		for _, id := range projects {
			r.mu.Lock()
			if claims.Err() != nil || work.Err() != nil {
				r.mu.Unlock()
				break
			}
			if len(r.active) >= runnerWorkers {
				r.mu.Unlock()
				break
			}
			if id == "" || r.active[id] {
				r.mu.Unlock()
				continue
			}
			r.active[id] = true
			workers.Add(1)
			go func(project string) {
				defer workers.Done()
				defer func() {
					if recover() != nil {
						r.fail()
					}
					r.mu.Lock()
					delete(r.active, project)
					r.mu.Unlock()
				}()
				if err := r.executor.ExecuteWithClaimContext(work, claims, project); err != nil && work.Err() == nil && claims.Err() == nil {
					r.logger.WarnContext(work, "github execution stopped", "component", "github_sync", "phase", "stop", "project_id", project)
				}
			}(id)
			r.mu.Unlock()
		}
		select {
		case <-claims.Done():
			return
		case <-work.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) StopClaims() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopClaims != nil {
		r.stopClaims()
	}
}

// Stop cancels work and waits for all dependencies to become unused. It can be retried.
func (r *Runner) Stop(ctx context.Context) error {
	r.mu.Lock()
	cancel, stop, done := r.cancel, r.stopClaims, r.done
	r.mu.Unlock()
	if done == nil {
		return nil
	}
	stop()
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("drain github runner: %w", ctx.Err())
	}
}
