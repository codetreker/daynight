package identity

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialdescription"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func ValidatePATOwner(p model.Principal, expectedUserID string) error {
	if err := ValidateSession(p); err != nil {
		return err
	}
	canonical, err := model.CanonicalID(expectedUserID)
	if err != nil || canonical != expectedUserID {
		return invalidInput("expectedUserId must be a canonical user UUID")
	}
	if canonical != p.UserID {
		return &model.Fault{Code: "forbidden", Message: "The signed-in account changed. Review the token again."}
	}
	return nil
}

func checkPATSession(ctx context.Context, dao store.IdentityDAO, management store.PATManagementDAO, p model.Principal, now time.Time) error {
	fresh, err := management.FreshPATTime(ctx, now)
	if err != nil {
		return err
	}
	return authLookupError(dao.LockSession(ctx, p, fresh))
}

func (s *Identity) CreatePATV2(ctx context.Context, dao store.IdentityDAO, management store.PATManagementDAO, p model.Principal, expectedUserID string, input CreatePAT, description *string, now time.Time) (MintedPAT, error) {
	if err := ValidatePATOwner(p, expectedUserID); err != nil {
		return MintedPAT{}, err
	}
	value, err := credentialdescription.Normalize(description)
	if err != nil {
		return MintedPAT{}, invalidInput("Invalid credential description.")
	}
	result, err := s.createPAT(ctx, dao, p, input, value, now)
	if err != nil {
		return MintedPAT{}, err
	}
	if err := checkPATSession(ctx, dao, management, p, now); err != nil {
		return MintedPAT{}, err
	}
	return result, nil
}

func (s *Identity) ListPATsV2(ctx context.Context, dao store.IdentityDAO, management store.PATManagementDAO, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
	if err := ValidateSession(p); err != nil {
		return nil, err
	}
	if err := authLookupError(dao.LockSession(ctx, p, now)); err != nil {
		return nil, err
	}
	items, err := management.ListAllPATs(ctx, p.UserID)
	if err != nil {
		return nil, err
	}
	if err := checkPATSession(ctx, dao, management, p, now); err != nil {
		return nil, err
	}
	return items, nil
}

func (s *Identity) UpdatePATDescription(ctx context.Context, dao store.IdentityDAO, management store.PATManagementDAO, p model.Principal, id, expectedUserID string, expected, description *string, now time.Time) (string, *string, error) {
	if err := ValidatePATOwner(p, expectedUserID); err != nil {
		return "", nil, err
	}
	id, err := model.CanonicalID(id)
	if err != nil {
		return "", nil, err
	}
	if err := credentialdescription.ValidateExpected(expected); err != nil {
		return "", nil, invalidInput("Invalid expected credential description.")
	}
	value, err := credentialdescription.Normalize(description)
	if err != nil {
		return "", nil, invalidInput("Invalid credential description.")
	}
	if err := authLookupError(dao.LockSession(ctx, p, now)); err != nil {
		return "", nil, err
	}
	changed, err := management.ComparePATDescription(ctx, p.UserID, id, expected, value)
	if err != nil {
		return "", nil, err
	}
	var exists bool
	if !changed {
		exists, err = management.PATExists(ctx, p.UserID, id)
		if err != nil {
			return "", nil, err
		}
	}
	if err := checkPATSession(ctx, dao, management, p, now); err != nil {
		return "", nil, err
	}
	if !changed {
		if !exists {
			return "", nil, &model.Fault{Code: "not_found", Message: "Token was not found."}
		}
		return "", nil, &model.Fault{Code: "version_conflict", Message: "Token description changed. Read the current token before trying again."}
	}
	return id, value, nil
}
