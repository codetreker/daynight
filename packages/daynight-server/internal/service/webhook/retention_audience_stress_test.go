//go:build stress

package webhook_test

import (
	"os"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

func TestRetentionLargeRealAudienceStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	f := newCaptureFixture(t, 501)
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "large retention audience"}); err != nil {
		t.Fatal(err)
	}
	var id string
	var original int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,original_match_count FROM webhook_deliveries`).Scan(&id, &original); err != nil || original != 501 {
		t.Fatalf("capture %d: %v", original, err)
	}
	ageRetention(t, f, id, 40*24*time.Hour)
	r := webhook.NewRetention(f.db)
	n, more, err := r.Pass(f.ctx)
	if err != nil || n != 500 || !more {
		t.Fatalf("first pass %d %v %v", n, more, err)
	}
	var closed bool
	var matches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT purging_at IS NOT NULL,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$1) FROM webhook_deliveries WHERE id=$1`, id).Scan(&closed, &matches); err != nil || !closed || matches != 2 {
		t.Fatalf("interrupted state %v %d %v", closed, matches, err)
	}
	// A new component resumes from persisted closure, with no in-memory cursor.
	r = webhook.NewRetention(f.db)
	n, _, err = r.Pass(f.ctx)
	if err != nil || n != 4 {
		t.Fatalf("resumed %d %v", n, err)
	}
	var remaining int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_deliveries)+(SELECT count(*) FROM webhook_delivery_matches)+(SELECT count(*) FROM webhook_events)`).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining %d %v", remaining, err)
	}
}

func TestRetentionPurgeBacklogDoesNotStarvePayloadStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	f := newCaptureFixture(t, 501)
	tasks := taskservice.NewTasks(f.db, f.capture)
	first, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "old backlog"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "expired payload"})
	if err != nil {
		t.Fatal(err)
	}
	var oldID, newID string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1`, first.ID).Scan(&oldID); err != nil {
		t.Fatal(err)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1`, second.ID).Scan(&newID); err != nil {
		t.Fatal(err)
	}
	ageRetention(t, f, oldID, 40*24*time.Hour)
	ageRetention(t, f, newID, 8*24*time.Hour)
	n, _, err := webhook.NewRetention(f.db).Pass(f.ctx)
	if err != nil || n != 500 {
		t.Fatalf("pass %d: %v", n, err)
	}
	var removed, factRemoved bool
	var oldMatches int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.body IS NULL,e.fact_bytes IS NULL,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2) FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.id=$1`, newID, oldID).Scan(&removed, &factRemoved, &oldMatches); err != nil || !removed || !factRemoved || oldMatches == 0 {
		t.Fatalf("payload starved or backlog absent: %t %t %d %v", removed, factRemoved, oldMatches, err)
	}
}

func TestRetentionSharedBudgetWhenHistoryRunsFirstStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	f := newCaptureFixture(t, 496)
	gc := webhook.NewRetention(f.db)
	for i := 0; i < 2; i++ {
		if _, _, err := gc.Pass(f.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "budget"}); err != nil {
		t.Fatal(err)
	}
	var id string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	ageRetention(t, f, id, 40*24*time.Hour)
	_, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_operations SET recorded_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day'`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_operations(owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,recorded_at,expires_at) SELECT owner_kind,owner_id,gen_random_uuid(),actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,recorded_at,expires_at FROM webhook_operations CROSS JOIN generate_series(1,2)`)
	if err != nil {
		t.Fatal(err)
	}
	n, _, err := gc.Pass(f.ctx)
	if err != nil || n != 500 {
		t.Fatalf("history-first count=%d err=%v", n, err)
	}
	var receipts, deliveries int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_operations),(SELECT count(*) FROM webhook_deliveries)`).Scan(&receipts, &deliveries); err != nil || receipts != 2 || deliveries != 0 {
		t.Fatalf("budget receipts=%d deliveries=%d err=%v", receipts, deliveries, err)
	}
}
