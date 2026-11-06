package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
func testWriteTeam(s *Store, ctx context.Context, id string, op func(*TeamTx) error) error {
	_, err := s.WriteTeam(ctx, id, func(dao TeamWriteDAO) error { return op(dao.(*TeamTx)) })
	return err
}
