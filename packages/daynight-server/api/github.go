package api

import "time"

// GitHubStatus contains the persisted connection and synchronization facts.
type GitHubStatus struct {
	ProjectID           string              `json:"projectId"`
	Version             string              `json:"version"`
	Revision            string              `json:"revision"`
	ServiceAvailable    bool                `json:"serviceAvailable"`
	SyncEnabled         bool                `json:"syncEnabled"`
	Connection          string              `json:"connection"`
	Repository          *GitHubRepository   `json:"repository"`
	Installation        *GitHubInstallation `json:"installation"`
	PollIntervalMinutes int32               `json:"pollIntervalMinutes"`
	Initializing        bool                `json:"initializing"`
	Poll                GitHubPollStatus    `json:"poll"`
	Webhook             GitHubWebhookStatus `json:"webhook"`
}
type GitHubRepository struct {
	ID       string `json:"id"`
	FullName string `json:"fullName"`
	Private  *bool  `json:"private"`
}
type GitHubInstallation struct {
	ID           string `json:"id"`
	AccountLogin string `json:"accountLogin"`
}
type GitHubSyncError struct {
	Code    string     `json:"code"`
	Message string     `json:"message"`
	At      *time.Time `json:"at"`
}
type GitHubPollStatus struct {
	Running       bool             `json:"running"`
	LastAttemptAt *time.Time       `json:"lastAttemptAt"`
	LastSuccessAt *time.Time       `json:"lastSuccessAt"`
	NextAttemptAt *time.Time       `json:"nextAttemptAt"`
	Error         *GitHubSyncError `json:"error"`
}
type GitHubWebhookStatus struct {
	Running        bool             `json:"running"`
	LastReceivedAt *time.Time       `json:"lastReceivedAt"`
	LastAttemptAt  *time.Time       `json:"lastAttemptAt"`
	LastSuccessAt  *time.Time       `json:"lastSuccessAt"`
	Error          *GitHubSyncError `json:"error"`
}
type PullRequestAuthor struct {
	ID    string `json:"id"`
	Login string `json:"login"`
}
type PullRequestBase struct {
	RepositoryID       string `json:"repositoryId"`
	RepositoryFullName string `json:"repositoryFullName"`
	Ref                string `json:"ref"`
}
type PullRequestHead struct {
	RepositoryID       *string `json:"repositoryId"`
	RepositoryFullName *string `json:"repositoryFullName"`
	Ref                *string `json:"ref"`
	SHA                string  `json:"sha"`
}
type PullRequestSummary struct {
	Number     string             `json:"number"`
	ID         string             `json:"id"`
	URL        string             `json:"url"`
	Title      string             `json:"title"`
	Author     *PullRequestAuthor `json:"author"`
	State      string             `json:"state"`
	Draft      bool               `json:"draft"`
	Base       PullRequestBase    `json:"base"`
	Head       PullRequestHead    `json:"head"`
	CreatedAt  time.Time          `json:"createdAt"`
	UpdatedAt  time.Time          `json:"updatedAt"`
	ClosedAt   *time.Time         `json:"closedAt"`
	MergedAt   *time.Time         `json:"mergedAt"`
	ObservedAt time.Time          `json:"observedAt"`
	Revision   string             `json:"revision"`
}
type PullRequestDetail struct {
	PullRequestSummary
	Description *string `json:"description"`
}
type PullRequestCounts struct {
	Active string `json:"active"`
	Closed string `json:"closed"`
	Merged string `json:"merged"`
	All    string `json:"all"`
}
type PullRequestPage struct {
	ProjectID      string               `json:"projectId"`
	Revision       string               `json:"revision"`
	Items          []PullRequestSummary `json:"items"`
	Total          string               `json:"total"`
	Counts         PullRequestCounts    `json:"counts"`
	NextCursor     *string              `json:"nextCursor"`
	PreviousCursor *string              `json:"previousCursor"`
}

// GitHubInstallationCandidate is a verified installation and repository.
type GitHubInstallationCandidate struct {
	Installation GitHubInstallation `json:"installation"`
	Repository   GitHubRepository   `json:"repository"`
}
