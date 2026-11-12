package auth

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

func decodeProfilePatch(fields map[string]json.RawMessage, requireMutation bool) (model.UserProfilePatch, error) {
	if requireMutation && len(fields) == 0 {
		return model.UserProfilePatch{}, httpx.InvalidInput("at least one profile field is required")
	}
	var patch model.UserProfilePatch
	for _, field := range []struct {
		name   string
		target *model.ProfileField
	}{{"name", &patch.Name}, {"avatarUrl", &patch.AvatarURL}} {
		raw, present := fields[field.name]
		if !present {
			continue
		}
		if !jsonunicode.Valid(raw) {
			return model.UserProfilePatch{}, httpx.InvalidInput(field.name + " must contain valid Unicode")
		}
		var value *string
		if err := json.Unmarshal(raw, &value); err != nil {
			return model.UserProfilePatch{}, httpx.InvalidInput(field.name + " must be a string or null")
		}
		*field.target = model.ProfileField{Present: true, Value: value}
	}
	if len(fields) == 0 {
		return patch, nil
	}
	if err := identitycore.ValidateProfilePatch(patch); err != nil {
		return model.UserProfilePatch{}, err
	}
	return patch, nil
}

// DecodeExternalUserInput preserves the strict JSON contract shared by issuer and membership requests.
func DecodeExternalUserInput(raw []byte) (api.ExternalUserInput, error) {
	if !jsonunicode.Valid(raw) {
		return api.ExternalUserInput{}, httpx.InvalidInput("user must contain valid Unicode")
	}
	fields, err := jsonobject.Decode(raw, "user", "externalUserId", "profile")
	if err != nil {
		return api.ExternalUserInput{}, httpx.InvalidInput(err.Error())
	}
	externalID, err := httpx.RequiredString(fields, "externalUserId")
	if err != nil {
		return api.ExternalUserInput{}, err
	}
	result := api.ExternalUserInput{ExternalUserID: externalID}
	if profile, exists := fields["profile"]; exists {
		profileFields, err := jsonobject.Decode(profile, "profile", "name", "avatarUrl")
		if err != nil {
			return api.ExternalUserInput{}, httpx.InvalidInput(err.Error())
		}
		patch, err := decodeProfilePatch(profileFields, false)
		if err != nil {
			return api.ExternalUserInput{}, err
		}
		result.Profile = &api.ExternalUserProfile{Name: patch.Name.Value, AvatarURL: patch.AvatarURL.Value}
	}
	user, err := ExternalUser(result)
	if err != nil {
		return api.ExternalUserInput{}, err
	}
	result.ExternalUserID = user.UniAuthID
	return result, nil
}

func ExternalUser(input api.ExternalUserInput) (model.User, error) {
	user := model.User{UniAuthID: input.ExternalUserID}
	if input.Profile != nil {
		user.Name = input.Profile.Name
		user.AvatarURL = input.Profile.AvatarURL
	}
	return identitycore.ValidateExternalUser(user)
}
