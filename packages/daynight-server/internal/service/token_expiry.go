package service

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
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

func (s *Identity) UpdatePATExpiry(ctx context.Context, p core.Principal, id string, input UpdatePATExpiry) (core.PersonalAccessToken, error) {
	if p.Kind != core.SessionCredential {
		return core.PersonalAccessToken{}, forbidden()
	}
	expected, err := CanonicalID(input.ExpectedUserID)
	if err != nil {
		return core.PersonalAccessToken{}, err
	}
	if expected != input.ExpectedUserID {
		return core.PersonalAccessToken{}, invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != p.UserID {
		return core.PersonalAccessToken{}, &Fault{Code: "forbidden", Message: "The signed-in account changed. Review the token again."}
	}
	id, err = CanonicalID(id)
	if err != nil {
		return core.PersonalAccessToken{}, err
	}
	now := s.now().UTC()
	expiry, err := validatedTokenExpiry(input.ExpiresAt, now)
	if err != nil {
		return core.PersonalAccessToken{}, err
	}
	result, conflict, err := s.store.UpdatePATExpiry(ctx, p, id, expiry, input.ExpectedExpiresAt, now)
	if errors.Is(err, core.ErrNotFound) {
		return core.PersonalAccessToken{}, &Fault{Code: "not_found", Message: "Active token was not found.", Cause: err}
	}
	if err != nil {
		return core.PersonalAccessToken{}, err
	}
	if conflict {
		return core.PersonalAccessToken{}, &Fault{Code: "version_conflict", Message: "Token expiration changed. Read the current token before trying again."}
	}
	return result, nil
}
