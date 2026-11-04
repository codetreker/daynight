package service

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type SetProjectGrant struct {
	Version        *int64
	Role           core.ProjectRole
	ExpectedUserID string
}

type SetGrantResult struct {
	Grant       core.ProjectGrant
	ActorAccess *core.ProjectAccess
}

type RemoveGrantResult struct {
	ProjectID   string
	UserID      string
	ActorAccess *core.ProjectAccess
}

func grantConflict() error {
	return &Fault{Code: "version_conflict", Message: "Project grant version does not match."}
}

// actorGrantAccess is read in the write transaction, after the mutation. Loss
// of all access is an expected result, while integrity and query errors remain failures.
func actorGrantAccess(ctx context.Context, tx *store.ProjectTx, principal core.Principal) (*core.ProjectAccess, error) {
	access, err := tx.ProjectAccess(ctx, principal)
	if errors.Is(err, core.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &access, nil
}

func (s *Memberships) SetGrant(ctx context.Context, principal core.Principal, projectID, userID string, input SetProjectGrant) (SetGrantResult, error) {
	if err := requirePrincipal(principal); err != nil {
		return SetGrantResult{}, err
	}
	if err := requireMembershipActor(principal, input.ExpectedUserID); err != nil {
		return SetGrantResult{}, err
	}
	id, err := CanonicalID(userID)
	if err != nil {
		return SetGrantResult{}, err
	}
	if input.Version != nil && *input.Version < 1 {
		return SetGrantResult{}, invalidInput("Version must be null or a positive integer.")
	}
	if input.Role != core.ProjectAdmin && input.Role != core.ProjectMemberRole {
		return SetGrantResult{}, invalidInput("Role must be admin or member.")
	}
	var result SetGrantResult
	err = s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error {
		grant, err := tx.DirectGrant(ctx, id)
		if err != nil && !errors.Is(err, core.ErrNotFound) {
			return err
		}
		exists := err == nil
		if input.Version == nil {
			if exists {
				return grantConflict()
			}
			// Only an existing participant can receive a new direct grant.
			if _, err := tx.ProjectAccess(ctx, core.Principal{UserID: id}); err != nil {
				if errors.Is(err, core.ErrNotFound) {
					return &Fault{Code: "not_found", Message: "Project participant was not found.", Cause: err}
				}
				return err
			}
			grant, err = tx.CreateGrant(ctx, id, input.Role)
		} else {
			if !exists || grant.Version != *input.Version {
				return grantConflict()
			}
			if grant.Role != input.Role {
				member, updateErr := tx.SetMemberRole(ctx, id, input.Role)
				grant, err = member.Grant, updateErr
			}
		}
		if err != nil {
			return err
		}
		result.Grant = grant
		result.ActorAccess, err = actorGrantAccess(ctx, tx, principal)
		return err
	})
	return result, err
}

func (s *Memberships) RemoveGrant(ctx context.Context, principal core.Principal, projectID, userID string, input RemoveProjectMember) (RemoveGrantResult, error) {
	if err := requirePrincipal(principal); err != nil {
		return RemoveGrantResult{}, err
	}
	if err := requireMembershipActor(principal, input.ExpectedUserID); err != nil {
		return RemoveGrantResult{}, err
	}
	id, err := validateMemberMutation(userID, input.Version)
	if err != nil {
		return RemoveGrantResult{}, err
	}
	projectID, err = CanonicalID(projectID)
	if err != nil {
		return RemoveGrantResult{}, err
	}
	result := RemoveGrantResult{ProjectID: projectID, UserID: id}
	err = s.write(ctx, principal, projectID, func(tx *store.ProjectTx) error {
		grant, err := tx.DirectGrant(ctx, id)
		if err != nil && !errors.Is(err, core.ErrNotFound) {
			return err
		}
		if err != nil || grant.Version != input.Version {
			return grantConflict()
		}
		if err := tx.RemoveMember(ctx, id); err != nil {
			return err
		}
		result.ActorAccess, err = actorGrantAccess(ctx, tx, principal)
		return err
	})
	return result, err
}
