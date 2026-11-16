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

// AppRunner discovers due Projects and runs at most four independent executors.
// Construction does not start background work.
type AppRunner struct {
	reader     store.GitHubAppWorkReader
	executor   projectExecutor
	logger     *slog.Logger
	interval   time.Duration
	mu         sync.Mutex
	cancel     context.CancelFunc
	stopClaims context.CancelFunc
	done       chan struct{}
	failures   chan error
	active     map[string]bool
	failure    error
}

func NewAppRunner(reader store.GitHubAppWorkReader, executor *AppExecutor, logger *slog.Logger) (*AppRunner, error) {
	if reader == nil || executor == nil {
		return nil, errors.New("github runner requires work reader and executor")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &AppRunner{reader: reader, executor: executor, logger: logger, interval: time.Second, failures: make(chan error, 1)}, nil
}

func (r *AppRunner) Failures() <-chan error { return r.failures }

// Ready reports a supervised unexpected exit independently of database readiness.
func (r *AppRunner) Ready(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.failure
}

// StartWithClaimContext separates stopping admission from cancelling in-flight work.
func (r *AppRunner) StartWithClaimContext(work, claims context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil {
		return errors.New("github runner already started")
	}
	if work == nil || claims == nil || work.Err() != nil || claims.Err() != nil || r.reader == nil || r.executor == nil || r.interval <= 0 {
		return errors.New("invalid github runner dependencies")
	}
	workCtx, cancel := context.WithCancel(work)
	claimCtx, stop := context.WithCancel(claims)
	r.cancel, r.stopClaims, r.done, r.active = cancel, stop, make(chan struct{}), make(map[string]bool)
	go r.loop(workCtx, claimCtx)
	return nil
}

func (r *AppRunner) fail() {
	r.mu.Lock()
	r.failure = errors.New("github App runner failed unexpectedly")
	r.mu.Unlock()
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

func (r *AppRunner) loop(work, claims context.Context) {
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
		projects, err := r.reader.DueGitHubAppProjects(ctx, time.Now(), runnerCandidates)
		cancel()
		if err != nil && claims.Err() == nil && work.Err() == nil {
			attrs := append([]any{"component", "github_sync", "phase", "claim"}, appErrorAttributes(err)...)
			r.logger.WarnContext(work, "github scan failed", attrs...)
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
				job, cancel := context.WithCancel(work)
				defer cancel()
				defer func() {
					if recover() != nil {
						r.fail()
					}
					r.mu.Lock()
					delete(r.active, project)
					r.mu.Unlock()
				}()
				if err := r.executor.ExecuteWithClaimContext(job, claims, project); err != nil && work.Err() == nil && claims.Err() == nil {
					attrs := append([]any{"component", "github_sync", "phase", "stop", "project_id", project}, appErrorAttributes(err)...)
					r.logger.WarnContext(job, "github execution stopped", attrs...)
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

func (r *AppRunner) StopClaims() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopClaims != nil {
		r.stopClaims()
	}
}

// Stop cancels work and waits for all dependencies to become unused. It can be retried.
func (r *AppRunner) Stop(ctx context.Context) error {
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
