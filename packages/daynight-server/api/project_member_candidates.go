package api

type ProjectMemberCandidateSearchRequest struct {
	ExpectedUserID string  `json:"expectedUserId"`
	Query          string  `json:"query"`
	Limit          *int    `json:"limit,omitempty"`
	Cursor         *string `json:"cursor,omitempty"`
}

type ProjectMemberCandidate struct {
	UserID  string                    `json:"userId"`
	Profile ProjectParticipantProfile `json:"profile"`
}

type ProjectMemberCandidatePage struct {
	Items      []ProjectMemberCandidate `json:"items"`
	NextCursor *string                  `json:"nextCursor"`
	ActorRole  string                   `json:"actorRole"`
}
