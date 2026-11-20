package github

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type StatisticsSegment struct {
	DateIndex   int
	StartMillis int64
}

type StatisticsRequest struct {
	RepositoryID *int64
	EndDate      string
	Window       []StatisticsSegment
	AuthorID     *int64
}

type Statistics struct {
	Repository   *githubpr.Repository
	Connection   githubpr.Connection
	ProjectTotal int64
	Availability string
	HasAuthors   bool
	Daily        [30]int64
	AuthorID     *int64
	Author       *githubpr.Author
	AuthorDaily  *[30]int64
}

// Statistics reads authorization, connection and counts from one snapshot.
func (r *Reader) Statistics(ctx context.Context, principal model.Principal, projectID string, request StatisticsRequest) (Statistics, error) {
	return r.statistics(ctx, principal, projectID, request, nil)
}

func (r *Reader) StatisticsAuthorized(ctx context.Context, authorization model.CredentialAuthorization, projectID string, request StatisticsRequest) (Statistics, error) {
	if err := authorization.Validate(); err != nil {
		return Statistics{}, err
	}
	return r.statistics(ctx, authorization.Principal, projectID, request, func() error { return requireProjectScope(authorization) })
}

func (r *Reader) statistics(ctx context.Context, principal model.Principal, projectID string, request StatisticsRequest, check func() error) (Statistics, error) {
	if request.RepositoryID != nil && *request.RepositoryID <= 0 {
		return Statistics{}, invalid("Repository ID must be positive.")
	}
	query, err := statisticsQuery(request)
	if err != nil {
		return Statistics{}, err
	}
	result := Statistics{AuthorID: request.AuthorID}
	if request.AuthorID != nil {
		result.AuthorDaily = &[30]int64{}
	}
	err = r.snapshot(ctx, principal, projectID, nil, func(s store.SnapshotScope, id string) error {
		if err := checkRepositoryScope(ctx, s, id, request.RepositoryID, check); err != nil {
			return err
		}
		dao := s.GitHubDAO()
		var e error
		result.Connection, e = dao.Connection(ctx, id)
		if e != nil {
			return e
		}
		result.Repository, e = selectedRepository(ctx, dao, id, request.RepositoryID)
		if e != nil {
			return e
		}
		query.ProjectID = id
		query.RepositoryID = request.RepositoryID
		data, e := dao.PullRequestStatistics(ctx, query)
		if e != nil {
			return e
		}
		result.Author = data.Author
		seen := [31]bool{}
		for _, bucket := range data.Buckets {
			index := 30
			if bucket.DateIndex != nil {
				index = int(*bucket.DateIndex)
				if index < 0 || index >= 30 {
					return fmt.Errorf("invalid persisted GitHub statistics date")
				}
			}
			if index < 0 || index > 30 || seen[index] || bucket.Total < 0 || bucket.AuthorTotal < 0 || bucket.AuthorTotal > bucket.Total || result.ProjectTotal > math.MaxInt64-bucket.Total {
				return fmt.Errorf("invalid persisted GitHub statistics buckets")
			}
			seen[index] = true
			result.ProjectTotal += bucket.Total
			result.HasAuthors = result.HasAuthors || bucket.HasAuthors
			if index < 30 {
				result.Daily[index] = bucket.Total
				if result.AuthorDaily != nil {
					result.AuthorDaily[index] = bucket.AuthorTotal
				}
			}
		}
		if result.Connection.Revision < 0 || (result.Author != nil && (request.AuthorID == nil || result.Author.ID != *request.AuthorID)) {
			return fmt.Errorf("invalid persisted GitHub statistics identity")
		}
		if request.RepositoryID == nil {
			result.Availability = statisticsAvailability(result.Connection, r.available, result.ProjectTotal)
		} else {
			result.Availability = sourceStatisticsAvailability(result.Connection, request.RepositoryID, r.available, result.ProjectTotal)
		}
		return nil
	})
	if err != nil {
		return Statistics{}, err
	}
	return result, nil
}

func statisticsAvailability(c githubpr.Connection, available bool, total int64) string {
	if total == 0 && c.InstallationID == nil {
		return "not_connected"
	}
	return sourceStatisticsAvailability(c, c.LegacyRepositoryID, available, total)
}

func sourceStatisticsAvailability(c githubpr.Connection, repositoryID *int64, available bool, total int64) string {
	if total > 0 {
		return "ready"
	}
	// Synchronization facts belong exclusively to the active repository.
	if repositoryID != nil && (c.RepositoryID == nil || *repositoryID != *c.RepositoryID) {
		return "no_saved_data"
	}
	if c.InstallationID == nil {
		return "not_connected"
	}
	if repositoryID == nil {
		return "no_saved_data"
	}
	initializing := c.Enabled && c.SyncEnabled && (c.LastFullGeneration == nil || *c.LastFullGeneration != c.Generation)
	if c.Enabled && c.AccessState != "unavailable" && c.SyncEnabled && available && initializing {
		return "initializing"
	}
	if !initializing && c.LastFullSuccessAt != nil {
		return "ready"
	}
	return "no_saved_data"
}

func statisticsQuery(req StatisticsRequest) (store.GitHubPRStatisticsQuery, error) {
	bad := func() (store.GitHubPRStatisticsQuery, error) {
		return store.GitHubPRStatisticsQuery{}, invalid("Statistics date window is invalid.")
	}
	end, err := time.Parse("2006-01-02", req.EndDate)
	if err != nil || len(req.EndDate) != 10 || end.Format("2006-01-02") != req.EndDate || end.Year() < 1 || end.AddDate(0, 0, -29).Year() < 1 || (req.AuthorID != nil && *req.AuthorID <= 0) {
		return bad()
	}
	if len(req.Window) < 2 || len(req.Window) > 64 || req.Window[len(req.Window)-1].DateIndex != -1 {
		return bad()
	}
	first := end.AddDate(0, 0, -29)
	lower, upper := first.Add(-24*time.Hour), end.Add(48*time.Hour)
	q := store.GitHubPRStatisticsQuery{AuthorID: req.AuthorID}
	named := false
	for i, segment := range req.Window {
		if segment.DateIndex < -1 || segment.DateIndex > 29 || (i > 0 && (segment.StartMillis <= req.Window[i-1].StartMillis || segment.DateIndex == req.Window[i-1].DateIndex)) {
			return bad()
		}
		t := time.UnixMilli(segment.StartMillis).UTC()
		if t.Before(lower) || t.After(upper) {
			return bad()
		}
		if i < len(req.Window)-1 && segment.DateIndex >= 0 {
			named = true
			day := first.AddDate(0, 0, segment.DateIndex)
			next := time.UnixMilli(req.Window[i+1].StartMillis).UTC()
			if t.Before(day.Add(-24*time.Hour)) || next.After(day.Add(48*time.Hour)) {
				return bad()
			}
		}
		q.Boundaries = append(q.Boundaries, t)
		q.DateIndices = append(q.DateIndices, int32(segment.DateIndex))
	}
	if !named {
		return bad()
	}
	return q, nil
}
