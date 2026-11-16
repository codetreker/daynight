package githubpr

import "time"

// AppMetadata contains the management projection, never credential material.
type AppMetadata struct {
	ID                                                          string
	GitHubAppID                                                 int64
	Name, GitHubName, GitHubSlug                                string
	Version, Administrators, AuthorizedTeams, ConnectedProjects int64
	CreatedAt, UpdatedAt                                        time.Time
}

// AppCredentials is supplied only to operations that require the secrets.
type AppCredentials struct {
	PrivateKeyPEM, WebhookSecret []byte
}
