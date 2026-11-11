package webhook

import (
	"context"
	"testing"
	"time"

	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testParentDeletionHidesWebhookSources(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := t.Context()
	goal := uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO tasks(id,project_id,title,type) VALUES($1,$2,'goal','goal')`, goal, f.project); err != nil {
		t.Fatal(err)
	}
	var child string
	if err := f.conn.QueryRow(ctx, `UPDATE tasks SET parent_id=$1 WHERE id=(SELECT e.task_id FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE d.id=$2) RETURNING id::text`, goal, f.delivery).Scan(&child); err != nil {
		t.Fatal(err)
	}
	owner := wm.Owner{Kind: "personal", ID: f.user}
	before := time.Now().Add(time.Hour)
	baseline := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before)
	if _, err := f.conn.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, goal); err != nil {
		t.Fatal(err)
	}
	after := freshHistoryDisclosure(t, ctx, f.conn, owner, f.endpoint, f.user, before)
	want := expectedHistoryDisclosure("project:"+f.project+"\n", "task:"+goal+"\n", "task:"+child+"\n")
	if after == baseline || after != want {
		t.Fatalf("parent deletion fence=%s baseline=%s want=%s", after, baseline, want)
	}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := New(tx)
	batch, err := dao.HistoryBatch(ctx, owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 1 {
		t.Fatalf("history batch: %+v, %v", batch, err)
	}
	if batch.Items[0].Sources.TaskPresent || batch.Items[0].Sources.TaskTitle != nil {
		t.Fatalf("hidden task disclosed in batch: %+v", batch.Items[0].Sources)
	}
	source, err := dao.HistorySources(ctx, batch.Items[0].Delivery, f.user)
	if err != nil || source.TaskPresent || source.TaskTitle != nil {
		t.Fatalf("hidden task disclosed in history: %+v, %v", source, err)
	}
	admission, err := dao.AdmissionSources(ctx, f.delivery, time.Now())
	if err != nil || admission.TaskPresent {
		t.Fatalf("hidden task admitted: %+v, %v", admission, err)
	}
}
