package webhook

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestDeliveryQueueOrderDoesNotRewindOnRollback(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first, err := New(tx).NextQueueOrder(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := New(tx).NextQueueOrder(ctx)
	if err != nil || second <= first {
		t.Fatalf("queue order reused after rollback: first=%d next=%d error=%v", first, second, err)
	}
	row, err := New(tx).LockDelivery(ctx, f.delivery)
	if err != nil {
		t.Fatal(err)
	}
	row.QueueOrder = second
	if err = New(tx).UpdateDelivery(ctx, row); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var stored int64
	if err = f.conn.QueryRow(ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, f.delivery).Scan(&stored); err != nil || stored != second {
		t.Fatalf("queue ticket not persisted: %d %v", stored, err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `ALTER SEQUENCE webhook_delivery_queue_order_seq RENAME TO unavailable_queue_order`); err != nil {
		t.Fatal(err)
	}
	if ticket, err := New(tx).NextQueueOrder(ctx); ticket != 0 || err == nil {
		t.Fatalf("missing allocator appeared successful: %d %v", ticket, err)
	} else {
		assertMissingRelation(t, err)
	}
}

func TestCurrentDestinationFollowsRevisionAndTombstone(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	owner := wm.Owner{Kind: "personal", ID: f.user}
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := New(tx)
	if current, err := dao.CurrentDestination(ctx, f.endpoint, 1); err != nil || !current {
		t.Fatalf("current revision missing: %v %v", current, err)
	}
	ep, err := dao.LockEndpoint(ctx, owner, f.endpoint)
	if err != nil {
		t.Fatal(err)
	}
	ep.DestinationRevision = 2
	if err = dao.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao = New(tx)
	for _, revision := range []int64{1, 2} {
		current, err := dao.CurrentDestination(ctx, f.endpoint, revision)
		if err != nil || current != (revision == 2) {
			t.Fatalf("destination revision %d: %v %v", revision, current, err)
		}
	}
	deleted := time.Now().UTC().Truncate(time.Microsecond)
	ep.DeletedAt, ep.Enabled, ep.UpdatedAt = &deleted, false, deleted
	ep.Name, ep.DestinationKind, ep.AdapterVersion, ep.Origin, ep.ActiveKeyID = "", "", "", "", ""
	ep.DestinationConfiguration = nil
	if err = dao.PutEndpoint(ctx, ep); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if current, err := New(tx).CurrentDestination(ctx, f.endpoint, 2); err != nil || current {
		t.Fatalf("deleted destination remained current: %v %v", current, err)
	}
	if _, err = tx.Exec(ctx, `ALTER TABLE webhook_endpoints RENAME TO unavailable_destination`); err != nil {
		t.Fatal(err)
	}
	if current, err := New(tx).CurrentDestination(ctx, f.endpoint, 2); current || err == nil {
		t.Fatalf("destination storage failure became an observation: %v %v", current, err)
	} else {
		assertMissingRelation(t, err)
	}
}

func TestAttemptManualIdentityRoundTripAndDuplicateRefusal(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	operation := uuid.NewString()
	at := time.Now().UTC().Truncate(time.Microsecond)
	a := store.WebhookAttempt{ID: uuid.NewString(), DeliveryID: f.delivery, EndpointID: f.endpoint, Trigger: "manual", LeaseToken: uuid.NewString(), Generation: 2, DestinationRevision: 1, Sequence: 1, SigningKeyIDs: []string{uuid.NewString()}, ManualOperationID: &operation, ClaimedAt: at, AdmittedAt: at}
	if err = New(tx).InsertAttempt(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rows, err := New(tx).HistoryAttempts(ctx, f.delivery)
	if err != nil || len(rows) != 1 || rows[0].ID != a.ID || rows[0].Trigger != "manual" || rows[0].AutomaticPlanSlot != nil || rows[0].ManualOperationID == nil || *rows[0].ManualOperationID != operation {
		t.Fatalf("manual identity readback: %+v %v", rows, err)
	}
	if err = New(tx).InsertAttempt(ctx, a); err == nil {
		t.Fatal("duplicate attempt accepted")
	}
	failed, state := store.DatabaseErrorFacts(err)
	if !failed || state != "23505" {
		t.Fatalf("duplicate attempt lost SQL identity failure: %q %v", state, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = f.conn.QueryRow(ctx, `SELECT count(*) FROM webhook_attempts WHERE id=$1`, a.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate changed original attempt: %d %v", count, err)
	}
}

func TestHistoryKeysetCursorSelectsOnlyFollowingDelivery(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	event, prepared := captureBoundaryRecords(t, ctx, tx, f.delivery, 2)
	event.ID = uuid.NewString()
	event.OccurredAt = event.OccurredAt.Add(time.Microsecond)
	for i := range prepared.AutomaticScheduleAt {
		prepared.AutomaticScheduleAt[i] = prepared.AutomaticScheduleAt[i].Add(time.Microsecond)
	}
	prepared.AutomaticExpiresAt = prepared.AutomaticExpiresAt.Add(time.Microsecond)
	prepared.PayloadExpiresAt = prepared.PayloadExpiresAt.Add(time.Microsecond)
	if err = New(tx).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{prepared}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := New(tx)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	first, err := dao.HistoryDeliveries(ctx, owner, f.endpoint, time.Time{}, "", 1)
	if err != nil || len(first) != 1 || first[0].ID != f.delivery {
		t.Fatalf("first history page: %+v %v", first, err)
	}
	next, err := dao.HistoryDeliveries(ctx, owner, f.endpoint, first[0].OccurredAt, first[0].ID, 1)
	if err != nil || len(next) != 1 || next[0].ID != prepared.ID {
		t.Fatalf("nonempty history cursor repeated/lost delivery: %+v %v", next, err)
	}
	last, err := dao.HistoryDeliveries(ctx, owner, f.endpoint, next[0].OccurredAt, next[0].ID, 1)
	if err != nil || len(last) != 0 {
		t.Fatalf("history tail was not empty: %+v %v", last, err)
	}
}

func TestHistorySourcesDistinguishTombstonesMissingFactsAndStorageFailures(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	row, err := New(tx).LockDelivery(ctx, f.delivery)
	if err != nil {
		t.Fatal(err)
	}
	sources, err := New(tx).HistorySources(ctx, row, f.user)
	if err != nil || !sources.TaskPresent || !sources.ProjectReadable || sources.TaskTitle == nil || *sources.TaskTitle != "task" || len(sources.Matches) != 1 || !sources.Matches[0].Continuous || !bytes.Equal(sources.Event.FactBytes, row.Body) {
		t.Fatalf("history current source/proof: %+v %v", sources, err)
	}
	if _, err = tx.Exec(ctx, `UPDATE tasks SET deleted_at=statement_timestamp() WHERE id=$1`, sources.Event.TaskID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE webhook_bindings SET deleted_at=statement_timestamp() WHERE id=$1`, sources.Matches[0].BindingID); err != nil {
		t.Fatal(err)
	}
	tombstone, err := New(tx).HistorySources(ctx, row, f.user)
	if err != nil || tombstone.TaskPresent || tombstone.TaskTitle != nil || tombstone.ProjectReadable || len(tombstone.Matches) != 1 || tombstone.Matches[0].Continuous {
		t.Fatalf("history ignored source/proof changes: %+v %v", tombstone, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"webhook_events", "tasks", "projects", "webhook_delivery_matches"} {
		t.Run(table, func(t *testing.T) {
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if _, err = tx.Exec(ctx, `ALTER TABLE `+pgx.Identifier{table}.Sanitize()+` RENAME TO unavailable_history_source`); err != nil {
				t.Fatal(err)
			}
			_, err = New(tx).HistorySources(ctx, row, f.user)
			assertMissingRelation(t, err)
		})
	}
	tx, err = f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	missing := row
	missing.EventID = uuid.NewString()
	if _, err = New(tx).HistorySources(ctx, missing, f.user); !errors.Is(err, store.ErrWebhookHistoryEventMissing) {
		t.Fatalf("missing immutable event was not distinguished: %v", err)
	}
	if _, err = tx.Exec(ctx, `ALTER TABLE webhook_delivery_matches ALTER COLUMN authorization_epoch DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE webhook_delivery_matches SET authorization_epoch=NULL WHERE delivery_id=$1`, row.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = New(tx).HistorySources(ctx, row, f.user); err == nil {
		t.Fatal("NULL original authorization proof silently decoded")
	}
}

func TestRetentionPolicyRequiresStoredVersion(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	seconds, err := New(tx).RetentionSeconds(ctx, 1)
	if err != nil || seconds != 30*24*60*60 {
		t.Fatalf("version one metadata retention: %d %v", seconds, err)
	}
	if value, err := New(tx).RetentionSeconds(ctx, 2); value != 0 || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing policy became a default: %d %v", value, err)
	}
}
