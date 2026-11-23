package github

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type assignmentFixture struct {
	*fixture
	pr                      githubpr.PullRequest
	assignment              *store.ReviewAssignment
	assignmentErr, clockErr error
	now                     time.Time
}

func (f *assignmentFixture) ReadSnapshot(ctx context.Context, fn func(store.SnapshotScope) error) error {
	f.trace = append(f.trace, "snapshot")
	if ctx != f.wantCtx {
		panic("context changed at snapshot")
	}
	if err := fn(f); err != nil {
		return err
	}
	return f.completionErr
}
func (f *assignmentFixture) GitHubDAO() store.GitHubReadDAO { return f }
func (f *assignmentFixture) PullRequest(ctx context.Context, id string, n int64, repo *int64) (githubpr.PullRequest, error) {
	f.trace = append(f.trace, "detail")
	if ctx != f.wantCtx || id != projectID || n != 42 {
		panic("wrong PR arguments")
	}
	return f.pr, f.detailErr
}
func (f *assignmentFixture) ReviewAssignment(ctx context.Context, user, project string, repo, pr int64) (*store.ReviewAssignment, error) {
	f.trace = append(f.trace, "assignment")
	if ctx != f.wantCtx || user != principal.UserID || project != projectID || repo != 99 || pr != 111 {
		panic("wrong assignment identity")
	}
	return f.assignment, f.assignmentErr
}
func (f *assignmentFixture) ObservedAt(ctx context.Context) (time.Time, error) {
	f.trace = append(f.trace, "clock")
	if ctx != f.wantCtx {
		panic("wrong clock context")
	}
	return f.now, f.clockErr
}

func TestReviewAssignmentSnapshotAndStates(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	enabled := true
	for _, tc := range []struct {
		name, state, status string
		seen                *time.Time
		assignment          bool
		online              *bool
	}{
		{"open waiting", "open", "waiting", nil, false, nil},
		{"closed", "closed", "not_applicable", nil, false, nil},
		{"merged", "merged", "not_applicable", nil, false, nil},
		{"missing worker", "open", "assigned", nil, true, nil},
		{"online", "closed", "assigned", ptrTime(now.Add(-119 * time.Second)), true, ptrBool(true)},
		{"boundary offline", "open", "assigned", ptrTime(now.Add(-120 * time.Second)), true, ptrBool(false)},
		{"future offline", "open", "assigned", ptrTime(now.Add(time.Second)), true, ptrBool(false)},
		{"old offline", "open", "assigned", ptrTime(now.Add(-73 * time.Hour)), true, ptrBool(false)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &assignmentFixture{fixture: fixtureFor(ctx), now: now, pr: githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{RepositoryID: 99, GitHubID: 111, State: tc.state}}}
			if tc.assignment {
				f.assignment = &store.ReviewAssignment{WorkerID: "worker", AssignedAt: now, LastSeenAt: tc.seen}
				if tc.seen != nil {
					f.assignment.ReviewEnabled = &enabled
				}
			}
			got, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, nil)
			if err != nil || got.Status != tc.status || (got.Assignment != nil) != tc.assignment {
				t.Fatalf("got %+v, %v", got, err)
			}
			if got.Assignment != nil && (!reflect.DeepEqual(got.Assignment.Online, tc.online) || got.Assignment.WorkerID != "worker" || !got.Assignment.AssignedAt.Equal(now) || !reflect.DeepEqual(got.Assignment.ReviewEnabled, f.assignment.ReviewEnabled)) {
				t.Fatalf("assignment %+v", got.Assignment)
			}
			want := []string{"snapshot", "access", "connection", "detail", "assignment"}
			if tc.seen != nil {
				want = append(want, "clock")
			}
			if !reflect.DeepEqual(f.trace, want) {
				t.Fatalf("trace %v", f.trace)
			}
		})
	}
}
func ptrTime(v time.Time) *time.Time { return &v }
func ptrBool(v bool) *bool           { return &v }

func TestReviewAssignmentRefusalsAndFailures(t *testing.T) {
	ctx := context.Background()
	cause := errors.New("storage failed")
	for _, tc := range []struct {
		name      string
		configure func(*assignmentFixture)
		wantCode  string
		wantErr   error
		wantTrace []string
	}{
		{"access denied", func(f *assignmentFixture) { f.accessErr = &model.Fault{Code: "forbidden"} }, "forbidden", nil, []string{"snapshot", "access"}},
		{"missing PR", func(f *assignmentFixture) { f.detailErr = model.ErrNotFound }, "not_found", model.ErrNotFound, []string{"snapshot", "access", "connection", "detail"}},
		{"assignment failure", func(f *assignmentFixture) { f.assignmentErr = cause }, "", cause, []string{"snapshot", "access", "connection", "detail", "assignment"}},
		{"snapshot failure", func(f *assignmentFixture) { f.completionErr = cause }, "", cause, []string{"snapshot", "access", "connection", "detail", "assignment"}},
		{"clock failure", func(f *assignmentFixture) {
			enabled := true
			f.assignment = &store.ReviewAssignment{LastSeenAt: &f.now, ReviewEnabled: &enabled}
			f.clockErr = cause
		}, "", cause, []string{"snapshot", "access", "connection", "detail", "assignment", "clock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &assignmentFixture{fixture: fixtureFor(ctx), now: time.Now(), pr: githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{RepositoryID: 99, GitHubID: 111, State: "open"}}}
			tc.configure(f)
			got, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, nil)
			if tc.wantCode != "" {
				faultCode(t, err, tc.wantCode)
			}
			if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
				t.Fatalf("error %v", err)
			}
			if got != (ReviewAssignmentResult{}) || !reflect.DeepEqual(f.trace, tc.wantTrace) {
				t.Fatalf("got %+v trace %v", got, f.trace)
			}
		})
	}
	f := &assignmentFixture{fixture: fixtureFor(ctx)}
	_, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 0, nil)
	faultCode(t, err, "invalid_input")
	if len(f.trace) != 0 {
		t.Fatal(f.trace)
	}
}

func TestReviewAssignmentRepositorySelectionAndInvalidState(t *testing.T) {
	ctx := context.Background()
	f := &assignmentFixture{fixture: fixtureFor(ctx), now: time.Now(), pr: githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{RepositoryID: 99, GitHubID: 111, State: "open"}}}
	f.repository = func(actual context.Context, id string, repo int64) (githubpr.Repository, error) {
		if actual != ctx || id != projectID || repo != 99 {
			t.Fatal("incorrect repository selection")
		}
		return githubpr.Repository{RepositoryID: repo}, nil
	}
	repo := int64(99)
	got, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, &repo)
	if err != nil || got.Status != "waiting" || !reflect.DeepEqual(f.trace, []string{"snapshot", "access", "connection", "repository", "detail", "assignment"}) {
		t.Fatalf("got %+v trace %v error %v", got, f.trace, err)
	}
	zero := int64(0)
	_, err = NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, &zero)
	faultCode(t, err, "invalid_input")

	enabled := true
	for _, a := range []*store.ReviewAssignment{{LastSeenAt: &f.now}, {ReviewEnabled: &enabled}} {
		f.assignment = a
		result, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, nil)
		if err == nil || result != (ReviewAssignmentResult{}) {
			t.Fatalf("incomplete status yielded %+v, %v", result, err)
		}
	}
	f.assignment = nil
	f.pr.State = "unknown"
	if result, err := NewReader(f, true).ReviewAssignment(ctx, principal, projectID, 42, nil); err == nil || result != (ReviewAssignmentResult{}) {
		t.Fatalf("invalid state yielded %+v, %v", result, err)
	}
	legacy := fixtureFor(ctx)
	if result, err := NewReader(legacy, true).ReviewAssignment(ctx, principal, projectID, 42, nil); err == nil || result != (ReviewAssignmentResult{}) {
		t.Fatalf("missing snapshot capability yielded %+v, %v", result, err)
	}
}
