package api

import (
	"time"

	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
)

type User = profileprotocol.Response

type PersonalAccessToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
}

type PersonalAccessTokenList struct {
	Items []PersonalAccessToken `json:"items"`
}

type CreatedPersonalAccessToken struct {
	PersonalAccessToken
	Token string `json:"token"`
}

type CreatePersonalAccessTokenRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type UpdatePersonalAccessTokenRequest struct {
	ExpiresAt         *time.Time `json:"expiresAt"`
	ExpectedExpiresAt *time.Time `json:"expectedExpiresAt"`
	ExpectedUserID    string     `json:"expectedUserId"`
}

// ExternalUserInput identifies one upstream account and its optional initial profile.
type ExternalUserInput struct {
	ExternalUserID string               `json:"externalUserId"`
	Profile        *ExternalUserProfile `json:"profile,omitempty"`
}

type ExternalUserProfile struct {
	Name      *string `json:"name,omitempty"`
	AvatarURL *string `json:"avatarUrl,omitempty"`
}
