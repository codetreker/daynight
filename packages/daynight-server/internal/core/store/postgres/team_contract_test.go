package postgres

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	teamstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/team"
	"github.com/jackc/pgx/v5"
)

func testCreateTeam(s *Store, ctx context.Context, userID, teamID, name string) (model.Team, error) {
	var team model.Team
	_, err := s.CreateTeam(ctx, userID, func(dao TeamCreationDAO) error {
		var err error
		team, err = dao.InsertTeam(ctx, teamID, name)
		return err
	})
	return team, err
}
func testWriteTeam(s *Store, ctx context.Context, id string, op func(TeamWriteDAO) error) error {
	_, err := s.WriteTeam(ctx, id, func(scope TeamWriteScope) error { return op(scope.TeamDAO()) })
	return err
}

func testWriteTeamRaw(s *Store, ctx context.Context, id string, op func(TeamWriteDAO, pgx.Tx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return err
	}
	return transact(ctx, tx, func(tx pgx.Tx) error {
		var locked string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			return err
		}
		return op(teamstore.NewWriter(tx, id), tx)
	})
}
