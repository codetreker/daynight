package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/jackc/pgx/v5"
)

type authorizationScope struct {
	dao      *oauth.DAO
	identity store.IdentityDAO
}

func (s authorizationScope) AuthorizationDAO() store.AuthorizationDAO       { return s.dao }
func (s authorizationScope) OAuthClientDAO() store.OAuthClientDAO           { return s.dao }
func (s authorizationScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }
func (s authorizationScope) IdentityDAO() store.IdentityDAO                 { return s.identity }
func (s *Store) WriteAuthorizations(ctx context.Context, operation func(store.AuthorizationScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.AuthQueryError("begin OAuth authorization", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		dao := oauth.NewDAO(tx)
		return operation(authorizationScope{dao: dao, identity: identity.NewScope(tx, dao).IdentityDAO()})
	})
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, pg.AuthQueryError("OAuth authorization", err)
}
