package postgres

import (
	"testing"
	"time"
)

func TestGitHubCoverageMigrationRetainsWorkAndInitializesIntent(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := len(schemaMigrations) - 1
	if index < 1 || schemaMigrations[index].version != 87 {
		t.Fatal("unexpected migration boundary")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	active, unavailable, disabled := queryID(101), queryID(102), queryID(103)
	_, err := pool.Exec(ctx, `INSERT INTO project_github(project_id,version,generation,revision,enabled,sync_enabled,repository_id,access_state,not_before,last_full_success_at,last_full_generation,poll_error_code,claim_token,claim_until,claim_kind)
        VALUES($1,3,7,9,true,true,22,'available','2030-01-01','2020-01-01',7,'retained',$4,'2030-01-01','poll'),
        ($2,3,7,9,true,true,22,'unavailable','2030-01-01','2020-01-01',7,'retained',NULL,NULL,NULL),
        ($3,3,7,9,true,false,22,'available',NULL,'2020-01-01',7,NULL,NULL,NULL,NULL)`, active, unavailable, disabled, queryID(104))
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(ctx, `INSERT INTO project_github_pending_prs(project_id,number,generation,request_id,delivery_id,received_at,next_attempt_at) VALUES($1,5,7,$2,'delivery',now(),now())`, active, queryID(105))
	if err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var count int
	var sameBoundary bool
	err = pool.QueryRow(ctx, `SELECT count(*), min(started_at)=max(started_at) AND min(started_at)=date_trunc('second',min(started_at)) FROM project_github_coverage`).Scan(&count, &sameBoundary)
	if err != nil || count != 2 || !sameBoundary {
		t.Fatalf("coverage count %d common boundary %v err %v", count, sameBoundary, err)
	}
	var preserved bool
	err = pool.QueryRow(ctx, `SELECT version=3 AND generation=7 AND revision=10 AND last_full_generation IS NULL AND last_full_success_at='2020-01-01'::timestamptz AND not_before='2030-01-01'::timestamptz AND poll_error_code='retained' AND claim_token=$2 AND next_poll_at IS NOT NULL AND EXISTS (SELECT 1 FROM project_github_pending_prs WHERE project_id=$1 AND request_id=$3) FROM project_github WHERE project_id=$1`, active, queryID(104), queryID(105)).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("preserved work %v err %v", preserved, err)
	}
	err = pool.QueryRow(ctx, `SELECT revision=10 AND last_full_generation IS NULL AND next_poll_at IS NULL FROM project_github WHERE project_id=$1`, unavailable).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("unavailable %v err %v", preserved, err)
	}
	err = pool.QueryRow(ctx, `SELECT revision=9 AND last_full_generation=7 AND NOT EXISTS(SELECT 1 FROM project_github_coverage WHERE project_id=$1) FROM project_github WHERE project_id=$1`, disabled).Scan(&preserved)
	if err != nil || !preserved {
		t.Fatalf("disabled %v err %v", preserved, err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err = pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at) VALUES($1,22,$2)`, active, now.Add(time.Hour)); err == nil {
		t.Fatal("second open period accepted")
	}
	if _, err = pool.Exec(ctx, `INSERT INTO project_github_coverage(project_id,repository_id,started_at,ended_at) VALUES($1,99,$2,$2)`, disabled, now); err == nil {
		t.Fatal("empty period accepted")
	}
}
