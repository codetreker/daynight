package identity

import (
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	"github.com/google/uuid"
)

func ValidateProfilePatch(patch model.UserProfilePatch) error {
	if !patch.Name.Present && !patch.AvatarURL.Present {
		return invalidInput("At least one profile field is required.")
	}
	for _, field := range []struct {
		name  string
		input model.ProfileField
		max   int
	}{{"name", patch.Name, MaxProfileFieldBytes}, {"avatarUrl", patch.AvatarURL, MaxAvatarURLBytes}} {
		if !field.input.Present && field.input.Value != nil {
			return invalidInput("An omitted profile field cannot contain a value.")
		}
		if field.input.Value != nil {
			if !utf8.ValidString(*field.input.Value) || strings.ContainsRune(*field.input.Value, 0) {
				return invalidInput("Profile fields must contain UTF-8 text without NUL.")
			}
			if err := admitBytes(field.name, *field.input.Value, field.max); err != nil {
				return profileCapacityError(err)
			}
		}
	}
	return nil
}

// ValidateExternalUser admits the shared external identity input before any write.
func ValidateExternalUser(user model.User) (model.User, error) {
	if user.UniAuthID == "" || !utf8.ValidString(user.UniAuthID) || strings.ContainsFunc(user.UniAuthID, unicode.IsControl) {
		return model.User{}, invalidInput("External user ID must be nonempty UTF-8 text without control characters.")
	}
	if err := admitBytes("externalUserId", user.UniAuthID, MaxProfileFieldBytes); err != nil {
		return model.User{}, profileCapacityError(err)
	}
	id, err := CanonicalUniAuthID(user.UniAuthID)
	if err != nil {
		return model.User{}, &model.Fault{Code: "invalid_input", Message: "External user ID is malformed.", Cause: err}
	}
	user.UniAuthID = id
	if user.Email != nil || user.EmailVerified != nil {
		return model.User{}, invalidInput("External user input cannot set email fields.")
	}
	if err := ValidateProfilePatch(model.UserProfilePatch{Name: model.ProfileField{Present: true, Value: user.Name}, AvatarURL: model.ProfileField{Present: true, Value: user.AvatarURL}}); err != nil {
		return model.User{}, err
	}
	if err := AdmitCompleteUser(user, false); err != nil {
		return model.User{}, err
	}
	return user, nil
}

func profileCapacityError(err error) error {
	var violation *limit.Violation
	if errors.As(err, &violation) {
		return &model.Fault{Code: "invalid_input", Message: "User profile exceeds its capacity.", Cause: err}
	}
	return err
}

// AdmitCompleteUser checks the same profile and response codecs used by login and /me.
func AdmitCompleteUser(user model.User, response bool) error {
	if err := AdmitProfileFields(user); err != nil {
		return profileCapacityError(err)
	}
	if _, err := profileprotocol.Encode(io.Discard, profileprotocol.FromUser(user), MaxProfileJSONBytes); err != nil {
		return profileCapacityError(err)
	}
	if response {
		_, err := profileprotocol.EncodeResponse(io.Discard, user, MaxIdentityResponseBytes)
		return profileCapacityError(err)
	}
	return nil
}

func (s *Identity) EnsureUser(ctx context.Context, dao store.IdentityDAO, user model.User, now time.Time) (model.User, bool, error) {
	user, err := ValidateExternalUser(user)
	if err != nil {
		return model.User{}, false, err
	}
	user.ID = uuid.NewString()
	return dao.EnsureUser(ctx, user, now)
}

func (s *Identity) PatchUser(ctx context.Context, dao store.IdentityDAO, userID string, patch model.UserProfilePatch) (model.User, error) {
	if err := ValidateProfilePatch(patch); err != nil {
		return model.User{}, err
	}
	return dao.PatchUser(ctx, userID, patch)
}

// LockProfileCredential retains the native checks and binds API access to its fixed tuple.
func (s *Identity) LockProfileCredential(ctx context.Context, dao store.IdentityDAO, family store.CredentialFamilyDAO, p model.Principal, resource string, now time.Time) error {
	var err error
	switch p.Kind {
	case model.SessionCredential, model.PATCredential:
		err = dao.LockProfileCredential(ctx, p, now)
	case model.OAuthCredential:
		origin, parseErr := url.Parse(resource)
		if parseErr != nil || origin.Path != "/api/v1" || !oauth.ValidAPIOrigin(origin.Scheme+"://"+origin.Host) || origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
			return model.Unauthenticated(parseErr)
		}
		err = family.LockAccess(ctx, p, []store.OAuthBinding{{Resource: resource, Scope: oauth.APIScope, ClientID: oauth.APIClientID}}, now)
	default:
		return model.Unauthenticated(nil)
	}
	return authLookupError(err)
}
