package webhook

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func cloneHistoryDelivery(t *testing.T, f deliveryFailureFixture) string {
	t.Helper()
	ctx := t.Context()
	task, event, delivery := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := f.conn.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'another task')`, task, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO webhook_events(id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,task_deleted_at,step_id,message_id,occurred_at,recorded_at,origin_request_id,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes,fact_removed_at)
	 SELECT $2::uuid,event_type,wire_version,schema_version,source,'tasks/'||$3::uuid::text,project_id,$3::uuid,task_version,task_deleted_at,step_id,message_id,occurred_at,recorded_at,origin_request_id,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes,fact_removed_at
	 FROM webhook_events WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, f.delivery, event, task); err != nil {
		t.Fatal(err)
	}
	columns := strings.Split(deliveryColumns, ",")
	values := make([]string, len(columns))
	for i, c := range columns {
		columns[i] = strings.Split(c, "::")[0]
		values[i] = "d." + columns[i]
		if columns[i] == "id" {
			values[i] = "$2::uuid"
		}
		if columns[i] == "event_id" {
			values[i] = "$3::uuid"
		}
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO webhook_deliveries (`+strings.Join(columns, ",")+`) SELECT `+strings.Join(values, ",")+` FROM webhook_deliveries d WHERE d.id=$1`, f.delivery, delivery, event); err != nil {
		t.Fatal(err)
	}
	if _, err := f.conn.Exec(ctx, `INSERT INTO webhook_delivery_matches(delivery_id,subscription_id,binding_id,project_id,event_type,authorization_epoch) SELECT $2,subscription_id,binding_id,project_id,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1`, f.delivery, delivery); err != nil {
		t.Fatal(err)
	}
	return delivery
}

func insertHistoryAttempt(t *testing.T, conn *pgx.Conn, delivery string, sequence int16) string {
	t.Helper()
	id := uuid.NewString()
	_, err := conn.Exec(t.Context(), `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at)
	 SELECT $2,d.id,d.endpoint_id,d.generation,$3,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],1,now(),now()
	 FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, delivery, id, sequence)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func testHistoryBatchJoinsFactsAndGroupsBothCollections(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	second := cloneHistoryDelivery(t, f)
	firstAttempt := insertHistoryAttempt(t, f.conn, f.delivery, 1)
	secondAttempt := insertHistoryAttempt(t, f.conn, second, 1)
	tx, err := f.conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	d := New(tx)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	batch, err := d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 2 || batch.ObservedAt.IsZero() {
		t.Fatalf("batch=%+v error=%v", batch, err)
	}
	var ids []string
	for _, item := range batch.Items {
		ids = append(ids, item.Delivery.ID)
		if !item.EventPresent || item.Sources.Event.ID != item.Delivery.EventID || !item.Sources.TaskPresent || item.Sources.TaskTitle == nil || !item.Sources.ProjectReadable || !item.EndpointPresent || item.EndpointRevision == nil || *item.EndpointRevision != 1 {
			t.Fatalf("joined facts=%+v", item)
		}
		if !item.Eligibility.ProjectLive || !item.Eligibility.TeamPresent || !item.Eligibility.ActorAccess || !item.Eligibility.OwnerAccess || item.Eligibility.TeamID == nil || *item.Eligibility.TeamID != f.team {
			t.Fatalf("eligibility=%+v", item.Eligibility)
		}
		if !bytes.Equal(item.Sources.Event.FactBytes, item.Delivery.Body) {
			t.Fatal("source bytes changed")
		}
	}
	if ids[0] > ids[1] {
		t.Fatalf("equal-time keyset order=%v", ids)
	}
	matches, err := d.HistoryMatches(t.Context(), ids)
	if err != nil || len(matches) != 2 || matches[0].DeliveryID != ids[0] || matches[1].DeliveryID != ids[1] || !matches[0].Continuous || !matches[1].Continuous {
		t.Fatalf("matches=%+v error=%v", matches, err)
	}
	attempts, err := d.HistoryBatchAttempts(t.Context(), ids)
	if err != nil || len(attempts) != 2 {
		t.Fatalf("attempts=%+v error=%v", attempts, err)
	}
	got := map[string]string{}
	for _, a := range attempts {
		got[a.DeliveryID] = a.ID
	}
	if got[f.delivery] != firstAttempt || got[second] != secondAttempt {
		t.Fatalf("attempt grouping=%v", got)
	}
	next, err := d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, batch.Items[0].Delivery.OccurredAt, ids[0], 100)
	if err != nil || len(next.Items) != 1 || next.Items[0].Delivery.ID != ids[1] {
		t.Fatalf("next=%+v error=%v", next, err)
	}
	empty, err := d.HistoryBatch(t.Context(), owner, uuid.NewString(), f.user, time.Time{}, "", 100)
	if err != nil || len(empty.Items) != 0 {
		t.Fatalf("empty=%+v error=%v", empty, err)
	}
}

func testHistoryBatchKeepsMissingEventsAndCurrentTombstones(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	tx, err := f.conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(t.Context(), `UPDATE tasks SET deleted_at=statement_timestamp() WHERE project_id=$1`, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `UPDATE webhook_bindings SET deleted_at=statement_timestamp() WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE endpoint_id=$1)`, f.endpoint); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user); err != nil {
		t.Fatal(err)
	}
	d := New(tx)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	batch, err := d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 1 {
		t.Fatalf("batch=%+v error=%v", batch, err)
	}
	item := batch.Items[0]
	if !item.EventPresent || item.Sources.TaskPresent || item.Sources.TaskTitle != nil || item.Sources.ProjectReadable || item.Eligibility.OwnerAccess {
		t.Fatalf("tombstone facts=%+v", item)
	}
	matches, err := d.HistoryMatches(t.Context(), []string{f.delivery})
	if err != nil || len(matches) != 1 || matches[0].Continuous {
		t.Fatalf("original matches lost=%+v error=%v", matches, err)
	}
	if _, err = tx.Exec(t.Context(), `DELETE FROM webhook_events WHERE id=$1`, item.Delivery.EventID); err != nil {
		t.Fatal(err)
	}
	batch, err = d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 1 || batch.Items[0].EventPresent || batch.Items[0].Delivery.ID != f.delivery {
		t.Fatalf("missing Event hid Delivery: %+v error=%v", batch, err)
	}
}

func testHistoryBatchReadsOneRepeatableReadSnapshot(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	ctx := t.Context()
	tx, err := f.conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	d := New(tx)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	batch, err := d.HistoryBatch(ctx, owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 1 {
		t.Fatalf("initial=%+v error=%v", batch, err)
	}
	other, err := pgx.ConnectConfig(ctx, f.conn.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close(context.Background())
	if _, err = other.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, f.team, f.user); err != nil {
		t.Fatal(err)
	}
	if _, err = other.Exec(ctx, `UPDATE webhook_bindings SET deleted_at=statement_timestamp() WHERE subscription_id IN (SELECT id FROM webhook_subscriptions WHERE endpoint_id=$1)`, f.endpoint); err != nil {
		t.Fatal(err)
	}
	insertHistoryAttempt(t, other, f.delivery, 1)
	matches, err := d.HistoryMatches(ctx, []string{f.delivery})
	if err != nil || len(matches) != 1 || !matches[0].Continuous {
		t.Fatalf("snapshot matches=%+v error=%v", matches, err)
	}
	attempts, err := d.HistoryBatchAttempts(ctx, []string{f.delivery})
	if err != nil || len(attempts) != 0 {
		t.Fatalf("snapshot attempts=%+v error=%v", attempts, err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	fresh, err := other.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Rollback(context.Background())
	current, err := New(fresh).HistoryBatch(ctx, owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(current.Items) != 1 || current.Items[0].Eligibility.OwnerAccess || current.Items[0].Sources.ProjectReadable {
		t.Fatalf("fresh facts=%+v error=%v", current, err)
	}
	matches, err = New(fresh).HistoryMatches(ctx, []string{f.delivery})
	if err != nil || len(matches) != 1 || matches[0].Continuous {
		t.Fatalf("fresh matches=%+v error=%v", matches, err)
	}
	attempts, err = New(fresh).HistoryBatchAttempts(ctx, []string{f.delivery})
	if err != nil || len(attempts) != 1 {
		t.Fatalf("fresh attempts=%+v error=%v", attempts, err)
	}
}

func testHistoryBatchPropagatesActualRowsAndQueryFailures(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	failure := errors.New("batch partial read failed")
	for _, read := range []struct {
		name, relation string
		run            func(*DAO) error
	}{
		{"batch", "webhook_events", func(d *DAO) error {
			_, e := d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100)
			return e
		}},
		{"matches", "webhook_delivery_matches", func(d *DAO) error { _, e := d.HistoryMatches(t.Context(), []string{f.delivery}); return e }},
		{"attempts", "webhook_attempts", func(d *DAO) error { _, e := d.HistoryBatchAttempts(t.Context(), []string{f.delivery}); return e }},
	} {
		t.Run(read.name, func(t *testing.T) {
			if read.name == "attempts" {
				insertHistoryAttempt(t, f.conn, f.delivery, 1)
			}
			for _, phase := range []string{"relation", "scan", "iteration"} {
				t.Run(phase, func(t *testing.T) {
					tx, err := f.conn.Begin(t.Context())
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(context.Background())
					if phase == "relation" {
						if _, err = tx.Exec(t.Context(), `ALTER TABLE `+pgx.Identifier{read.relation}.Sanitize()+` RENAME TO unavailable_batch_relation`); err != nil {
							t.Fatal(err)
						}
						assertMissingRelation(t, read.run(New(tx)))
						return
					}
					wrapped := historyFaultTx{Tx: tx}
					if phase == "scan" {
						wrapped.scanFailure = failure
					} else {
						wrapped.iterationFailure = failure
					}
					if err = read.run(New(wrapped)); !errors.Is(err, failure) {
						t.Fatalf("error chain=%v", err)
					}
				})
			}
		})
	}
}

func testHistoryBatchDistinguishesReclaimedFactsFromMissingRequiredFields(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	tx, err := f.conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	d := New(tx)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	if _, err = tx.Exec(t.Context(), `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=statement_timestamp() WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, f.delivery); err != nil {
		t.Fatal(err)
	}
	batch, err := d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100)
	if err != nil || len(batch.Items) != 1 || !batch.Items[0].EventPresent || batch.Items[0].Sources.Event.FactBytes != nil || batch.Items[0].Sources.FactRemovedAt == nil {
		t.Fatalf("reclaimed Event=%+v error=%v", batch, err)
	}
	if _, err = tx.Exec(t.Context(), `ALTER TABLE webhook_events ALTER COLUMN event_type DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `UPDATE webhook_events SET event_type=NULL WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, f.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = d.HistoryBatch(t.Context(), owner, f.endpoint, f.user, time.Time{}, "", 100); err == nil {
		t.Fatal("required joined Event field silently defaulted")
	}
	if err = tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	tx, err = f.conn.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(t.Context(), `ALTER TABLE webhook_delivery_matches ALTER COLUMN authorization_epoch DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), `UPDATE webhook_delivery_matches SET authorization_epoch=NULL WHERE delivery_id=$1`, f.delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = New(tx).HistoryMatches(t.Context(), []string{f.delivery}); err == nil {
		t.Fatal("required original proof field silently defaulted")
	}
}

func testHistoryBatchCancellationReleasesThePoolConnection(t *testing.T, conn *pgx.Conn) {
	f := newDeliveryFailureFixture(t, conn)
	owner := wm.Owner{Kind: "personal", ID: f.user}
	config, err := pgxpool.ParseConfig(f.conn.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	for _, read := range []struct {
		name, relation string
		run            func(context.Context, *DAO) error
	}{
		{"batch", "webhook_events", func(ctx context.Context, d *DAO) error {
			_, e := d.HistoryBatch(ctx, owner, f.endpoint, f.user, time.Time{}, "", 100)
			return e
		}},
		{"matches", "webhook_delivery_matches", func(ctx context.Context, d *DAO) error { _, e := d.HistoryMatches(ctx, []string{f.delivery}); return e }},
		{"attempts", "webhook_attempts", func(ctx context.Context, d *DAO) error {
			_, e := d.HistoryBatchAttempts(ctx, []string{f.delivery})
			return e
		}},
	} {
		t.Run(read.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			blocker, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			if _, err = blocker.Exec(ctx, `LOCK TABLE `+pgx.Identifier{read.relation}.Sanitize()+` IN ACCESS EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			conn, err := pool.Acquire(ctx)
			if err != nil {
				t.Fatal(err)
			}
			pid := conn.Conn().PgConn().PID()
			tx, err := conn.Begin(ctx)
			if err != nil {
				conn.Release()
				t.Fatal(err)
			}
			queryCtx, stop := context.WithCancel(ctx)
			defer stop()
			done := make(chan error, 1)
			go func() {
				err := read.run(queryCtx, New(tx))
				cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
				defer cancel()
				_ = tx.Rollback(cleanup)
				conn.Release()
				done <- err
			}()
			tick := time.NewTicker(time.Millisecond)
			defer tick.Stop()
			for {
				var waiting bool
				if err = blocker.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')`, pid).Scan(&waiting); err != nil {
					stop()
					<-done
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case <-ctx.Done():
					stop()
					<-done
					t.Fatal("batch query never waited for relation lock")
				case <-tick.C:
				}
			}
			stop()
			select {
			case err = <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancel error=%v", err)
				}
			case <-ctx.Done():
				t.Fatal("cancelled query did not exit")
			}
			if err = blocker.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			var one int
			if err = pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
				t.Fatalf("pool unavailable after cancellation: %d %v", one, err)
			}
		})
	}
}
