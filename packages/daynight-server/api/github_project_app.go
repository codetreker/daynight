package api

// GitHubProjectAppStatus adds the project-safe App identity and connection role.
type GitHubProjectAppStatus struct {
	GitHubStatus
	CanManageConnection bool                 `json:"canManageConnection"`
	App                 *GitHubProjectAppRef `json:"app"`
	GrantID             *string              `json:"grantId"`
}

type GitHubProjectAppRef struct {
	ID          string `json:"id"`
	GitHubAppID string `json:"githubAppId"`
	Name        string `json:"name"`
	GitHubSlug  string `json:"githubSlug"`
}
