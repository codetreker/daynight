package reviewassignment

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Runner owns one reconciler and joins it before its storage is closed.
type Runner struct {
	reconciler *Reconciler
	mu         sync.Mutex
	cancel     context.CancelFunc
	done       chan struct{}
}

func NewRunner(reconciler *Reconciler) *Runner { return &Runner{reconciler: reconciler} }

func (r *Runner) Start(root context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.done != nil {
		return errors.New("review assignment runner already started")
	}
	if root == nil || root.Err() != nil {
		return errors.New("invalid review assignment context")
	}
	ctx, cancel := context.WithCancel(root)
	r.cancel, r.done = cancel, make(chan struct{})
	go func() {
		defer close(r.done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			r.reconciler.Batch(ctx, 64)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

func (r *Runner) Cancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
}

func (r *Runner) Stop(ctx context.Context) error {
	r.Cancel()
	r.mu.Lock()
	done := r.done
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
