package github_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestAssignPullRequestReviewer(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	tx := begin(t, f.db, pgx.TxOptions{})
	mustExec(t, tx, `INSERT INTO project_github(project_id,enabled,sync_enabled,access_state) VALUES($1,true,true,'available')`, f.project)
	insertPR(t, tx, f.project, 41, "open", "First", nil)
	insertPR(t, tx, f.project, 42, "closed", "Closed", nil)
	mustExec(t, tx, `UPDATE project_pull_requests SET draft=true WHERE project_id=$1 AND number=41`, f.project)
	selected := fmt.Sprintf(`{"projects":[{"projectId":%q}]}`, f.project)
	other := fmt.Sprintf(`{"projects":[{"projectId":%q}]}`, uuid.NewString())
	owner := uuid.NewString()
	foreign := uuid.NewString()
	for _, row := range []struct {
		user, id, configuration string
		enabled                 bool
		age                     string
	}{
		{f.p.UserID, owner, selected, false, "0 seconds"},
		{f.p.UserID, uuid.NewString(), selected, true, "3 minutes"},
		{f.p.UserID, uuid.NewString(), other, true, "0 seconds"},
		{foreign, uuid.NewString(), selected, true, "0 seconds"},
	} {
		mustExec(t, tx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration,review_enabled)
			VALUES($1,$2,now(),now()-$3::interval,'{}','{}',1,now(),$4,$5)`, row.user, row.id, row.age, row.configuration, row.enabled)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assign := func(want bool) {
		t.Helper()
		got, err := f.db.AssignPullRequestReviewer(ctx, 2*time.Minute)
		if err != nil || got != want {
			t.Fatalf("assignment = %v, %v, want %v", got, err, want)
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := f.db.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	assign(false)
	exec(`UPDATE workers SET review_enabled=true WHERE user_id=$1 AND worker_id=$2`, f.p.UserID, owner)

	var runs sync.WaitGroup
	success := make(chan bool, 8)
	for range cap(success) {
		runs.Go(func() {
			got, err := f.db.AssignPullRequestReviewer(ctx, 2*time.Minute)
			if err != nil {
				t.Error(err)
			}
			success <- got
		})
	}
	runs.Wait()
	close(success)
	wins := 0
	for got := range success {
		if got {
			wins++
		}
	}
	if wins != 1 {
		t.Fatalf("concurrent winners = %d, want 1", wins)
	}
	var worker string
	var assignedAt time.Time
	err := f.db.Pool.QueryRow(ctx, `SELECT worker_id::text,assigned_at FROM project_pull_request_reviewers WHERE project_id=$1 AND github_id=41`, f.project).Scan(&worker, &assignedAt)
	if err != nil || worker != owner || assignedAt.IsZero() {
		t.Fatalf("assignment = %q, %v, %v", worker, assignedAt, err)
	}

	exec(`UPDATE workers SET review_enabled=false WHERE user_id=$1 AND worker_id=$2`, f.p.UserID, owner)
	exec(`UPDATE project_pull_requests SET state='closed' WHERE project_id=$1 AND github_id=41`, f.project)
	exec(`UPDATE project_pull_requests SET state='open', head_sha='next-head' WHERE project_id=$1`, f.project)
	assign(false)

	replacement := uuid.NewString()
	exec(`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration,review_enabled)
		VALUES($1,$2,now(),now(),'{}','{}',1,now(),$3,true)`, f.p.UserID, replacement, selected)
	assign(true)
	assign(false)
	var sameBinding, newBinding bool
	err = f.db.Pool.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM project_pull_request_reviewers WHERE project_id=$1 AND github_id=41 AND worker_id=$2 AND assigned_at=$3),
		EXISTS (SELECT 1 FROM project_pull_request_reviewers WHERE project_id=$1 AND github_id=42 AND worker_id=$4)`, f.project, owner, assignedAt, replacement).Scan(&sameBinding, &newBinding)
	if err != nil || !sameBinding || !newBinding {
		t.Fatalf("bindings: retained %v, new %v, %v", sameBinding, newBinding, err)
	}
}

func TestAssignPullRequestReviewerRechecksRevokedAccess(t *testing.T) {
	f := newProjectAppFixture(t)
	ctx := t.Context()
	setup := begin(t, f.db, pgx.TxOptions{})
	mustExec(t, setup, `INSERT INTO project_github(project_id,enabled,sync_enabled,access_state) VALUES($1,true,true,'available')`, f.project)
	insertPR(t, setup, f.project, 41, "open", "Open", nil)
	config := fmt.Sprintf(`{"projects":[{"projectId":%q}]}`, f.project)
	mustExec(t, setup, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot,configuration_revision,configuration_updated_at,desired_configuration,review_enabled)
		VALUES($1,$2,now(),now(),'{}','{}',1,now(),$3,true)`, f.p.UserID, uuid.NewString(), config)
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	revocation := begin(t, f.db, pgx.TxOptions{})
	mustExec(t, revocation, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.p.UserID)
	allocation := begin(t, f.db, pgx.TxOptions{})
	var pid int
	if err := allocation.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	type decision struct {
		assigned bool
		err      error
	}
	result := make(chan decision, 1)
	go func() {
		assigned, err := github.AssignPullRequestReviewer(ctx, allocation, 2*time.Minute)
		result <- decision{assigned, err}
	}()
	waitForLock(t, f.db, pid)
	if err := revocation.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if got := <-result; got.err != nil || got.assigned {
		t.Fatalf("assignment after revoked access = %v, %v", got.assigned, got.err)
	}
	if err := allocation.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_pull_request_reviewers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("persisted assignments = %d, %v", count, err)
	}
}
