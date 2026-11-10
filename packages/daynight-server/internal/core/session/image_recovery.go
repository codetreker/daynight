package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (s *Engine) SetMediaLeaseRecovery(recover func(context.Context) error) {
	s.recoverMediaLeasesRun = recover
}

// RecoverMediaLeases reclaims only owners proven to have exited by the same
// exact filesystem gate acquired before their durable lease was inserted.
// A busy gate is left intact. The release callback must confirm its transaction
// before returning; unknown completion and gate-close failures remain errors.
func (s *Engine) RecoverMediaLeases(ctx context.Context, leases []store.SessionResourceLease, release func(context.Context, string, string) error) error {
	for _, lease := range leases {
		gate, err := filestorage.TryAcquireMediaLease(ctx, s.files, "session-resource-lease/"+lease.ID)
		if errors.Is(err, filestorage.ErrGateBusy) {
			continue
		}
		if err != nil {
			return err
		}
		err = release(ctx, lease.SessionID, lease.ID)
		if err = errors.Join(err, gate.Close()); err != nil {
			return err
		}
	}
	return nil
}
