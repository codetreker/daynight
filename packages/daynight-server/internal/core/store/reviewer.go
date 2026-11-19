package store

import (
	"context"
	"time"
)

// PullRequestReviewerAllocator conditionally assigns one eligible Open PR from
// committed sync data. A false result can also indicate another allocator won.
type PullRequestReviewerAllocator interface {
	AssignPullRequestReviewer(ctx context.Context, activeWindow time.Duration) (bool, error)
}
