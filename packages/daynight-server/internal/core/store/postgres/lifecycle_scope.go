package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	"github.com/jackc/pgx/v5"
)

type workerLifecycleScope struct {
	authorizedWorkerScope
	lifecycle *worker.Lifecycle
}

func (s workerLifecycleScope) LifecycleDAO() store.WorkerLifecycleDAO { return s.lifecycle }

type workerLifecycleSnapshot struct {
	*Snapshot
	lifecycle *worker.Lifecycle
}

func (s workerLifecycleSnapshot) LifecycleDAO() store.WorkerLifecycleReader { return s.lifecycle }

func (s *Store) WriteWorkerLifecycle(ctx context.Context, operation func(store.WorkerLifecycleScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin worker lifecycle", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		return operation(workerLifecycleScope{authorizedWorkerScope{worker.NewWriter(tx), credentialAuthorization{tx}}, worker.NewLifecycle(tx)})
	})
	return teamCompletion("write worker lifecycle", err)
}

func (s *Store) ReadWorkerLifecycle(ctx context.Context, operation func(store.WorkerLifecycleSnapshot) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error {
		return operation(workerLifecycleSnapshot{&Snapshot{tx: tx}, worker.NewLifecycle(tx)})
	}, false)
}

var _ store.WorkerLifecycleStore = (*Store)(nil)
