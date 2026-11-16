package api

import "time"

// GitHubApp contains only the administrator-visible, non-secret App metadata.
type GitHubApp struct {
	ID                string    `json:"id"`
	GitHubAppID       string    `json:"githubAppId"`
	Name              string    `json:"name"`
	GitHubName        string    `json:"githubName"`
	GitHubSlug        string    `json:"githubSlug"`
	Version           string    `json:"version"`
	Administrators    string    `json:"administrators"`
	AuthorizedTeams   string    `json:"authorizedTeams"`
	ConnectedProjects string    `json:"connectedProjects"`
	WebhookURL        string    `json:"webhookUrl"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}

type GitHubAppPage struct {
	Items      []GitHubApp `json:"items"`
	NextCursor *string     `json:"nextCursor"`
}
