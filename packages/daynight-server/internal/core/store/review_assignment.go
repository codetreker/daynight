package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ReviewAssignmentSnapshot is an optional capability of a read-only snapshot.
// A missing assignment returns nil; a missing retained Worker has nil status facts.
type ReviewAssignmentSnapshot interface {
	ReviewAssignment(context.Context, string, string, int64, int64) (*ReviewAssignment, error)
}

type ReviewAssignment struct {
	WorkerID      string
	AssignedAt    time.Time
	LastSeenAt    *time.Time
	ReviewEnabled *bool
}

// ReviewPollSnapshot reads a Worker's participation and its eligible assigned
// PRs from the same repeatable-read snapshot. The caller interprets the Worker's
// configuration and supplies its selected Project IDs before pagination.
type ReviewPollSnapshot interface {
	ReviewPollWorker(context.Context, string, string) (*ReviewPollWorker, error)
	ReviewPollCandidates(context.Context, string, string, []string, *ReviewPollKey, int) ([]ReviewPollCandidate, error)
}

type ReviewPollWorker struct {
	ReviewEnabled        bool
	DesiredConfiguration json.RawMessage
}

type ReviewPollKey struct {
	ProjectID                string
	RepositoryID, GitHubPRID int64
}

type ReviewPollCandidate struct {
	ReviewPollKey
	RepositoryFullName string
	Number             int64
}

type ReviewWorkerKey struct{ UserID, WorkerID string }

type ReviewWorker struct {
	ReviewWorkerKey
	CreatedAt, LastSeenAt time.Time
	ReviewEnabled         bool
	DesiredConfiguration  json.RawMessage
}

type ReviewPR struct {
	Number, GitHubID int64
	State, BaseRef   string
	Assigned         bool
}

// ReviewAssignmentStore provides bounded scans and short writes. Scan results are
// observations only; writes must revalidate all mutable facts under the locks.
type ReviewAssignmentStore interface {
	ReviewScanStart(context.Context) (time.Time, *ReviewWorkerKey, error)
	ReviewWorkers(context.Context, time.Time, ReviewWorkerKey, *ReviewWorkerKey, int) ([]ReviewWorker, error)
	// ReviewRepository returns nil for a missing connection or repository.
	ReviewRepository(context.Context, string) (*int64, error)
	ReviewOpenPRs(context.Context, string, string, int64, *int64, *int64, int) ([]ReviewPR, error)
	WriteReviewAssignment(context.Context, string, func(ReviewAssignmentWrite) error) (Completion, error)
}

type ReviewConnection struct {
	RepositoryID  *int64
	DefaultBranch *string
}

// Calls lock authorization, connection and worker in this order, after the
// Project write lock, then sample ObservedAt and re-read the PR before Insert.
type ReviewAssignmentWrite interface {
	LockAuthorization(context.Context, string) (model.ProjectAccess, error)
	LockConnection(context.Context) (*ReviewConnection, error)
	LockWorker(context.Context, string, string) (ReviewWorker, error)
	ObservedAt(context.Context) (time.Time, error)
	PullRequest(context.Context, int64, int64) (*ReviewPR, error)
	Insert(context.Context, string, int64, int64, string, time.Time) (bool, error)
}
