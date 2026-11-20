package reviewassignment_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/reviewassignment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestReviewPollCandidatesSnapshotAndFilters(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	ctx := t.Context()
	a := testutil.QueryProject(t, db.Pool, db, 1).ID
	b := testutil.QueryProject(t, db.Pool, db, 2).ID
	var owner string
	if err := db.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1 AND m.role='admin' LIMIT 1`, a).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	worker, otherWorker, otherUser := testutil.QueryID(10), testutil.QueryID(11), testutil.QueryID(12)
	testutil.MustExec(t, db.Pool, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, b, owner)
	testutil.MustExec(t, db.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,now(),now(),'{}','{}',true,1,now(),$3::jsonb)`, owner, worker, fmt.Sprintf(`{"projects":[{"projectId":%q}]}`, a))
	testutil.MustExec(t, db.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled) VALUES($1,$2,now(),now(),'{}','{}',true)`, owner, otherWorker)
	for _, project := range []string{a, b} {
		testutil.MustExec(t, db.Pool, `INSERT INTO project_github(project_id,repository_id,repository_full_name,repository_default_branch) VALUES($1,30,'owner/current','trunk')`, project)
	}
	// PR identities are deliberately different from their numbers; page order is
	// the assignment identity, not number. Draft remains eligible.
	for _, item := range []struct {
		project                      string
		repo, number, github         int64
		state, base                  string
		draft                        bool
		assignedWorker, assignedUser string
	}{
		{a, 30, 7, 10, "open", "trunk", true, worker, owner},
		{a, 30, 2, 20, "open", "trunk", false, worker, owner},
		{a, 30, 3, 30, "open", "release", false, worker, owner},
		{a, 30, 4, 40, "closed", "trunk", false, worker, owner},
		{a, 30, 9, 90, "merged", "trunk", false, worker, owner},
		{a, 30, 5, 50, "open", "trunk", false, otherWorker, owner},
		{a, 30, 6, 60, "open", "trunk", false, worker, otherUser},
		{a, 31, 8, 80, "open", "trunk", false, worker, owner},
		{b, 30, 1, 11, "open", "trunk", false, worker, owner},
	} {
		testutil.MustExec(t, db.Pool, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,$2,$3,$4,'url','title',$5,$6,$7,'sha',now(),now(),now(),1)`, item.project, item.repo, item.number, item.github, item.state, item.draft, item.base)
		testutil.MustExec(t, db.Pool, `INSERT INTO project_pr_review_assignments(user_id,project_id,repository_id,github_pr_id,worker_id,assigned_at) VALUES($1,$2,$3,$4,$5,now())`, item.assignedUser, item.project, item.repo, item.github, item.assignedWorker)
	}
	read := func(projects []string, after *store.ReviewPollKey, limit int) []store.ReviewPollCandidate {
		t.Helper()
		var result []store.ReviewPollCandidate
		err := db.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
			var e error
			result, e = sc.(store.ReviewPollSnapshot).ReviewPollCandidates(ctx, owner, worker, projects, after, limit)
			return e
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	page := read([]string{a, b}, nil, 1)
	if len(page) != 1 || page[0].ProjectID != a || page[0].GitHubPRID != 10 || page[0].Number != 7 || page[0].RepositoryFullName != "owner/current" {
		t.Fatalf("first page: %+v", page)
	}
	after := page[0].ReviewPollKey
	page = read([]string{a, b}, &after, 10)
	if len(page) != 2 || page[0].GitHubPRID != 20 || page[1].ProjectID != b || page[1].GitHubPRID != 11 {
		t.Fatalf("following page: %+v", page)
	}
	if page := read([]string{b}, nil, 10); len(page) != 1 || page[0].ProjectID != b {
		t.Fatalf("selected projects: %+v", page)
	}
	if page := read(nil, nil, 10); len(page) != 0 {
		t.Fatalf("empty selection: %+v", page)
	}
	// Revocation after the snapshot starts is visible on the next page request,
	// while the current snapshot continues to observe its original state.
	err = db.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		s := sc.(store.ReviewPollSnapshot)
		w, e := s.ReviewPollWorker(ctx, owner, worker)
		if e != nil || w == nil || !w.ReviewEnabled || len(w.DesiredConfiguration) == 0 {
			return fmt.Errorf("worker: %+v %w", w, e)
		}
		missing, e := s.ReviewPollWorker(ctx, otherUser, worker)
		if e != nil || missing != nil {
			return fmt.Errorf("other account worker: %+v %w", missing, e)
		}
		if _, e = db.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, b, owner); e != nil {
			return e
		}
		items, e := s.ReviewPollCandidates(ctx, owner, worker, []string{b}, nil, 10)
		if e != nil || len(items) != 1 {
			return fmt.Errorf("snapshot candidates: %+v %w", items, e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if page := read([]string{a, b}, nil, 10); len(page) != 2 {
		t.Fatalf("revocation: %+v", page)
	}
	testutil.MustExec(t, db.Pool, `UPDATE project_pull_requests SET base_ref='release' WHERE project_id=$1 AND repository_id=30 AND github_id=10`, a)
	if page := read([]string{a}, nil, 10); len(page) != 1 || page[0].GitHubPRID != 20 {
		t.Fatalf("retarget: %+v", page)
	}
	// The old repository still has an assigned, open PR aimed at trunk. Keeping
	// access, selection and the default branch unchanged isolates the repository
	// identity check; the new repository's assigned PR remains visible.
	testutil.MustExec(t, db.Pool, `UPDATE project_github SET repository_id=31,repository_full_name='owner/new' WHERE project_id=$1`, a)
	if page := read([]string{a}, nil, 10); len(page) != 1 || page[0].RepositoryID != 31 || page[0].GitHubPRID != 80 || page[0].RepositoryFullName != "owner/new" {
		t.Fatalf("repository switch: %+v", page)
	}
	testutil.MustExec(t, db.Pool, `UPDATE project_github SET repository_default_branch=NULL WHERE project_id=$1`, a)
	if page := read([]string{a}, nil, 10); len(page) != 0 {
		t.Fatalf("unknown default: %+v", page)
	}
	var retained bool
	if err := db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM project_pr_review_assignments WHERE user_id=$1 AND project_id=$2 AND repository_id=30 AND github_pr_id=10)`, owner, a).Scan(&retained); err != nil || !retained {
		t.Fatalf("assignment lost: %v %v", retained, err)
	}
}

func TestReviewPollDAOErrors(t *testing.T) {
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	dao := reviewassignment.NewReader(db.Pool)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := dao.ReviewPollWorker(ctx, testutil.QueryID(1), testutil.QueryID(2)); !errors.Is(err, context.Canceled) {
		t.Fatalf("worker cancel: %v", err)
	}
	if _, err := dao.ReviewPollCandidates(ctx, testutil.QueryID(1), testutil.QueryID(2), []string{testutil.QueryID(3)}, nil, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("candidate cancel: %v", err)
	}
	if _, err := dao.ReviewPollCandidates(t.Context(), "invalid", testutil.QueryID(2), []string{testutil.QueryID(3)}, nil, 1); err == nil {
		t.Fatal("invalid UUID succeeded")
	}
	if got, err := dao.ReviewPollWorker(t.Context(), testutil.QueryID(1), testutil.QueryID(2)); err != nil || !reflect.DeepEqual(got, (*store.ReviewPollWorker)(nil)) {
		t.Fatalf("missing worker: %+v %v", got, err)
	}
}
