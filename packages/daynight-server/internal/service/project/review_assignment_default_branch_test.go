package project

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/reviewassignment"
	"github.com/google/uuid"
)

// The candidate is read before the update, but assignment must use the facts
// observed after the write transaction acquires its locks.
func TestReviewAssignmentRechecksBranchAfterScan(t *testing.T) {
	for _, tc := range []struct{ name, update string }{
		{"retargeted PR", `UPDATE project_pull_requests SET base_ref='release' WHERE project_id=$1 AND repository_id=30 AND number=1`},
		{"changed default", `UPDATE project_github SET repository_default_branch='trunk' WHERE project_id=$1`},
		{"unknown default", `UPDATE project_github SET repository_default_branch=NULL WHERE project_id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, db, actor, p := repositoryChangeFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			workerID := uuid.NewString()
			raw := fmt.Sprintf(`{"projects":[{"projectId":%q,"nativeOverrides":{}}]}`, p.ID)
			testutil.MustExec(t, db.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,now(),now(),'{}','{}',true,1,now(),$3::jsonb)`, actor.UserID, workerID, raw)
			testutil.MustExec(t, db.Pool, `INSERT INTO project_github(project_id,repository_id,repository_default_branch) VALUES($1,30,'main')`, p.ID)
			testutil.MustExec(t, db.Pool, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,1,10,'url','title','open',false,'main','sha',now(),now(),now(),1)`, p.ID)
			barrier := &switchReviewBarrier{ReviewAssignmentStore: db, entered: make(chan struct{}), release: make(chan struct{})}
			done := make(chan struct{})
			go func() { defer close(done); reviewassignment.New(barrier, nil).Batch(ctx, 5) }()
			select {
			case <-barrier.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			testutil.MustExec(t, db.Pool, tc.update, p.ID)
			close(barrier.release)
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var count int
			if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pr_review_assignments WHERE project_id=$1 AND github_pr_id=10`, p.ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("stale candidate assigned: count=%d err=%v", count, err)
			}
		})
	}
}
