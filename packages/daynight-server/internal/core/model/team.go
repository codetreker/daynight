package model

import "time"

type TeamMember struct {
	TeamID    string
	UserID    string
	Role      ProjectRole
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Team struct {
	TeamRef
	Version    int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Membership TeamMember
}

type TeamInvitation struct {
	ID, TeamID, CreatedBy string
	TokenHash             []byte
	CreatedAt, ExpiresAt  time.Time
	ConsumedBy            *string
	ConsumedAt, RevokedAt *time.Time
}

type TeamMemberProfile struct {
	Membership TeamMember
	Profile    ProjectParticipantProfile
}
