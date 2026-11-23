package api

import "time"

type GitHubAppAdminMembership struct {
	AppID             string    `json:"appId"`
	UserID            string    `json:"userId"`
	MembershipVersion string    `json:"membershipVersion"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type GitHubAppAdmin struct {
	GitHubAppAdminMembership
	Profile ProjectParticipantProfile `json:"profile"`
}

type GitHubAppAdminPage struct {
	Items      []GitHubAppAdmin `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

type GitHubAppAdminInvitation struct {
	ID                      string     `json:"id"`
	AppID                   string     `json:"appId"`
	CreatedBy               string     `json:"createdBy"`
	IssuerMembershipVersion string     `json:"issuerMembershipVersion"`
	CreatedAt               time.Time  `json:"createdAt"`
	ExpiresAt               time.Time  `json:"expiresAt"`
	RevokedAt               *time.Time `json:"revokedAt"`
	ConsumedAt              *time.Time `json:"consumedAt"`
	ConsumedBy              *string    `json:"consumedBy"`
	Available               bool       `json:"available"`
}

type GitHubAppAdminInvitationPage struct {
	Items      []GitHubAppAdminInvitation `json:"items"`
	NextCursor *string                    `json:"nextCursor"`
}

type CreatedGitHubAppAdminInvitation struct {
	GitHubAppAdminInvitation
	Link string `json:"link"`
}

type GitHubAppAdminRemoval struct {
	AppID        string `json:"appId"`
	UserID       string `json:"userId"`
	Removed      bool   `json:"removed"`
	ActorIsAdmin bool   `json:"actorIsAdmin"`
}

type GitHubAppAdminInvitationRevocation struct {
	AppID        string `json:"appId"`
	InvitationID string `json:"invitationId"`
	Changed      bool   `json:"changed"`
}

type GitHubAppIdentity struct {
	ID          string `json:"id"`
	GitHubAppID string `json:"githubAppId"`
	Name        string `json:"name"`
	GitHubName  string `json:"githubName"`
	GitHubSlug  string `json:"githubSlug"`
}

type GitHubAppAdminInvitationInspection struct {
	App        GitHubAppIdentity         `json:"app"`
	ExpiresAt  time.Time                 `json:"expiresAt"`
	Membership *GitHubAppAdminMembership `json:"membership"`
}

type GitHubAppAdminInvitationAcceptance struct {
	AppID      string                   `json:"appId"`
	Membership GitHubAppAdminMembership `json:"membership"`
	Joined     bool                     `json:"joined"`
}
