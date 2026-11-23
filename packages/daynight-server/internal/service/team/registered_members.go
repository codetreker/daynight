package team

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

// AddExistingMember adds an existing account without initializing an identity.
func (s *DirectMembers) AddExistingMember(ctx context.Context, p model.Principal, id, target, expected string) (core.ExistingMemberResult, error) {
	id, err := s.ops.validateExisting(p, id, expected, target)
	if err != nil {
		return core.ExistingMemberResult{}, err
	}
	var result core.ExistingMemberResult
	err = s.strict(ctx, id, func(scope store.TeamWriteScope) error {
		ctx := s.admission.writeContext(ctx, scope)
		if err := s.lockCredential(ctx, scope, p); err != nil {
			return err
		}
		var err error
		result, err = s.ops.addExisting(ctx, scope.TeamDAO(), p, target)
		if err != nil {
			return err
		}
		if err := s.ops.eligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, UserID: target}); err != nil {
			return err
		}
		// Contention may outlast the initial credential check.
		if err := s.lockCredential(ctx, scope, p); err != nil {
			return err
		}
		return s.admission.requireWrite(ctx, scope, p, scopepolicy.TeamMembers, scopepolicy.TeamRead)
	})
	if err != nil {
		return core.ExistingMemberResult{}, err
	}
	return result, nil
}
