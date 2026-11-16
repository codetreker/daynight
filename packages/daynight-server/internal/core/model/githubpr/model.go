// Package githubpr contains persistence-independent GitHub integration facts.
package githubpr

import "time"

// Connection records configuration and the most recently persisted runtime facts.
// A missing database row is represented by DefaultConnection.
type Connection struct {
	ProjectID                                                         string
	Version, Generation, Revision                                     int64
	Enabled, SyncEnabled                                              bool
	AppID, InstallationID, RepositoryID                               *int64
	InstallationAccountLogin, RepositoryFullName                      *string
	RepositoryPrivate                                                 *bool
	PollIntervalMinutes                                               int32
	AccessState                                                       string
	AccessReason                                                      *string
	AccessCheckedAt, NextAccessCheckAt                                *time.Time
	AccessHintID, AccessDeliveryID                                    *string
	NextPollAt, NotBefore, LastPollAttemptAt, LastFullSuccessAt       *time.Time
	LastFullGeneration                                                *int64
	PollErrorCode, PollErrorMessage                                   *string
	PollErrorAt                                                       *time.Time
	LastWebhookReceivedAt, LastWebhookAttemptAt, LastWebhookSuccessAt *time.Time
	WebhookErrorCode, WebhookErrorMessage                             *string
	WebhookErrorAt                                                    *time.Time
	ClaimToken                                                        *string
	ClaimUntil                                                        *time.Time
	ClaimKind                                                         *string
	CreatedAt, UpdatedAt                                              *time.Time
}

func DefaultConnection(projectID string) Connection {
	return Connection{ProjectID: projectID, Version: 1, PollIntervalMinutes: 5, AccessState: "unknown"}
}

// PullRequestSummary deliberately excludes the potentially large description.
type PullRequestSummary struct {
	ProjectID                        string
	Number, GitHubID                 int64
	URL, Title                       string
	AuthorID                         *int64
	AuthorLogin                      *string
	State                            string
	Draft                            bool
	BaseRef                          string
	HeadRepositoryID                 *int64
	HeadRepositoryFullName, HeadRef  *string
	HeadSHA                          string
	GitHubCreatedAt, GitHubUpdatedAt time.Time
	GitHubClosedAt, GitHubMergedAt   *time.Time
	ObservedAt                       time.Time
	Revision                         int64
	SeenPollID                       *string
}

type PullRequest struct {
	PullRequestSummary
	Description *string
}

// RepositoryObservation and InstallationObservation are remote identity
// facts, independent of the transport used to obtain them.
type RepositoryObservation struct {
	ID       int64
	FullName string
	Private  bool
}

type InstallationObservation struct {
	ID           int64
	AccountLogin string
}

// Observation is the remote fact before the core normalizes its state and
// attaches local observation and revision metadata.
type Observation struct {
	Number, GitHubID                int64
	URL, Title                      string
	AuthorID                        *int64
	AuthorLogin                     *string
	State                           string
	Draft                           bool
	BaseRepositoryID                int64
	BaseRef                         string
	HeadRepositoryID                *int64
	HeadRepositoryFullName, HeadRef *string
	HeadSHA                         string
	CreatedAt, UpdatedAt            time.Time
	ClosedAt, MergedAt              *time.Time
	Description                     *string
}
