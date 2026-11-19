package reviewassignment

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
)

func TestReviewWorkersUsesIndexOrdering(t *testing.T) {
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	_, err = conn.Exec(ctx, `CREATE TABLE workers (user_id uuid NOT NULL,worker_id uuid NOT NULL,created_at timestamptz NOT NULL,last_seen_at timestamptz NOT NULL,review_enabled boolean NOT NULL,desired_configuration jsonb,PRIMARY KEY(user_id,worker_id));
 CREATE INDEX workers_review_participants ON workers(user_id,worker_id) WHERE review_enabled;
 INSERT INTO workers SELECT md5('user'||(g/100))::uuid,md5('worker'||g)::uuid,now(),now(),g%10=0,NULL FROM generate_series(1,10000) g;
 ANALYZE workers;
 SET enable_seqscan=off`)
	if err != nil {
		t.Fatal(err)
	}
	var plan []byte
	err = conn.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+reviewWorkersSQL, time.Now().Add(time.Hour), "ffffffff-ffff-ffff-ffff-ffffffffffff", "ffffffff-ffff-ffff-ffff-ffffffffffff", "00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000", 64).Scan(&plan)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(plan), `"Index Name": "workers_review_participants"`) || strings.Contains(string(plan), `"Node Type": "Sort"`) {
		t.Fatalf("worker scan lost index ordering: %s", plan)
	}
}

func TestReviewOpenPRsUsesBoundedAssignmentLookups(t *testing.T) {
	ctx := t.Context()
	conn, err := pgx.Connect(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := conn.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	_, err = conn.Exec(ctx, `CREATE TABLE project_pull_requests(project_id uuid NOT NULL,repository_id bigint NOT NULL,number bigint NOT NULL,github_id bigint NOT NULL,state text NOT NULL,PRIMARY KEY(project_id,repository_id,number));
 CREATE INDEX project_pull_requests_state_number ON project_pull_requests(project_id,repository_id,state,number DESC);
 CREATE TABLE project_pr_review_assignments(user_id uuid NOT NULL,project_id uuid NOT NULL,repository_id bigint NOT NULL,github_pr_id bigint NOT NULL,PRIMARY KEY(user_id,project_id,repository_id,github_pr_id));
 INSERT INTO project_pull_requests SELECT '00000000-0000-4000-8000-000000000001',30,g,g,CASE WHEN g%12=0 THEN 'open' ELSE 'closed' END FROM generate_series(1,1000) g;
 INSERT INTO project_pr_review_assignments SELECT '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001',30,g FROM generate_series(1,5000) g;
 ANALYZE project_pull_requests; ANALYZE project_pr_review_assignments; SET enable_seqscan=off`)
	if err != nil {
		t.Fatal(err)
	}
	var plan []byte
	err = conn.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+reviewOpenPRsSQL, "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", int64(30), int64(900), int64(800), 25).Scan(&plan)
	if err != nil {
		t.Fatal(err)
	}
	text := string(plan)
	if !strings.Contains(text, `"Index Name": "project_pull_requests_state_number"`) || !strings.Contains(text, `"Index Name": "project_pr_review_assignments_pkey"`) || strings.Contains(text, `"Node Type": "Seq Scan"`) || strings.Contains(text, `"Node Type": "Sort"`) {
		t.Fatalf("PR scan lost bounded index lookups: %s", plan)
	}
}
