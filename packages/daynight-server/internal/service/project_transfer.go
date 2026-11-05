package service

import (
	"context"
	"errors"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type TeamVersion struct {
	ID      string
	Version int64
}
type TransferInput struct {
	Ownership      model.ProjectOwnership
	TargetTeam     TeamVersion
	ExpectedUserID string
}
type TransferPreview struct {
	SourceTeam, TargetTeam model.TeamRef
	Ownership              model.ProjectOwnership
	TargetTeamVersion      int64
	ActorRole              *model.ProjectRole
}
type TransferReceipt struct {
	ProjectID             string
	Changed               bool
	SourceTeam, OwnerTeam model.TeamRef
	Ownership             model.ProjectOwnership
	ActorAccess           *model.ProjectAccess
}

func requireTransferAdmin(access model.ProjectAccess) error {
	if access.TeamRole == nil || *access.TeamRole != model.ProjectAdmin {
		return &model.Fault{Code: "forbidden", Message: "Owner Team administrator access is required."}
	}
	return nil
}

func (s *Projects) TransferPreview(ctx context.Context, principal model.Principal, projectID, targetTeamID string) (TransferPreview, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return TransferPreview{}, err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return TransferPreview{}, err
	}
	target, err := team.CanonicalID(targetTeamID)
	if err != nil {
		return TransferPreview{}, err
	}
	var result TransferPreview
	var refusal *model.Fault
	err = s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		return completion.Capture(func() error {
			access, err := RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, id)
			if err != nil {
				return err
			}
			if err := requireTransferAdmin(access); err != nil {
				return err
			}
			team, err := snapshot.ProjectDAO().TransferTeam(ctx, target)
			if errors.Is(err, model.ErrNotFound) {
				return &model.Fault{Code: "not_found", Message: "Target Team was not found.", Cause: err}
			}
			if err != nil {
				return err
			}
			role, err := snapshot.ProjectDAO().TransferRole(ctx, principal.UserID, id, target)
			if err != nil {
				return err
			}
			result = TransferPreview{SourceTeam: access.OwnerTeam, TargetTeam: team.Ref, Ownership: access.Ownership, TargetTeamVersion: team.Version, ActorRole: role}
			return nil
		}, &refusal)
	})
	if err != nil {
		return TransferPreview{}, err
	}
	if refusal != nil {
		return TransferPreview{}, refusal
	}
	return result, nil
}

func (s *Projects) Transfer(ctx context.Context, principal model.Principal, projectID string, input TransferInput) (TransferReceipt, error) {
	if err := team.RequireActor(principal, input.ExpectedUserID); err != nil {
		return TransferReceipt{}, err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return TransferReceipt{}, err
	}
	source, err := team.CanonicalID(input.Ownership.TeamID)
	if err != nil {
		return TransferReceipt{}, err
	}
	target, err := team.CanonicalID(input.TargetTeam.ID)
	if err != nil {
		return TransferReceipt{}, err
	}
	if input.Ownership.Version < 1 || input.TargetTeam.Version < 1 {
		return TransferReceipt{}, invalidInput("Versions must be positive integers.")
	}
	var result TransferReceipt
	err = s.store.WriteProject(ctx, id, func(tx *store.ProjectTx) error {
		ownership, err := tx.LockTransferOwnership(ctx)
		if err != nil {
			return err
		}
		sourceTeam, targetTeam, err := tx.LockTransferTeams(ctx, ownership.TeamID, target)
		if err != nil {
			return err
		}
		access, err := RequireProjectWrite(ctx, tx, principal)
		if err != nil {
			return err
		}
		if err := requireTransferAdmin(access); err != nil {
			return err
		}
		if ownership.TeamID != source || ownership.Version != input.Ownership.Version {
			return &model.Fault{Code: "version_conflict", Message: "Project ownership has changed."}
		}
		if targetTeam.Ref.ID == "" {
			return &model.Fault{Code: "not_found", Message: "Target Team was not found."}
		}
		if targetTeam.Version != input.TargetTeam.Version {
			return &model.Fault{Code: "version_conflict", Message: "Target Team has changed."}
		}
		changed := ownership.TeamID != target
		if changed {
			if ownership.Version == math.MaxInt64 {
				return &model.Fault{Code: "version_exhausted", Message: "Project ownership version is exhausted."}
			}
			ownership, err = tx.MoveOwnership(ctx, target)
			if err != nil {
				return err
			}
		}
		current, err := tx.ProjectAccess(ctx, principal)
		var actorAccess *model.ProjectAccess
		if err == nil {
			actorAccess = &current
		} else if !errors.Is(err, model.ErrNotFound) {
			return err
		}
		result = TransferReceipt{ProjectID: id, Changed: changed, SourceTeam: sourceTeam.Ref, OwnerTeam: targetTeam.Ref, Ownership: ownership, ActorAccess: actorAccess}
		return nil
	})
	if err != nil {
		return TransferReceipt{}, err
	}
	return result, nil
}
