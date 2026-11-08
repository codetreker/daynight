package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type uploadRetainerKey struct{}

// WithUploadLeaseRetainer lets a protocol retain an upload lease until its
// response and handler have both finished.
func WithUploadLeaseRetainer(ctx context.Context, retain func(io.Closer)) context.Context {
	return context.WithValue(ctx, uploadRetainerKey{}, retain)
}

func RetainUploadLease(ctx context.Context, lease io.Closer) bool {
	retain, ok := ctx.Value(uploadRetainerKey{}).(func(io.Closer))
	if !ok || retain == nil {
		return false
	}
	retain(lease)
	return true
}

type uploadLease struct {
	once                sync.Once
	mu                  sync.Mutex
	closed              bool
	instance            chan struct{}
	user, project, task string
	permits             []io.Closer
	err                 error
}

func (l *uploadLease) Close() error {
	l.once.Do(func() {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.closed = true
		for i := len(l.permits) - 1; i >= 0; i-- {
			l.err = errors.Join(l.err, l.permits[i].Close())
		}
		<-l.instance
	})
	return l.err
}

// AcquireUploadLease requires the caller to have already authorized the operation.
// The shared storage root coordinates user and Task limits across instances.
func (s *Attachments) AcquireUploadLease(ctx context.Context, principal model.Principal, projectID, taskID string) (io.Closer, error) {
	user, err := model.CanonicalID(principal.UserID)
	if err != nil {
		return nil, err
	}
	projectID, err = model.CanonicalID(projectID)
	if err != nil {
		return nil, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return nil, err
	}
	select {
	case s.uploadSlots <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return nil, uploadBusy()
	}
	lease := &uploadLease{instance: s.uploadSlots, user: user, project: projectID, task: taskID}
	gate, ok := s.files.(filestorage.ResidencyGate)
	if !ok {
		return nil, errors.Join(errors.New("attachment residency gate unavailable"), lease.Close())
	}
	for _, key := range []struct {
		prefix string
		slots  int
	}{{"attachment/user/" + user, 2}, {"attachment/task/" + projectID + "/" + taskID, 1}} {
		var permit io.Closer
		for slot := 0; slot < key.slots; slot++ {
			permit, err = gate.TryAcquireResidency(ctx, fmt.Sprintf("%s/%d", key.prefix, slot))
			if err == nil {
				break
			}
			if !errors.Is(err, filestorage.ErrGateBusy) {
				return nil, errors.Join(err, lease.Close())
			}
		}
		if permit == nil {
			return nil, errors.Join(uploadBusy(), lease.Close())
		}
		lease.permits = append(lease.permits, permit)
	}
	return lease, nil
}
func uploadBusy() error {
	return &model.Fault{Code: "resource_busy", Message: "Attachment upload capacity is unavailable."}
}
