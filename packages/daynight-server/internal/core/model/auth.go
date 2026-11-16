package model

import "time"

type CredentialKind string

const (
	SessionCredential CredentialKind = "session"
	PATCredential     CredentialKind = "pat"
	OAuthCredential   CredentialKind = "oauth"
)

const OAuthAccessPrefix = "dnmcp_"

type Principal struct {
	UserID       string
	CredentialID string
	Kind         CredentialKind
}

type User struct {
	ID            string
	UniAuthID     string
	Email         *string
	EmailVerified *bool
	Name          *string
	AvatarURL     *string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	PersonalTeam  TeamRef
}

type ProfileField struct {
	Present bool
	Value   *string
}

type UserProfilePatch struct {
	Name      ProfileField
	AvatarURL ProfileField
}

type LoginTransaction struct {
	ID                 string
	StateHash          []byte
	BrowserBindingHash []byte
	ScopeHash          []byte
	Provider           string
	ReturnPath         string
	ExpiresAt          time.Time
}

type Session struct {
	ID               string
	UserID           string
	TokenHash        []byte
	PreviewTokenHash []byte
	CreatedAt        time.Time
	ExpiresAt        time.Time
}

type PersonalAccessToken struct {
	ID         string
	UserID     string
	TokenHash  []byte
	Name       string
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
}

// PreviewSSOLogin stores only hashes of transient SSO secrets.
type PreviewSSOLogin struct {
	ID        string
	ReturnURL string
	StateHash []byte
	CodeHash  []byte
	SessionID string
	ExpiresAt time.Time
}
