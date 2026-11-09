package team

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// BootstrapPersonalTeam creates the personal team and its sole owner, or
// validates the existing team's invariant, within the caller's transaction.
func BootstrapPersonalTeam(ctx context.Context, dao store.PersonalTeamDAO, userID string, now time.Time) (model.TeamRef, error) {
	id := uuid.NewString()
	created, err := dao.InsertPersonalTeam(ctx, id, userID, now)
	if err != nil {
		return model.TeamRef{}, err
	}
	if created {
		if err := dao.InsertPersonalOwner(ctx, id, userID, now); err != nil {
			return model.TeamRef{}, err
		}
	} else {
		facts, err := dao.PersonalTeam(ctx, userID)
		if err != nil {
			return model.TeamRef{}, err
		}
		if err := ValidatePersonalTeam(facts); err != nil {
			return model.TeamRef{}, err
		}
		id = facts.ID
	}
	return model.TeamRef{ID: id, Kind: "personal"}, nil
}

// ValidatePersonalTeam checks the invariants shared by login and account reads.
func ValidatePersonalTeam(facts store.PersonalTeamFacts) error {
	if facts.ID == "" {
		return errors.New("user Personal Team is missing")
	}
	if facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
		return errors.New("Personal Team owner membership is invalid")
	}
	return nil
}
