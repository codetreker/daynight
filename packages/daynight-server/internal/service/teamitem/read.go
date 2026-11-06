// Package teamitem coordinates consistent item bytes with current authority.
package teamitem

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/teamitem"
)

type Service struct{ database store.TeamItemStore }

func New(database store.TeamItemStore) *Service { return &Service{database: database} }
func (s *Service) Read(ctx context.Context, a core.Authority, in core.Input) (core.Result, error) {
	if err := core.Validate(a, in); err != nil {
		return core.Result{}, err
	}
	var result core.Result
	err := s.database.ReadTeamItem(ctx, func(dao store.TeamItemReader) error {
		var err error
		result, err = core.Read(ctx, dao, a, in)
		return err
	})
	if err != nil {
		return core.Result{}, err
	}
	if err = s.database.AuthorizeTeamItem(ctx, a, in.Target); err != nil {
		return core.Result{}, core.LookupError(err)
	}
	return result, nil
}
