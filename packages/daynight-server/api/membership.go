package api

import "time"

type ProjectMember struct {
	ProjectID string    `json:"projectId"`
	UserID    string    `json:"userId"`
	Email     *string   `json:"email"`
	Name      *string   `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ProjectParticipantProfile struct {
	Name      *string `json:"name"`
	Email     *string `json:"email"`
	AvatarURL *string `json:"avatarUrl"`
}

type ProjectParticipant struct {
	UserID        string                    `json:"userId"`
	Profile       ProjectParticipantProfile `json:"profile"`
	EffectiveRole string                    `json:"effectiveRole"`
	DirectGrant   *ProjectGrant             `json:"directGrant"`
	InheritedFrom *ProjectInheritance       `json:"inheritedFrom"`
}

type ProjectParticipantList struct {
	Items       []ProjectParticipant `json:"items"`
	ActorAccess ProjectAccess        `json:"actorAccess"`
}

type SetProjectMemberRoleRequest struct {
	Version        int64  `json:"version"`
	Role           string `json:"role"`
	ExpectedUserID string `json:"expectedUserId"`
}

type RemoveProjectMemberRequest struct {
	Version        int64  `json:"version"`
	ExpectedUserID string `json:"expectedUserId"`
}

type ProjectInvitation struct {
	ID         string     `json:"id"`
	ProjectID  string     `json:"projectId"`
	CreatedBy  string     `json:"createdBy"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  time.Time  `json:"expiresAt"`
	ConsumedBy *string    `json:"consumedBy"`
	ConsumedAt *time.Time `json:"consumedAt"`
	RevokedAt  *time.Time `json:"revokedAt"`
}

type ProjectInvitationList struct {
	Items []ProjectInvitation `json:"items"`
}

type CreatedProjectInvitation struct {
	ProjectInvitation
	Link string `json:"link"`
}

type InspectProjectInvitationRequest struct {
	Token string `json:"token"`
}

type AcceptProjectInvitationRequest struct {
	Token          string `json:"token"`
	ExpectedUserID string `json:"expectedUserId"`
}

type ProjectInvitationMutationRequest struct {
	ExpectedUserID string `json:"expectedUserId"`
}

type ProjectInvitationInspection struct {
	ProjectID   string         `json:"projectId"`
	ProjectName string         `json:"projectName"`
	DirectGrant *ProjectGrant  `json:"directGrant"`
	Access      *ProjectAccess `json:"access"`
}

type ProjectInvitationAcceptance struct {
	ProjectID   string        `json:"projectId"`
	DirectGrant ProjectGrant  `json:"directGrant"`
	Access      ProjectAccess `json:"access"`
	Joined      bool          `json:"joined"`
	Consumed    bool          `json:"consumed"`
}
