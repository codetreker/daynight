package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// SearchMemberCandidates rechecks the credential and Team access in the same snapshot as the directory read.
func (s *Teams) SearchMemberCandidates(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
	id, search, err := core.ValidateCandidateSearch(p, id, input)
	if err != nil {
		return core.CandidatePage{}, err
	}
	var result core.CandidatePage
	var refusal *model.Fault
	err = s.reader.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return completion.Capture(func() error {
			if _, err := scope.CredentialDAO().Credential(ctx, p); err != nil {
				if errors.Is(err, model.ErrNotFound) {
					return model.Unauthenticated(err)
				}
				return err
			}
			var err error
			result, err = core.SearchMemberCandidates(ctx, scope.TeamDAO(), p, id, search)
			return err
		}, &refusal)
	})
	if err != nil {
		return core.CandidatePage{}, err
	}
	if refusal != nil {
		return core.CandidatePage{}, refusal
	}
	return result, nil
}
