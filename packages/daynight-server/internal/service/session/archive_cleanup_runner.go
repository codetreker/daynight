package session

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"
)

// ArchiveCleanupRunner resumes unfinished reclamation at startup and walks the
// retained directory in bounded pages. Failures retain their durable records
// for a later pass, including after process restart.
type ArchiveCleanupRunner struct {
	mu       sync.Mutex
	sweep    func(context.Context, string) (string, error)
	botSweep func(context.Context, string) (string, error)
	logger   *slog.Logger
	interval time.Duration
	cancel   context.CancelFunc
	done     chan struct{}
}

func NewArchiveCleanupRunner(cleanup *ArchiveCleanup, logger *slog.Logger) *ArchiveCleanupRunner {
	return &ArchiveCleanupRunner{sweep: cleanup.Sweep, logger: logger, interval: time.Minute}
}

// SetBotHistorySweep shares shutdown ownership while retaining an independent
// cursor and deadline for Bot resources that have no Task archive lifetime.
func (r *ArchiveCleanupRunner) SetBotHistorySweep(sweep func(context.Context, string) (string, error)) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil || sweep == nil {
		return errors.New("Bot history cleanup must be configured before startup")
	}
	r.botSweep = sweep
	return nil
}

func (r *ArchiveCleanupRunner) Start(root context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil {
		return errors.New("archive cleanup already started")
	}
	if root == nil || root.Err() != nil {
		return errors.New("invalid archive cleanup context")
	}
	ctx, cancel := context.WithCancel(root)
	r.cancel, r.done = cancel, make(chan struct{})
	go r.run(ctx)
	return nil
}

func (r *ArchiveCleanupRunner) run(ctx context.Context) {
	defer close(r.done)
	var cursor, botCursor string
	for {
		if ctx.Err() != nil {
			return
		}
		pass, cancel := context.WithTimeout(ctx, time.Minute)
		next, err := r.sweep(pass, cursor)
		cancel()
		cursor = next
		if err != nil && ctx.Err() == nil && r.logger != nil {
			r.logger.Error("archive cleanup pass failed", "component", "session_archive", "operation", "cleanup", "error", err)
		}
		if r.botSweep != nil && ctx.Err() == nil {
			pass, cancel := context.WithTimeout(ctx, time.Minute)
			next, err := r.botSweep(pass, botCursor)
			cancel()
			botCursor = next
			if err != nil && ctx.Err() == nil && r.logger != nil {
				r.logger.Error("Bot history cleanup pass failed", "component", "bot_history", "operation", "cleanup", "error", err)
			}
		}
		timer := time.NewTimer(r.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (r *ArchiveCleanupRunner) Cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
}

func (r *ArchiveCleanupRunner) Stop(ctx context.Context) error {
	r.mu.Lock()
	done := r.done
	if r.cancel != nil {
		r.cancel()
	}
	r.mu.Unlock()
	if done == nil {
		return nil
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
