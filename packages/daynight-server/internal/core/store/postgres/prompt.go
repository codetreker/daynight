package postgres

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	promptdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/prompt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type promptStore struct{ pool *pgxpool.Pool }
type promptTx struct {
	store.PromptWriteScope
	tx pgx.Tx
}

func NewPrompt(pool *pgxpool.Pool) *promptStore { return &promptStore{pool: pool} }
func (s *promptStore) ReadPromptSnapshot(ctx context.Context, operation func(store.PromptSnapshot) error) error {
	return ReadOnlySnapshot(ctx, s.pool, func(tx pgx.Tx) error { return operation(promptdao.NewDAO(tx)) })
}
func (s *promptStore) WritePrompt(ctx context.Context, operation func(store.PromptWriteScope) error) (store.Completion, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin prompt write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(&promptTx{PromptWriteScope: promptdao.NewDAO(tx), tx: tx}) })
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.QueryError("write prompt", err)
}
func (s *Store) ReadPromptSnapshot(ctx context.Context, operation func(store.PromptSnapshot) error) error {
	return NewPrompt(s.Pool).ReadPromptSnapshot(ctx, operation)
}
func (s *Store) WritePrompt(ctx context.Context, operation func(store.PromptWriteScope) error) (store.Completion, error) {
	return NewPrompt(s.Pool).WritePrompt(ctx, operation)
}
