package api

// AddExistingTeamMemberRequest identifies the authenticated actor.
type AddExistingTeamMemberRequest struct {
	ExpectedUserID string `json:"expectedUserId"`
}

// AddExistingTeamMemberReceipt includes the current persisted profile and membership.
type AddExistingTeamMemberReceipt struct {
	Membership TeamMemberWithProfile `json:"membership"`
	Added      bool                  `json:"added"`
	ActorRole  string                `json:"actorRole"`
}
