package identity

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	ExpiresAt, ExpectedExpiresAt *time.Time
	ExpectedUserID               string
}

func equalTokenExpiry(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}
func ValidateUpdatePATExpiry(p model.Principal, id string, input UpdatePATExpiry, now time.Time) (string, *time.Time, error) {
	if p.Kind != model.SessionCredential {
		return "", nil, forbidden()
	}
	expected, err := model.CanonicalID(input.ExpectedUserID)
	if err != nil {
		return "", nil, err
	}
	if expected != input.ExpectedUserID {
		return "", nil, invalidInput("expectedUserId must be a canonical user UUID")
	}
	if expected != p.UserID {
		return "", nil, &model.Fault{Code: "forbidden", Message: "The signed-in account changed. Review the token again."}
	}
	id, err = model.CanonicalID(id)
	if err != nil {
		return "", nil, err
	}
	expiry, err := validatedTokenExpiry(input.ExpiresAt, now)
	if err != nil {
		return "", nil, err
	}
	return id, expiry, nil
}
func (s *Identity) UpdatePATExpiry(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string, input UpdatePATExpiry, now time.Time) (model.PersonalAccessToken, error) {
	id, expiry, err := ValidateUpdatePATExpiry(p, id, input, now)
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	result, conflict, err := s.ComparePATExpiry(ctx, dao, p, id, expiry, input.ExpectedExpiresAt, now)
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
func (s *Identity) ComparePATExpiry(ctx context.Context, dao store.IdentityDAO, p model.Principal, id string, expiry, expected *time.Time, now time.Time) (model.PersonalAccessToken, bool, error) {
	if err := dao.LockSession(ctx, p, now); err != nil {
		return model.PersonalAccessToken{}, false, err
	}
	current, err := dao.LockActivePAT(ctx, p.UserID, id, now)
	if err != nil {
		return model.PersonalAccessToken{}, false, err
	}
	if !equalTokenExpiry(current.ExpiresAt, expected) {
		return model.PersonalAccessToken{}, true, nil
	}
	if equalTokenExpiry(current.ExpiresAt, expiry) {
		return current, false, nil
	}
	result, err := dao.SetPATExpiry(ctx, id, expiry)
	return result, false, err
}
