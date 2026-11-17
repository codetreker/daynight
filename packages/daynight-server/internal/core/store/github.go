package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

// GitHubReadDAO reads resource facts in the caller's snapshot.
type GitHubReadDAO interface {
	Connection(context.Context, string) (githubpr.Connection, error)
	PullRequest(context.Context, string, int64) (githubpr.PullRequest, error)
	PullRequests(context.Context, GitHubPRQuery) (GitHubPRPage, error)
	PullRequestCounts(context.Context, GitHubPRCountsQuery) (GitHubPRCounts, error)
}

type GitHubPRQuery struct {
	ProjectID string
	AuthorID  *int64
	// State is active, closed, merged or all; validation belongs to core.
	State, Query              string
	Limit                     int
	UpperNumber, AnchorNumber *int64
	// Previous selects the bounded page immediately above the anchor.
	Previous bool
}

type GitHubPRPage struct {
	Items       []githubpr.PullRequestSummary
	Total       int64
	UpperNumber *int64
	HasMore     bool
}

type GitHubPRCountsQuery struct {
	ProjectID string
	AuthorID  *int64
}

type GitHubPRCounts struct{ Active, Closed, Merged, All, ProjectTotal int64 }

// GitHubConfigurationWrite is a management decision, not a runtime-state or
// observation replacement. ExpectedVersion is always the caller's original version.
type GitHubConfigurationWrite struct {
	ExpectedVersion, Version, Generation, Revision int64
	Enabled, SyncEnabled                           bool
	AppID, InstallationID, RepositoryID            *int64
	InstallationAccountLogin, RepositoryFullName   *string
	RepositoryPrivate                              *bool
	PollIntervalMinutes                            int32
	AccessState                                    string
	AccessReason                                   *string
	AccessCheckedAt, NextAccessCheckAt, NextPollAt *time.Time
}

// GitHubWorkDAO supplies synchronization operations without configuration writes.
type GitHubWorkDAO interface {
	Connection(context.Context) (githubpr.Connection, error)
	ObservedAt(context.Context) (time.Time, error)
	Claim(context.Context, GitHubClaim) (bool, error)
	// Renew requires the caller to lock Connection, read ObservedAt afterwards,
	// and supply that database time plus five minutes. It rejects expiration
	// and any deadline that does not extend the existing lease.
	Renew(context.Context, GitHubLease, time.Time) (bool, error)
	ValidLease(context.Context, GitHubLease) (bool, error)
	Publish(context.Context, GitHubLease, []githubpr.PullRequest) (bool, error)
	PublishRepository(context.Context, GitHubLease, GitHubRepositoryObservation) (bool, error)
	UnseenActive(context.Context, GitHubLease, string, int64, int) ([]int64, bool, error)
	Pending(context.Context, GitHubLease, time.Time, int) ([]GitHubPendingPR, bool, error)
	HasPending(context.Context, GitHubLease) (bool, bool, error)
	// HasDuePending locks Connection and checks the current generation at the
	// supplied database time without requiring a claim.
	HasDuePending(context.Context, time.Time) (bool, error)
	AckPending(context.Context, GitHubLease, int64, string) (bool, error)
	ReschedulePending(context.Context, GitHubLease, int64, string, time.Time) (bool, error)
	AckAccessHint(context.Context, GitHubLease, string) (bool, error)
	SaveRuntime(context.Context, GitHubLease, GitHubRuntimeWrite) (bool, error)
}

// GitHubLease identifies the original work. Every mutation checks this identity
// and the database clock while holding the enclosing live Project transaction.
type GitHubLease struct {
	Generation int64
	Token      string
}

// GitHubClaim supplies a core-selected work kind and deadline. Admission also
// checks the current app, generation, not-before time, and absent/expired claim.
type GitHubClaim struct {
	AppID, Generation int64
	Token, Kind       string
	Until             time.Time
}

// GitHubRepositoryObservation updates presentation facts only when the
// original installation and repository identities still match the binding.
type GitHubRepositoryObservation struct {
	InstallationID, RepositoryID                 int64
	InstallationAccountLogin, RepositoryFullName string
	RepositoryPrivate                            bool
}

// GitHubRuntimeWrite contains only runtime facts controlled by the worker.
// Event reception facts and configuration are deliberately excluded.
type GitHubRuntimeWrite struct {
	ExpectedRevision, Revision                                int64
	AccessState                                               string
	AccessReason                                              *string
	AccessCheckedAt, NextAccessCheckAt, NextPollAt, NotBefore *time.Time
	LastPollAttemptAt, LastFullSuccessAt                      *time.Time
	LastFullGeneration                                        *int64
	PollErrorCode, PollErrorMessage                           *string
	PollErrorAt                                               *time.Time
	LastWebhookAttemptAt, LastWebhookSuccessAt                *time.Time
	WebhookErrorCode, WebhookErrorMessage                     *string
	WebhookErrorAt                                            *time.Time
	ReleaseClaim                                              bool
}

// GitHubPendingPR is a captured request. Only the same request may be acked
// or rescheduled; an intervening signal replaces its request ID.
type GitHubPendingPR struct {
	Number, Generation        int64
	RequestID, DeliveryID     string
	ReceivedAt, NextAttemptAt time.Time
}
