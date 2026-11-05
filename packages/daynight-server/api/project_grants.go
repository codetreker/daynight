package api

// SetProjectGrantRequest uses a null version to require absence; a positive
// version requires the existing grant to match.
type SetProjectGrantRequest struct {
	Version        *int64 `json:"version"`
	Role           string `json:"role"`
	ExpectedUserID string `json:"expectedUserId"`
}

type ProjectGrantResult struct {
	Grant       ProjectGrant   `json:"grant"`
	ActorAccess *ProjectAccess `json:"actorAccess"`
}

type RemoveProjectGrantResult struct {
	ProjectID   string         `json:"projectId"`
	UserID      string         `json:"userId"`
	Deleted     bool           `json:"deleted"`
	ActorAccess *ProjectAccess `json:"actorAccess"`
}
