package api

// RepositoryPreview describes the effect of a proposed Project repository address.
type RepositoryPreview struct {
	ProjectID                string  `json:"projectId"`
	ProjectName              string  `json:"projectName"`
	CurrentRepoURL           string  `json:"currentRepoUrl"`
	RepoURL                  string  `json:"repoUrl"`
	RepositoryVersion        string  `json:"repositoryVersion"`
	OwnershipVersion         string  `json:"ownershipVersion"`
	Classification           string  `json:"classification"`
	TargetGitHubRepositoryID *string `json:"targetGitHubRepositoryId"`
	UnverifiedReason         *string `json:"unverifiedReason"`
	BindingsInvalidated      bool    `json:"bindingsInvalidated"`
}

type RepositoryReceipt struct {
	ProjectID           string `json:"projectId"`
	RepoURL             string `json:"repoUrl"`
	RepositoryVersion   string `json:"repositoryVersion"`
	Changed             bool   `json:"changed"`
	BindingsInvalidated bool   `json:"bindingsInvalidated"`
}
