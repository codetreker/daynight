package api

type TransferTeam struct {
	TeamRef
	Version int64 `json:"version"`
}

type TransferPreview struct {
	SourceTeam TeamRef          `json:"sourceTeam"`
	TargetTeam TransferTeam     `json:"targetTeam"`
	Ownership  ProjectOwnership `json:"ownership"`
	ActorRole  *string          `json:"actorRole"`
}

type TransferReceipt struct {
	ProjectID   string           `json:"projectId"`
	Changed     bool             `json:"changed"`
	SourceTeam  TeamRef          `json:"sourceTeam"`
	OwnerTeam   TeamRef          `json:"ownerTeam"`
	Ownership   ProjectOwnership `json:"ownership"`
	ActorAccess *ProjectAccess   `json:"actorAccess"`
}
