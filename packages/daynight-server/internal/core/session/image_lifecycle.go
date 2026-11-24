package session

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

type imageWork struct {
	cancel context.CancelFunc
	done   chan struct{}
}
type imageWorkRegistry struct {
	sync.Mutex
	work map[string]map[string]*imageWork
}

// beginImageIO takes the exact storage gate before a durable lease can exist.
// If gate ownership is lost, the operation context cancels protected I/O.
func (s *Engine) beginImageIO(parent context.Context, id, lease string) (context.Context, func() error, error) {
	op, err := s.BeginOperation()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-op.Stopping():
			cancel()
		case <-ctx.Done():
		}
	}()
	if s.recoverMediaLeasesRun != nil {
		if err := s.recoverMediaLeasesRun(ctx); err != nil {
			cancel()
			op.Close()
			return nil, nil, err
		}
	}
	gate, err := s.files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+lease)
	if err != nil {
		cancel()
		op.Close()
		return nil, nil, err
	}
	gateCtx, cancelGate := filestorage.GateContext(ctx, gate)
	w := &imageWork{cancel: cancel, done: make(chan struct{})}
	s.mediaWork.Lock()
	if s.mediaWork.work == nil {
		s.mediaWork.work = map[string]map[string]*imageWork{}
	}
	if s.mediaWork.work[id] == nil {
		s.mediaWork.work[id] = map[string]*imageWork{}
	}
	s.mediaWork.work[id][lease] = w
	s.mediaWork.Unlock()
	return gateCtx, func() error {
		cancelGate()
		cancel()
		err := gate.Close()
		s.mediaWork.Lock()
		delete(s.mediaWork.work[id], lease)
		if len(s.mediaWork.work[id]) == 0 {
			delete(s.mediaWork.work, id)
		}
		close(w.done)
		s.mediaWork.Unlock()
		if err == nil && s.botHistoryReclaimRun != nil {
			cleanup, finish := context.WithTimeout(context.WithoutCancel(parent), 5*time.Second)
			if reclaimErr := s.botHistoryReclaimRun(cleanup, id); reclaimErr != nil {
				// This queue can belong to another resource. Its failure retains
				// maintenance responsibility without changing this I/O result.
				slog.ErrorContext(cleanup, "Bot history resource reclamation remains pending", "sessionId", id)
			}
			finish()
		}
		op.Close()
		return err
	}, nil
}

// CancelSessionMedia waits for each local reader/writer's actual exit. The
// durable leases and storage gates coordinate with other instances.
func (s *Engine) CancelSessionMedia(ctx context.Context, id string) error {
	s.mediaWork.Lock()
	work := []*imageWork{}
	for _, w := range s.mediaWork.work[id] {
		w.cancel()
		work = append(work, w)
	}
	s.mediaWork.Unlock()
	for _, w := range work {
		select {
		case <-w.done:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}
func joinImageCleanup(primary error, cleanup func() error) error {
	if cleanup == nil {
		return primary
	}
	return errors.Join(primary, cleanup())
}
