package github

import (
	"context"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

const reviewerInterval = 5 * time.Second
const reviewerBatch = 32

func (r *AppRunner) reconcileReviewers(ctx context.Context) {
	ticker := time.NewTicker(reviewerInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		r.assignReviewers(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *AppRunner) assignReviewers(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	for range reviewerBatch {
		if ctx.Err() != nil {
			return
		}
		assigned, err := r.reviewers.AssignPullRequestReviewer(ctx, workercore.ActiveWindow)
		if err != nil {
			if ctx.Err() == nil {
				attrs := append([]any{"component", "github_sync", "phase", "assign_reviewer"}, appErrorAttributes(err)...)
				r.logger.WarnContext(ctx, "pull request reviewer allocation failed", attrs...)
			}
			return
		}
		if !assigned {
			return
		}
	}
}
