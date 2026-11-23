package worker

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type pollScope struct {
	store.SnapshotScope
	worker     func(context.Context, string, string) (*store.ReviewPollWorker, error)
	candidates func(context.Context, string, string, []string, *store.ReviewPollKey, int) ([]store.ReviewPollCandidate, error)
}

func (s pollScope) ReviewPollWorker(ctx context.Context, u, w string) (*store.ReviewPollWorker, error) {
	return s.worker(ctx, u, w)
}
func (s pollScope) ReviewPollCandidates(ctx context.Context, u, w string, p []string, k *store.ReviewPollKey, n int) ([]store.ReviewPollCandidate, error) {
	if s.candidates == nil {
		panic("unexpected candidates query")
	}
	return s.candidates(ctx, u, w, p, k, n)
}
func TestReviewPullRequestsSnapshotAndFailures(t *testing.T) {
	p := model.Principal{Kind: model.PATCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	const worker = "c3333333-3333-4333-8333-333333333333"
	const project = "d4444444-4444-4444-8444-444444444444"
	failure := errors.New("database failure")
	for _, tc := range []struct {
		name                                   string
		enabled, missing, failWorker, failRows bool
	}{
		{name: "enabled", enabled: true}, {name: "disabled"}, {name: "missing", missing: true}, {name: "worker error", failWorker: true}, {name: "query error", enabled: true, failRows: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			calls := &configurationCalls{t: t, ctx: ctx, want: []string{"snapshot"}}
			db := &configurationStore{calls: calls}
			scope := pollScope{worker: func(c context.Context, u, w string) (*store.ReviewPollWorker, error) {
				if c != ctx || u != p.UserID || w != worker {
					t.Fatal("wrong worker scope")
				}
				if tc.missing {
					return nil, nil
				}
				if tc.failWorker {
					return nil, failure
				}
				return &store.ReviewPollWorker{ReviewEnabled: tc.enabled, DesiredConfiguration: []byte(`{"projects":[{"projectId":"` + project + `","nativeOverrides":{}}]}`)}, nil
			}, candidates: func(c context.Context, u, w string, projects []string, k *store.ReviewPollKey, n int) ([]store.ReviewPollCandidate, error) {
				if c != ctx || u != p.UserID || w != worker || !reflect.DeepEqual(projects, []string{project}) || k != nil || n != 2 {
					t.Fatalf("unexpected query %v %v %d", projects, k, n)
				}
				if tc.failRows {
					return nil, failure
				}
				return []store.ReviewPollCandidate{{ReviewPollKey: store.ReviewPollKey{ProjectID: project, RepositoryID: 10, GitHubPRID: 11}, RepositoryFullName: "owner/repo", Number: 12}, {ReviewPollKey: store.ReviewPollKey{ProjectID: project, RepositoryID: 10, GitHubPRID: 13}, RepositoryFullName: "owner/repo", Number: 14}}, nil
			}}
			db.read = func(c context.Context, fn func(store.SnapshotScope) error) error { return fn(scope) }
			result, err := NewWorkers(db).ReviewPullRequests(ctx, p, worker, model.PageRequest{Limit: 1})
			if tc.missing || tc.failWorker || tc.failRows {
				if err == nil || result.PullRequests != nil {
					t.Fatalf("unexpected result %+v %v", result, err)
				}
				if (tc.failWorker || tc.failRows) && !errors.Is(err, failure) {
					t.Fatalf("cause lost: %v", err)
				}
				return
			}
			if err != nil || result.ReviewEnabled != tc.enabled || result.PullRequests == nil {
				t.Fatalf("unexpected result %+v %v", result, err)
			}
			if tc.enabled {
				if len(result.PullRequests) != 1 || result.PullRequests[0].RepositoryURL != "https://github.com/owner/repo" || result.PullRequests[0].Number != "12" || result.NextCursor == nil {
					t.Fatalf("bad page %+v", result)
				}
			} else if len(result.PullRequests) != 0 || result.NextCursor != nil {
				t.Fatalf("disabled result %+v", result)
			}
		})
	}
}
