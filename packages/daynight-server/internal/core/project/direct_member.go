package project

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type ExistingMemberResult struct {
	Added       bool
	Participant model.ProjectParticipant
	ActorAccess model.ProjectAccess
}

func ValidateExistingMember(p model.Principal, projectID, target, expected string) (string, string, error) {
	if expected == uuid.Nil.String() {
		return "", "", invalidInput("expectedUserId must be a nonzero UUID")
	}
	if err := ValidateMemberActor(p, expected); err != nil {
		return "", "", err
	}
	id, err := ValidateRead(p, projectID)
	if err != nil {
		return "", "", err
	}
	if id != projectID || id == uuid.Nil.String() {
		return "", "", invalidInput("projectId must be a canonical UUID")
	}
	user, err := model.CanonicalID(target)
	if err != nil {
		return "", "", err
	}
	if user != target || user == uuid.Nil.String() {
		return "", "", invalidInput("userId must be a canonical UUID")
	}
	return id, user, nil
}

func AddExistingMember(ctx context.Context, dao store.ProjectWriteDAO, member store.ProjectDirectMemberDAO, p model.Principal, target string) (ExistingMemberResult, error) {
	var result ExistingMemberResult
	access, err := RequireProjectWrite(ctx, dao, p)
	if err != nil {
		return result, err
	}
	if err = RequireProjectAdmin(access); err != nil {
		return result, err
	}
	if err = member.LockUser(ctx, target); errors.Is(err, model.ErrNotFound) {
		return result, &model.Fault{Code: "user_not_found", Message: "The user account was not found.", Cause: err}
	} else if err != nil {
		return result, err
	}
	participant, err := member.Participant(ctx, target)
	if errors.Is(err, model.ErrNotFound) {
		if _, err = dao.CreateGrant(ctx, target, model.ProjectMemberRole); err != nil {
			return result, err
		}
		result.Added = true
		participant, err = member.Participant(ctx, target)
	}
	if err != nil {
		return ExistingMemberResult{}, err
	}
	result.Participant, result.ActorAccess = participant, access
	return result, nil
}
