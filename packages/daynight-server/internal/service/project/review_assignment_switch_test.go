package project

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/reviewassignment"
	"github.com/google/uuid"
)

type switchReviewBarrier struct {
	store.ReviewAssignmentStore
	entered, release chan struct{}
	inside           bool
}

func (s *switchReviewBarrier) WriteReviewAssignment(ctx context.Context, id string, work func(store.ReviewAssignmentWrite) error) (store.Completion, error) {
	if !s.inside {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	return s.ReviewAssignmentStore.WriteReviewAssignment(ctx, id, func(tx store.ReviewAssignmentWrite) error {
		if s.inside {
			close(s.entered)
			select {
			case <-s.release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return work(tx)
	})
}

// Both operations execute their production coordinators against the same DB.
// A barrier keeps a stale candidate in flight while the Project lock serializes
// the actual repository change and reviewer write in both possible orders.
func TestRepositorySwitchAndReviewAssignmentSerialize(t *testing.T) {
	for _, tc := range []struct {
		name                               string
		assignmentFirst, restoreRepository bool
	}{
		{"assignment first", true, false}, {"switch first", false, false}, {"stale target after switch", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assignmentFirst := tc.assignmentFirst
			app, db, actor, p := repositoryChangeFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			workerID := uuid.NewString()
			raw := fmt.Sprintf(`{"projects":[{"projectId":%q,"nativeOverrides":{}}]}`, p.ID)
			testutil.MustExec(t, db.Pool, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,review_enabled,configuration_revision,configuration_updated_at,desired_configuration) VALUES($1,$2,now(),now(),'{}','{}',true,1,now(),$3::jsonb)`, actor.UserID, workerID, raw)
			testutil.MustExec(t, db.Pool, `INSERT INTO project_github(project_id,repository_id,legacy_repository_id,repository_full_name) VALUES($1,30,30,'owner/old')`, p.ID)
			testutil.MustExec(t, db.Pool, `INSERT INTO project_github_repositories(project_id,repository_id,full_name) VALUES($1,30,'owner/old')`, p.ID)
			testutil.MustExec(t, db.Pool, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,1,10,'url','title','open',false,'main','sha',now(),now(),now(),1)`, p.ID)
			preview, err := app.RepositoryPreview(ctx, actor, p.ID, "https://example.com/new", actor.UserID)
			if err != nil || preview.Classification != "unverified" {
				t.Fatalf("preview %+v %v", preview, err)
			}
			change := repositoryChangeInput(preview, actor)
			change.TreatUnverifiedAsSwitch = true
			barrier := &switchReviewBarrier{ReviewAssignmentStore: db, entered: make(chan struct{}), release: make(chan struct{}), inside: assignmentFirst}
			reconciler := reviewassignment.New(barrier, nil)
			reviewDone := make(chan struct{})
			go func() { defer close(reviewDone); reconciler.Batch(ctx, 5) }()
			select {
			case <-barrier.entered:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			switchDone := make(chan error, 1)
			if tc.restoreRepository {
				// The verified switch runs first. Restore a matching repository fact
				// to isolate Worker target revalidation from the repository fence.
				if _, err := app.SetRepository(ctx, actor, p.ID, change); err != nil {
					t.Fatal(err)
				}
				testutil.MustExec(t, db.Pool, `UPDATE project_github SET repository_id=30 WHERE project_id=$1`, p.ID)
				switchDone <- nil
				close(barrier.release)
			} else if assignmentFirst {
				go func() { _, err := app.SetRepository(ctx, actor, p.ID, change); switchDone <- err }()
				testutil.WaitForQueryLock(t, db.Pool, "SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
				close(barrier.release)
			} else {
				// The switch holds Project while waiting for this Worker row; the reviewer
				// then tries the same Project lock using the candidate read before switch.
				holder, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer holder.Rollback(context.Background())
				if _, err := holder.Exec(ctx, `SELECT worker_id FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE`, actor.UserID, workerID); err != nil {
					t.Fatal(err)
				}
				go func() { _, err := app.SetRepository(ctx, actor, p.ID, change); switchDone <- err }()
				testutil.WaitForQueryLock(t, db.Pool, "SELECT configuration_revision,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2 FOR UPDATE")
				close(barrier.release)
				testutil.WaitForQueryLock(t, db.Pool, "SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE")
				if err := holder.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-switchDone:
				if err != nil {
					t.Fatal(err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case <-reviewDone:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var count int
			var covered bool
			if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_pr_review_assignments WHERE user_id=$1 AND project_id=$2 AND repository_id=30 AND github_pr_id=10), (SELECT desired_configuration @> jsonb_build_object('projects',jsonb_build_array(jsonb_build_object('projectId',$2::text))) FROM workers WHERE user_id=$1 AND worker_id=$3)`, actor.UserID, p.ID, workerID).Scan(&count, &covered); err != nil {
				t.Fatal(err)
			}
			expected := 0
			if assignmentFirst {
				expected = 1
			}
			if count != expected || covered {
				t.Fatalf("assignments=%d want=%d selection still present=%v", count, expected, covered)
			}
		})
	}
}
