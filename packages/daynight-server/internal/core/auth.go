package core

import "time"

type CredentialKind string

const (
	SessionCredential CredentialKind = "session"
	PATCredential     CredentialKind = "pat"
)

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
}

type LoginTransaction struct {
	ID                 string
	StateHash          []byte
	BrowserBindingHash []byte
	Provider           string
	ReturnPath         string
	ExpiresAt          time.Time
}

type Session struct {
	ID        string
	UserID    string
	TokenHash []byte
	CreatedAt time.Time
	ExpiresAt time.Time
}

type PersonalAccessToken struct {
	ID        string
	UserID    string
	TokenHash []byte
	Name      string
	CreatedAt time.Time
	ExpiresAt *time.Time
}
