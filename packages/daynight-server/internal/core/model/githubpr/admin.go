package githubpr

import "time"

type AppIdentity struct {
	ID                           string
	GitHubAppID                  int64
	Name, GitHubName, GitHubSlug string
}

type AdminMembership struct {
	AppID, UserID        string
	Version              int64
	CreatedAt, UpdatedAt time.Time
}

type AdminProfile struct {
	AdminMembership
	Name, Email, AvatarURL *string
}

// AppInvitation contains management metadata, never its bearer token or hash.
type AppInvitation struct {
	ID, AppID, CreatedBy    string
	IssuerMembershipVersion int64
	CreatedAt, ExpiresAt    time.Time
	RevokedAt, ConsumedAt   *time.Time
	ConsumedBy              *string
	Available               bool
}
