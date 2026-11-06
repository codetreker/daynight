package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/jackc/pgx/v5"
)

type credentialFamilyScope struct{ dao store.CredentialFamilyDAO }

func (s credentialFamilyScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

func (s *Store) WriteCredentialFamily(ctx context.Context, operation func(store.CredentialFamilyScope) error) (store.Completion, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.AuthQueryError("begin OAuth family operation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(credentialFamilyScope{dao: oauth.NewDAO(tx)}) })
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.AuthQueryError("OAuth family operation", err)
}
