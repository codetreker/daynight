package webhook_test

import (
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestRedeliveryRejectsMissingOriginalFactBeforeCommit(t *testing.T) {
	f := newCaptureFixture(t, 1)
	if _, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "source"}); err != nil {
		t.Fatal(err)
	}
	var endpoint, id string
	var beforeTicket int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text,queue_order FROM webhook_deliveries`).Scan(&endpoint, &id, &beforeTicket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=now() WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, id); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, DispatchEnabled: true}
	intent := webhook.Redelivery{OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: 1, IfGeneration: 1, RequestSHA256: strings.Repeat("a", 64)}
	if _, err := svc.Redeliver(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, endpoint, id, intent); err == nil {
		t.Fatal("missing fact was accepted")
	}
	var generation, ticket int64
	var manual, attempts, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT generation,queue_order,manual_operation_count,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1),(SELECT count(*) FROM webhook_operations WHERE operation_id=$2) FROM webhook_deliveries WHERE id=$1`, id, intent.OperationID).Scan(&generation, &ticket, &manual, &attempts, &receipts); err != nil {
		t.Fatal(err)
	}
	if generation != 1 || ticket != beforeTicket || manual != 0 || attempts != 0 || receipts != 0 {
		t.Fatalf("partial effect: generation=%d ticket=%d manual=%d attempts=%d receipts=%d", generation, ticket, manual, attempts, receipts)
	}
}
