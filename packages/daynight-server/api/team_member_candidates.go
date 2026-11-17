package api

type TeamMemberCandidateSearchRequest struct {
	ExpectedUserID string  `json:"expectedUserId"`
	Query          string  `json:"query"`
	Limit          *int    `json:"limit,omitempty"`
	Cursor         *string `json:"cursor,omitempty"`
}

// TeamMemberCandidate is a registered account visible to an ordinary Team administrator.
type TeamMemberCandidate struct {
	UserID  string                    `json:"userId"`
	Profile ProjectParticipantProfile `json:"profile"`
}

type TeamMemberCandidatePage struct {
	Items      []TeamMemberCandidate `json:"items"`
	NextCursor *string               `json:"nextCursor"`
	ActorRole  string                `json:"actorRole"`
}
