package project

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"math"
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
func ValidateTransferPreview(p model.Principal, id, target string) (string, string, error) {
	id, err := ValidateRead(p, id)
	if err != nil {
		return "", "", err
	}
	target, err = team.CanonicalID(target)
	return id, target, err
}
func TransferPreviewFor(ctx context.Context, dao store.ProjectReader, p model.Principal, id, target string) (TransferPreview, error) {
	access, err := RequireProjectRead(ctx, dao, p, id)
	if err != nil {
		return TransferPreview{}, err
	}
	if err = requireTransferAdmin(access); err != nil {
		return TransferPreview{}, err
	}
	targetTeam, err := dao.TransferTeam(ctx, target)
	if errors.Is(err, model.ErrNotFound) {
		return TransferPreview{}, &model.Fault{Code: "not_found", Message: "Target Team was not found.", Cause: err}
	}
	if err != nil {
		return TransferPreview{}, err
	}
	role, err := dao.TransferRole(ctx, p.UserID, id, target)
	if err != nil {
		return TransferPreview{}, err
	}
	return TransferPreview{SourceTeam: access.OwnerTeam, TargetTeam: targetTeam.Ref, Ownership: access.Ownership, TargetTeamVersion: targetTeam.Version, ActorRole: role}, nil
}
func ValidateTransfer(p model.Principal, id string, input TransferInput) (string, string, string, error) {
	if err := team.RequireActor(p, input.ExpectedUserID); err != nil {
		return "", "", "", err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return "", "", "", err
	}
	source, err := team.CanonicalID(input.Ownership.TeamID)
	if err != nil {
		return "", "", "", err
	}
	target, err := team.CanonicalID(input.TargetTeam.ID)
	if err != nil {
		return "", "", "", err
	}
	if input.Ownership.Version < 1 || input.TargetTeam.Version < 1 {
		return "", "", "", invalidInput("Versions must be positive integers.")
	}
	return id, source, target, nil
}
func Transfer(ctx context.Context, dao store.ProjectWriteDAO, p model.Principal, id, source, target string, input TransferInput) (TransferReceipt, error) {
	ownership, err := dao.LockTransferOwnership(ctx)
	if err != nil {
		return TransferReceipt{}, err
	}
	sourceTeam, targetTeam, err := dao.LockTransferTeams(ctx, ownership.TeamID, target)
	if err != nil {
		return TransferReceipt{}, err
	}
	access, err := RequireProjectWrite(ctx, dao, p)
	if err != nil {
		return TransferReceipt{}, err
	}
	if err = requireTransferAdmin(access); err != nil {
		return TransferReceipt{}, err
	}
	if ownership.TeamID != source || ownership.Version != input.Ownership.Version {
		return TransferReceipt{}, &model.Fault{Code: "version_conflict", Message: "Project ownership has changed."}
	}
	if targetTeam.Ref.ID == "" {
		return TransferReceipt{}, &model.Fault{Code: "not_found", Message: "Target Team was not found."}
	}
	if targetTeam.Version != input.TargetTeam.Version {
		return TransferReceipt{}, &model.Fault{Code: "version_conflict", Message: "Target Team has changed."}
	}
	changed := ownership.TeamID != target
	if changed {
		if ownership.Version == math.MaxInt64 {
			return TransferReceipt{}, &model.Fault{Code: "version_exhausted", Message: "Project ownership version is exhausted."}
		}
		ownership, err = dao.MoveOwnership(ctx, target)
		if err != nil {
			return TransferReceipt{}, err
		}
	}
	current, err := dao.ProjectAccess(ctx, p)
	var actorAccess *model.ProjectAccess
	if err == nil {
		actorAccess = &current
	} else if !errors.Is(err, model.ErrNotFound) {
		return TransferReceipt{}, err
	}
	return TransferReceipt{ProjectID: id, Changed: changed, SourceTeam: sourceTeam.Ref, OwnerTeam: targetTeam.Ref, Ownership: ownership, ActorAccess: actorAccess}, nil
}
