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
	PullRequestCounts(context.Context, string) (GitHubPRCounts, error)
}

type GitHubPRQuery struct {
	ProjectID string
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

type GitHubPRCounts struct{ Active, Closed, Merged, All int64 }

// GitHubConfigurationWrite is a management decision, not a runtime-state or
// observation replacement. ExpectedVersion is always the caller's original version.
type GitHubConfigurationWrite struct {
	ExpectedVersion, Version, Generation, Revision int64
	Enabled                                        bool
	AppID, InstallationID, RepositoryID            *int64
	InstallationAccountLogin, RepositoryFullName   *string
	RepositoryPrivate                              *bool
	PollIntervalMinutes                            int32
	AccessState                                    string
	AccessReason                                   *string
	AccessCheckedAt, NextAccessCheckAt, NextPollAt *time.Time
}

// GitHubWriteDAO is bound to the existing live Project write transaction.
// Connection locks an existing row until completion; management decisions must
// read through it before SaveConfiguration so broadcast changes cannot be lost.
// The enclosing Project lock protects first creation of a virtual resource.
type GitHubWriteDAO interface {
	Connection(context.Context) (githubpr.Connection, error)
	ObservedAt(context.Context) (time.Time, error)
	SaveConfiguration(context.Context, GitHubConfigurationWrite) (bool, error)
}
