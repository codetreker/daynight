package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mediaLeaseReaper func(context.Context, []store.SessionResourceLease, func(context.Context, string, string) error) error

func (s *Service) recoverMediaLeases(ctx context.Context) error {
	return s.recoverMediaLeasesUsing(ctx, s.engine.RecoverMediaLeases)
}

// Recovery never holds a database scope while waiting for a filesystem gate.
// The core reaper retains each acquired gate through the deletion's completion.
func (s *Service) recoverMediaLeasesUsing(ctx context.Context, reap mediaLeaseReaper) error {
	var leases []store.SessionResourceLease
	if err := s.write(ctx, func(store.TransactionOutcome) {}, func(scope store.SessionScope) error {
		dao, ok := scope.SessionDAO().(store.SessionResourceLeaseRecoveryDAO)
		if !ok {
			return errors.New("media recovery requires resource lease recovery DAO")
		}
		var err error
		leases, err = dao.ListSessionMediaLeases(ctx)
		return err
	}); err != nil {
		return err
	}
	return reap(ctx, leases, func(ctx context.Context, id, lease string) error {
		return s.write(ctx, func(store.TransactionOutcome) {}, func(scope store.SessionScope) error {
			dao, ok := scope.SessionDAO().(store.SessionResourceDAO)
			if !ok {
				return errors.New("media recovery requires resource DAO")
			}
			return dao.ReleaseSessionResourceLease(ctx, id, lease)
		})
	})
}
