package api

import "time"

type TeamMember struct {
	TeamID    string    `json:"teamId"`
	UserID    string    `json:"userId"`
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Team struct {
	TeamRef
	Version    int64      `json:"version"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	Membership TeamMember `json:"membership"`
}

type TeamPage struct {
	Items      []Team  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type CreateTeamRequest struct {
	Name           string `json:"name"`
	ExpectedUserID string `json:"expectedUserId"`
}

type ChangeTeamRequest struct {
	Name           string `json:"name"`
	Version        int64  `json:"version"`
	ExpectedUserID string `json:"expectedUserId"`
}

type DeleteTeamReceipt struct {
	TeamID  string `json:"teamId"`
	Deleted bool   `json:"deleted"`
}

type TeamInvitation struct {
	ID         string     `json:"id"`
	TeamID     string     `json:"teamId"`
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	ConsumedBy *string    `json:"consumedBy"`
	ConsumedAt *time.Time `json:"consumedAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
}
type TeamInvitationList struct {
	Items []TeamInvitation `json:"items"`
}
type CreatedTeamInvitation struct {
	TeamInvitation
	Link string `json:"link"`
}
type TeamInvitationInspection struct {
	Team       TeamRef     `json:"team"`
	Membership *TeamMember `json:"membership"`
}
type TeamInvitationAcceptance struct {
	Team       TeamRef    `json:"team"`
	Membership TeamMember `json:"membership"`
	Joined     bool       `json:"joined"`
	Consumed   bool       `json:"consumed"`
}

type TeamMemberWithProfile struct {
	TeamMember
	Profile ProjectParticipantProfile `json:"profile"`
}

type TeamMemberList struct {
	Items []TeamMemberWithProfile `json:"items"`
}

type AddTeamMemberRequest struct {
	ExpectedUserID string            `json:"expectedUserId"`
	User           ExternalUserInput `json:"user"`
	Role           string            `json:"role"`
}

type AddTeamMemberReceipt struct {
	Membership TeamMember `json:"membership"`
	Added      bool       `json:"added"`
	ActorRole  string     `json:"actorRole"`
}

type ResolveTeamMemberUser struct {
	ExternalUserID string `json:"externalUserId"`
}

type ResolveTeamMemberRequest struct {
	ExpectedUserID string                `json:"expectedUserId"`
	User           ResolveTeamMemberUser `json:"user"`
}

type ResolveTeamMemberResponse struct {
	Membership *TeamMember `json:"membership"`
	ActorRole  string      `json:"actorRole"`
}

type SetTeamMemberRoleRequest struct {
	Version        int64  `json:"version"`
	Role           string `json:"role"`
	ExpectedUserID string `json:"expectedUserId"`
}

type RemoveTeamMemberRequest struct {
	Version        int64  `json:"version"`
	ExpectedUserID string `json:"expectedUserId"`
}

type TeamMemberRoleReceipt struct {
	Membership TeamMember `json:"membership"`
	ActorRole  *string    `json:"actorRole"`
}

type RemoveTeamMemberReceipt struct {
	TeamID    string  `json:"teamId"`
	UserID    string  `json:"userId"`
	Removed   bool    `json:"removed"`
	ActorRole *string `json:"actorRole"`
}
