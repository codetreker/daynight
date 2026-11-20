package worker

import (
	"context"
	"fmt"
	githubcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"net/url"
	"strconv"
)

type ReviewPullRequest struct {
	ProjectID     string `json:"projectId"`
	RepositoryID  string `json:"repositoryId"`
	RepositoryURL string `json:"repositoryUrl"`
	Number        string `json:"number"`
}
type ReviewPullRequestPage struct {
	ReviewEnabled bool                `json:"reviewEnabled"`
	PullRequests  []ReviewPullRequest `json:"pullRequests"`
	NextCursor    *string             `json:"nextCursor"`
}

func (s *Workers) ReviewPullRequests(ctx context.Context, principal model.Principal, workerID string, request model.PageRequest) (ReviewPullRequestPage, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return ReviewPullRequestPage{}, err
	}
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return ReviewPullRequestPage{}, err
	}
	after, err := workercore.ReviewPollPage(request, principal.UserID, id)
	if err != nil {
		return ReviewPullRequestPage{}, err
	}
	result := ReviewPullRequestPage{PullRequests: []ReviewPullRequest{}}
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		reader, ok := scope.(store.ReviewPollSnapshot)
		if !ok {
			return fmt.Errorf("review poll snapshot is unavailable")
		}
		worker, err := reader.ReviewPollWorker(ctx, principal.UserID, id)
		if err != nil {
			return err
		}
		if worker == nil {
			return &model.Fault{Code: "not_found", Message: "Worker was not found."}
		}
		result.ReviewEnabled = worker.ReviewEnabled
		if !worker.ReviewEnabled {
			return nil
		}
		projects := workercore.ReviewProjectIDs(worker.DesiredConfiguration)
		if len(projects) == 0 {
			return nil
		}
		rows, err := reader.ReviewPollCandidates(ctx, principal.UserID, id, projects, after, request.Limit+1)
		if err != nil {
			return err
		}
		more := len(rows) > request.Limit
		if more {
			rows = rows[:request.Limit]
		}
		for _, row := range rows {
			owner, name, err := githubcore.RepositoryParts(row.RepositoryFullName)
			projectID, idErr := model.CanonicalID(row.ProjectID)
			if err != nil || idErr != nil || projectID != row.ProjectID || row.RepositoryID < 1 || row.GitHubPRID < 1 || row.Number < 1 {
				return fmt.Errorf("invalid stored review candidate")
			}
			result.PullRequests = append(result.PullRequests, ReviewPullRequest{ProjectID: row.ProjectID, RepositoryID: strconv.FormatInt(row.RepositoryID, 10), RepositoryURL: "https://github.com/" + url.PathEscape(owner) + "/" + url.PathEscape(name), Number: strconv.FormatInt(row.Number, 10)})
		}
		if more {
			cursor, err := workercore.ReviewPollCursor(principal.UserID, id, request.Limit, rows[len(rows)-1].ReviewPollKey)
			if err != nil {
				return err
			}
			result.NextCursor = &cursor
		}
		return nil
	})
	if err != nil {
		return ReviewPullRequestPage{}, fmt.Errorf("list Worker review pull requests: %w", err)
	}
	return result, nil
}
