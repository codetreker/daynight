package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/jackc/pgx/v5"
)

type sessionScope struct{ tx pgx.Tx }

func (s *sessionScope) SessionDAO() store.SessionDAO { return session.New(s.tx) }
func (s *sessionScope) BotDAO() store.BotWriteDAO    { return bot.NewWriter(s.tx) }

func (s *Store) WriteSession(ctx context.Context, operation func(store.SessionScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin session", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(&sessionScope{tx: tx}) })
	return teamCompletion("write session", err)
}
