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
