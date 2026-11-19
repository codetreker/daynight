package reviewassignment_test

import (
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"testing"
	"time"
)

func TestReviewAssignmentStoragePagingAndIdentity(t *testing.T) {
	s, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	ctx := t.Context()
	project := testutil.QueryProject(t, s.Pool, s, 1).ID
	var owner string
	if err := s.Pool.QueryRow(ctx, `SELECT m.user_id::text FROM project_ownership o JOIN team_members m ON m.team_id=o.team_id WHERE o.project_id=$1 AND m.role='admin' LIMIT 1`, project).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	first, second, other := testutil.QueryID(10), testutil.QueryID(11), testutil.QueryID(12)
	for _, id := range []string{first, second, other} {
		testutil.MustExec(t, s.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled,desired_configuration) VALUES($1,$2,now(),now(),'{}','{}',true,NULL)`, owner, id)
	}
	testutil.MustExec(t, s.Pool, `UPDATE workers SET review_enabled=false WHERE worker_id=$1`, other)
	start, upper, err := s.ReviewScanStart(ctx)
	if err != nil || upper == nil || upper.WorkerID != second {
		t.Fatalf("scan start: %v %+v %v", start, upper, err)
	}
	page, err := s.ReviewWorkers(ctx, start, *upper, nil, 1)
	if err != nil || len(page) != 1 || page[0].WorkerID != first {
		t.Fatalf("first worker page: %+v %v", page, err)
	}
	page, err = s.ReviewWorkers(ctx, start, *upper, &page[0].ReviewWorkerKey, 2)
	if err != nil || len(page) != 1 || page[0].WorkerID != second {
		t.Fatalf("second worker page: %+v %v", page, err)
	}
	testutil.MustExec(t, s.Pool, `INSERT INTO project_github(project_id,repository_id) VALUES($1,30)`, project)
	for n := int64(1); n <= 3; n++ {
		testutil.MustExec(t, s.Pool, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,$2,$2,'url','title','open',false,'main','sha',now(),now(),now(),1)`, project, n)
	}
	testutil.MustExec(t, s.Pool, `UPDATE project_pull_requests SET state='closed' WHERE project_id=$1 AND number=1`, project)
	repo, err := s.ReviewRepository(ctx, project)
	if err != nil || repo == nil || *repo != 30 {
		t.Fatalf("repo %v %v", repo, err)
	}
	pr, err := s.ReviewOpenPRs(ctx, owner, project, 30, nil, nil, 1)
	if err != nil || len(pr) != 1 || pr[0].Number != 3 || pr[0].Assigned {
		t.Fatalf("first pr page %+v %v", pr, err)
	}
	bound, anchor := pr[0].Number, pr[0].Number
	pr, err = s.ReviewOpenPRs(ctx, owner, project, 30, &bound, &anchor, 2)
	if err != nil || len(pr) != 1 || pr[0].Number != 2 {
		t.Fatalf("second pr page %+v %v", pr, err)
	}
	write := func(id string, repoID, githubID int64) (bool, error) {
		var inserted bool
		c, err := s.WriteReviewAssignment(ctx, project, func(w store.ReviewAssignmentWrite) error {
			var e error
			inserted, e = w.Insert(ctx, owner, repoID, githubID, id, time.Now().UTC())
			return e
		})
		if err == nil && c.Outcome != store.TransactionCommitted {
			return false, fmt.Errorf("unexpected completion %s", c.Outcome)
		}
		return inserted, err
	}
	if inserted, err := write(first, 30, 3); err != nil || !inserted {
		t.Fatalf("insert %v %v", inserted, err)
	}
	if inserted, err := write(second, 30, 3); err != nil || inserted {
		t.Fatalf("duplicate %v %v", inserted, err)
	}
	if inserted, err := write(second, 31, 3); err != nil || !inserted {
		t.Fatalf("other repository %v %v", inserted, err)
	}
	pr, err = s.ReviewOpenPRs(ctx, owner, project, 30, nil, nil, 2)
	if err != nil || len(pr) != 2 || !pr[0].Assigned || pr[1].Assigned {
		t.Fatalf("assignment flags %+v %v", pr, err)
	}
	if err := s.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		a, err := sc.(store.ReviewAssignmentSnapshot).ReviewAssignment(ctx, owner, project, 30, 3)
		if err != nil {
			return err
		}
		if a == nil || a.WorkerID != first || a.LastSeenAt == nil || a.ReviewEnabled == nil || !*a.ReviewEnabled {
			return fmt.Errorf("assignment %+v", a)
		}
		missing, err := sc.(store.ReviewAssignmentSnapshot).ReviewAssignment(ctx, testutil.QueryID(99), project, 30, 3)
		if err != nil || missing != nil {
			return fmt.Errorf("other account %+v %v", missing, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, s.Pool, `DELETE FROM workers WHERE user_id=$1 AND worker_id=$2`, owner, first)
	if err := s.ReadSnapshot(ctx, func(sc store.SnapshotScope) error {
		a, err := sc.(store.ReviewAssignmentSnapshot).ReviewAssignment(ctx, owner, project, 30, 3)
		if err != nil {
			return err
		}
		if a == nil || a.WorkerID != first || a.LastSeenAt != nil || a.ReviewEnabled != nil {
			return fmt.Errorf("missing worker %+v", a)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
