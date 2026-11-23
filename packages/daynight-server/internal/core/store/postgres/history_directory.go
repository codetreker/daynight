package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

type historyDirectorySnapshot struct{ *Snapshot }

func (s *Store) ReadHistoryDirectory(ctx context.Context, work func(store.HistoryDirectoryScope) error) error {
	return ReadOnlySnapshot(ctx, s.Pool, func(tx pgx.Tx) error {
		return work(&historyDirectorySnapshot{Snapshot: &Snapshot{tx: tx}})
	})
}

func (s *historyDirectorySnapshot) HistoryDirectoryDAO() store.HistoryDirectoryDAO {
	return session.NewHistoryDirectory(s.tx)
}
