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

// CredentialSnapshot is an internal, current App identity and private key.
// It contains secret material and must not be used as a public projection.
type CredentialSnapshot struct {
	AppResourceID     string
	GitHubAppID       int64
	CredentialVersion int64
	PrivateKeyPEM     []byte
}
