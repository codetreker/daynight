package postgres

import (
	"context"
	"errors"
	"fmt"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/eligibility"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/jackc/pgx/v5"
)

type projectDirectMemberScope struct {
	tx        pgx.Tx
	projectID string
}

func (s projectDirectMemberScope) ProjectDAO() ProjectWriteDAO {
	return project.NewWriter(s.tx, s.projectID)
}
func (s projectDirectMemberScope) DirectMemberDAO() ProjectDirectMemberDAO {
	return project.NewDirectMemberDAO(s.tx, s.projectID)
}
func (s projectDirectMemberScope) IdentityDAO() IdentityDAO {
	return identity.NewScope(s.tx, oauth.NewDAO(s.tx)).IdentityDAO()
}
func (s projectDirectMemberScope) CredentialFamilyDAO() CredentialFamilyDAO {
	return oauth.NewDAO(s.tx)
}
func (s projectDirectMemberScope) EligibilityDAO() WebhookEligibilityDAO {
	return eligibility.New(s.tx)
}

func (s *Store) WriteProjectDirectMember(ctx context.Context, id string, operation func(ProjectDirectMemberScope) error) (Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return Completion{Outcome: TransactionNotCommitted}, pg.QueryError("begin project direct member write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var root, team string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&root); err != nil {
			return pg.QueryError("lock project", err)
		}
		if err := tx.QueryRow(ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1 FOR SHARE`, id).Scan(&team); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("project ownership is missing")
			}
			return pg.QueryError("lock project ownership", err)
		}
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR SHARE`, team).Scan(&root); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("project owner Team is missing")
			}
			return pg.QueryError("lock project owner Team", err)
		}
		return operation(projectDirectMemberScope{tx, id})
	})
	return teamCompletion("project direct member write", err)
}
