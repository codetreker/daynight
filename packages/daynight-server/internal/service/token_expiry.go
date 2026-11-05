package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func validatedTokenExpiry(value *time.Time, now time.Time) (*time.Time, error) {
	if value == nil {
		return nil, nil
	}
	expiry := value.UTC().Truncate(time.Microsecond)
	if !expiry.After(now) {
		return nil, invalidInput("Token expiration must be in the future or null for no expiration.")
	}
	return &expiry, nil
}

type UpdatePATExpiry struct {
	ExpiresAt         *time.Time
	ExpectedExpiresAt *time.Time
	ExpectedUserID    string
}

func (s *Identity) UpdatePATExpiry(ctx context.Context, p model.Principal, id string, input UpdatePATExpiry) (model.PersonalAccessToken, error) {
	if p.Kind != model.SessionCredential {
		return model.PersonalAccessToken{}, forbidden()
	}
	expected, err := CanonicalID(input.ExpectedUserID)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	if expected != input.ExpectedUserID {
		return model.PersonalAccessToken{}, invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != p.UserID {
		return model.PersonalAccessToken{}, &model.Fault{Code: "forbidden", Message: "The signed-in account changed. Review the token again."}
	}
	id, err = CanonicalID(id)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	now := s.now().UTC()
	expiry, err := validatedTokenExpiry(input.ExpiresAt, now)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	result, conflict, err := s.store.UpdatePATExpiry(ctx, p, id, expiry, input.ExpectedExpiresAt, now)
	if errors.Is(err, model.ErrNotFound) {
		return model.PersonalAccessToken{}, &model.Fault{Code: "not_found", Message: "Active token was not found.", Cause: err}
	}
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	if conflict {
		return model.PersonalAccessToken{}, &model.Fault{Code: "version_conflict", Message: "Token expiration changed. Read the current token before trying again."}
	}
	return result, nil
}
