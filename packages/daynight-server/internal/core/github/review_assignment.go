package github

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

type ReviewAssignment struct {
	WorkerID      string
	AssignedAt    time.Time
	Online        *bool
	ReviewEnabled *bool
}

type ReviewAssignmentResult struct {
	Status     string
	Assignment *ReviewAssignment
}

// ReviewAssignment reads the caller's retained assignment in the same snapshot
// as project authorization and the selected PR.
func (r *Reader) ReviewAssignment(ctx context.Context, principal model.Principal, projectID string, number int64, repositoryID *int64) (ReviewAssignmentResult, error) {
	if number <= 0 {
		return ReviewAssignmentResult{}, invalid("Pull request number must be positive.")
	}
	if repositoryID != nil && *repositoryID <= 0 {
		return ReviewAssignmentResult{}, invalid("Repository ID must be positive.")
	}
	var result ReviewAssignmentResult
	err := r.snapshot(ctx, principal, projectID, func(s store.SnapshotScope, id string) error {
		dao := s.GitHubDAO()
		if _, err := dao.Connection(ctx, id); err != nil {
			return err
		}
		if _, err := selectedRepository(ctx, dao, id, repositoryID); err != nil {
			return err
		}
		pr, err := dao.PullRequest(ctx, id, number, repositoryID)
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "not_found", Message: "Pull request was not found.", Cause: err}
		}
		if err != nil {
			return err
		}
		reader, ok := s.(store.ReviewAssignmentSnapshot)
		if !ok {
			return errors.New("review assignment snapshot unavailable")
		}
		assignment, err := reader.ReviewAssignment(ctx, principal.UserID, id, pr.RepositoryID, pr.GitHubID)
		if err != nil {
			return err
		}
		if assignment == nil {
			switch pr.State {
			case "open":
				result.Status = "waiting"
			case "closed", "merged":
				result.Status = "not_applicable"
			default:
				return errors.New("invalid persisted pull request state")
			}
			return nil
		}
		result.Status = "assigned"
		result.Assignment = &ReviewAssignment{WorkerID: assignment.WorkerID, AssignedAt: assignment.AssignedAt, ReviewEnabled: assignment.ReviewEnabled}
		if assignment.LastSeenAt != nil {
			if assignment.ReviewEnabled == nil {
				return errors.New("incomplete worker review status")
			}
			observed, err := s.ObservedAt(ctx)
			if err != nil {
				return err
			}
			online := workercore.ActiveAt(*assignment.LastSeenAt, observed)
			result.Assignment.Online = &online
		} else if assignment.ReviewEnabled != nil {
			return errors.New("incomplete worker review status")
		}
		return nil
	})
	if err != nil {
		return ReviewAssignmentResult{}, fmt.Errorf("read review assignment: %w", err)
	}
	return result, nil
}
