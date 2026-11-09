package session

import (
	"context"
	"errors"
	"sync"

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

// beginImageIO takes the crash-released filesystem gate before a durable lease
// can exist. A deletion owner may acquire that exact gate to prove stale I/O
// exited; lease expiry and process-heartbeat guesses are never used as proof.
func (s *Engine) beginImageIO(parent context.Context, id, lease string) (context.Context, func() error, error) {
	op, err := s.BeginOperation()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	gate, err := s.files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+lease)
	if err != nil {
		cancel()
		op.Close()
		return nil, nil, err
	}
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
	go func() {
		select {
		case <-op.Stopping():
			cancel()
		case <-w.done:
		}
	}()
	return ctx, func() error {
		cancel()
		err := gate.Close()
		s.mediaWork.Lock()
		delete(s.mediaWork.work[id], lease)
		if len(s.mediaWork.work[id]) == 0 {
			delete(s.mediaWork.work, id)
		}
		close(w.done)
		s.mediaWork.Unlock()
		op.Close()
		return err
	}, nil
}

// CancelSessionMedia waits for each local reader/writer's actual exit. The
// persistent lease and filesystem-gate checks cover other instances separately.
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
