package webhook

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestRetentionChildrenHonorSQLBudgetAcrossFreshDAOs(t *testing.T) {
	// This is the functional 500-row SQL boundary, not a throughput workload.
	// The second shape crosses the attempt query's remaining-budget LIMIT.
	for _, shape := range []struct {
		name                                                   string
		matches, attempts, remainingMatches, remainingAttempts int
	}{
		{"match limit", 501, 1, 1, 1},
		{"attempt remaining limit", 499, 2, 0, 1},
	} {
		t.Run(shape.name, func(t *testing.T) {
			f := newRetentionStorageFixture(t, 1, shape.matches, shape.attempts)
			ctx := t.Context()
			id := f.deliveries[0]
			tx, err := f.conn.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			dao := New(tx)
			if n, err := dao.CloseRetention(ctx, id, time.Now()); err != nil || n != 1+shape.attempts {
				t.Fatalf("closure: %d %v", n, err)
			}
			if n, err := dao.DeleteRetentionChildren(ctx, id, 500); err != nil || n != 500 {
				t.Fatalf("bounded first delete: %d %v", n, err)
			}
			if n, err := dao.DeleteRetainedDelivery(ctx, id); err != nil || n != 0 {
				t.Fatalf("delivery deleted while children remain: %d %v", n, err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			fresh, err := pgx.Connect(ctx, f.conn.Config().ConnString())
			if err != nil {
				t.Fatal(err)
			}
			defer fresh.Close(context.Background())
			var closed bool
			var matches, attempts, originalMatches int
			if err = fresh.QueryRow(ctx, `SELECT purging_at IS NOT NULL,original_match_count,(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$1),(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1) FROM webhook_deliveries WHERE id=$1`, id).Scan(&closed, &originalMatches, &matches, &attempts); err != nil || !closed || originalMatches != shape.matches || matches != shape.remainingMatches || attempts != shape.remainingAttempts {
				t.Fatalf("persisted bounded state: closed=%v original=%d matches=%d attempts=%d error=%v", closed, originalMatches, matches, attempts, err)
			}
			tx, err = fresh.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			dao = New(tx)
			row, found, err := dao.LockRetentionCandidate(ctx, "purge", time.Now())
			if err != nil || !found || row.ID != id {
				t.Fatalf("fresh purge could not resume closure: found=%v id=%s error=%v", found, row.ID, err)
			}
			if n, err := dao.DeleteRetentionChildren(ctx, id, 500); err != nil || n != shape.remainingMatches+shape.remainingAttempts {
				t.Fatalf("resumed child delete: %d %v", n, err)
			}
			if n, err := dao.DeleteRetainedDelivery(ctx, id); err != nil || n != 1 {
				t.Fatalf("resumed delivery delete: %d %v", n, err)
			}
			if event, n, err := dao.DeleteUnreferencedEvent(ctx); err != nil || n != 1 || event != f.event {
				t.Fatalf("resumed event delete: %s %d %v", event, n, err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var remaining int
			if err = f.conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE id=$1)+(SELECT count(*) FROM webhook_deliveries WHERE id=$2)+(SELECT count(*) FROM webhook_delivery_matches WHERE delivery_id=$2)+(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$2)`, f.event, id).Scan(&remaining); err != nil || remaining != 0 {
				t.Fatalf("resumed cleanup left records: %d %v", remaining, err)
			}
		})
	}
}
