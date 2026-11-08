package api

import "time"

type ProjectDeletionIdentity struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	RepoURL   string  `json:"repoUrl"`
	OwnerTeam TeamRef `json:"ownerTeam"`
}
type ProjectDeletionSummary struct {
	TaskCount           int64 `json:"taskCount"`
	UnfinishedTaskCount int64 `json:"unfinishedTaskCount"`
	AttachmentCount     int64 `json:"attachmentCount"`
}
type ProjectDeletionWorker struct {
	MachineName  string `json:"machineName"`
	Platform     string `json:"platform"`
	Phase        string `json:"phase"`
	Paused       bool   `json:"paused"`
	Connectivity string `json:"connectivity"`
}
type ProjectDeletionClaim struct {
	TaskID string                `json:"taskId"`
	Title  string                `json:"title"`
	Worker ProjectDeletionWorker `json:"worker"`
}
type ProjectDeletionPreview struct {
	ObservedAt   time.Time               `json:"observedAt"`
	Project      ProjectDeletionIdentity `json:"project"`
	Summary      ProjectDeletionSummary  `json:"summary"`
	ActiveClaims []ProjectDeletionClaim  `json:"activeClaims"`
	NextCursor   *string                 `json:"nextCursor"`
}
type ProjectDeletionReceipt struct {
	ProjectID string `json:"projectId"`
	Deleted   bool   `json:"deleted"`
}
