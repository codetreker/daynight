package core

import "time"

type ProjectRole string

const (
	ProjectAdmin      ProjectRole = "admin"
	ProjectMemberRole ProjectRole = "member"
)

type ProjectGrant struct {
	ProjectID string
	UserID    string
	Role      ProjectRole
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type ProjectMember struct {
	Grant     ProjectGrant
	Email     *string
	Name      *string
	AvatarURL *string
}

type ProjectParticipantProfile struct {
	Name      *string
	Email     *string
	AvatarURL *string
}

type ProjectParticipant struct {
	UserID        string
	Profile       ProjectParticipantProfile
	EffectiveRole ProjectRole
	DirectGrant   *ProjectGrant
}

type ProjectAccess struct {
	ProjectID   string
	UserID      string
	Role        ProjectRole
	DirectGrant *ProjectGrant
}

type ProjectInvitation struct {
	ID         string
	ProjectID  string
	CreatedBy  string
	TokenHash  []byte
	CreatedAt  time.Time
	ExpiresAt  time.Time
	ConsumedBy *string
	ConsumedAt *time.Time
	RevokedAt  *time.Time
}
