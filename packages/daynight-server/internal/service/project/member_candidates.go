package project

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

// SearchMemberCandidates publishes directory data only after the credential and Project authorization snapshot completes.
func (s *Memberships) SearchMemberCandidates(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput) (core.CandidatePage, error) {
	return s.searchMemberCandidates(ctx, p, id, input, nil)
}

func (s *Memberships) searchMemberCandidates(ctx context.Context, p model.Principal, id string, input core.CandidateSearchInput, admit func(context.Context, store.SnapshotScope) error) (core.CandidatePage, error) {
	id, search, err := core.ValidateCandidateSearch(p, id, input)
	if err != nil {
		return core.CandidatePage{}, err
	}
	var result core.CandidatePage
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		return completion.Capture(func() error {
			if _, err := scope.CredentialDAO().Credential(ctx, p); err != nil {
				if errors.Is(err, model.ErrNotFound) {
					return model.Unauthenticated(err)
				}
				return err
			}
			if admit != nil {
				access, err := core.RequireProjectRead(ctx, scope.ProjectDAO(), p, id)
				if err != nil {
					return err
				}
				if err := core.RequireProjectAdmin(access); err != nil {
					return err
				}
				if err := admit(ctx, scope); err != nil {
					return err
				}
			}
			var err error
			result, err = core.SearchMemberCandidates(ctx, scope.ProjectDAO(), scope.UserCandidateDAO(), p, id, search)
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
