package identity

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

// UpstreamTimeout is the existing identity claim and discovery timeout.
const UpstreamTimeout = 15 * time.Second

const (
	MaxPATNameCodePoints       = 100
	MaxProfileFieldBytes       = 1024
	MaxAvatarURLBytes          = 512 << 10
	MaxProfileJSONBytes        = 1 << 20
	MaxIdentityResponseBytes   = 2 << 20
	MaxReturnPathBytes         = 4096
	MaxPendingLoginsPerBrowser = 5
	MaxPendingLoginsGlobal     = 10000
)

func admitBytes(field, value string, max int) error {
	if len(value) > max {
		return &limit.Violation{Field: field, Actual: int64(len(value)), Max: int64(max), Unit: "bytes"}
	}
	return nil
}

// AdmitProfileFields checks the profile fields preserved from the identity provider.
// Complete encoded profile capacity is measured separately by the protocol codec.
func AdmitProfileFields(profile model.User) error {
	if err := admitBytes("identityId", profile.UniAuthID, MaxProfileFieldBytes); err != nil {
		return err
	}
	for _, field := range []struct {
		name  string
		value *string
		max   int
	}{
		{"name", profile.Name, MaxProfileFieldBytes}, {"email", profile.Email, MaxProfileFieldBytes}, {"avatarUrl", profile.AvatarURL, MaxAvatarURLBytes},
	} {
		if field.value != nil {
			if err := admitBytes(field.name, *field.value, field.max); err != nil {
				return err
			}
		}
	}
	return nil
}
func AdmitReturnPath(path string) error { return admitBytes("returnPath", path, MaxReturnPathBytes) }
