package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) WriteIdentity(ctx context.Context, operation func(store.IdentityScope) error) (store.Completion, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.AuthQueryError("begin identity operation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(identity.NewScope(tx)) })
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.AuthQueryError("identity operation", err)
}
