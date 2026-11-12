package postgres

import (
	"context"
	"errors"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/jackc/pgx/v5"
)

func (s *Store) CreateTeam(ctx context.Context, userID string, operation func(TeamCreationDAO) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, pg.QueryError("begin Team creation", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var user string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM users WHERE id=$1 FOR KEY SHARE`, userID).Scan(&user); err != nil {
			return pg.QueryError("read Team creator", err)
		}
		return operation(team.NewCreation(tx, userID))
	})
	return teamCompletion("create Team", err)
}

type teamWriteScope struct {
	tx     pgx.Tx
	teamID string
}

func (s teamWriteScope) TeamDAO() TeamWriteDAO                 { return team.NewWriter(s.tx, s.teamID) }
func (s teamWriteScope) EligibilityDAO() WebhookEligibilityDAO { return eligibility.New(s.tx) }

func (s teamWriteScope) IdentityDAO() IdentityDAO {
	return identity.NewScope(s.tx, oauth.NewDAO(s.tx)).IdentityDAO()
}
func (s teamWriteScope) CredentialFamilyDAO() CredentialFamilyDAO { return oauth.NewDAO(s.tx) }

func (s *Store) WriteTeam(ctx context.Context, teamID string, operation func(TeamWriteScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, pg.QueryError("begin Team write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, teamID).Scan(&id); err != nil {
			return pg.QueryError("lock Team", err)
		}
		return operation(teamWriteScope{tx, teamID})
	})
	return teamCompletion("write Team", err)
}

func teamCompletion(operation string, err error) (Completion, error) {
	if err == nil {
		return Completion{Outcome: TransactionCommitted}, nil
	}
	var failure *TransactionError
	outcome := TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return Completion{Outcome: outcome}, pg.QueryError(operation, err)
}
