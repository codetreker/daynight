package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/jackc/pgx/v5"
)

type oauthClientScope struct{ dao *oauth.DAO }

func (s oauthClientScope) OAuthClientDAO() store.OAuthClientDAO           { return s.dao }
func (s oauthClientScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }
func (s *Store) WriteOAuthClients(ctx context.Context, operation func(store.OAuthClientScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.AuthQueryError("begin OAuth client operation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error { return operation(oauthClientScope{dao: oauth.NewDAO(tx)}) })
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.AuthQueryError("OAuth client operation", err)
}
