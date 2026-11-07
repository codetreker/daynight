package webhook

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

type operationFenceGate struct {
	store.WebhookTransactions
	entered, release chan struct{}
	once             sync.Once
}

func (g *operationFenceGate) open() { g.once.Do(func() { close(g.release) }) }
func (g *operationFenceGate) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	return g.WebhookTransactions.WriteWebhook(ctx, o, id, func(sc store.WebhookWriteScope) error {
		close(g.entered)
		select {
		case <-g.release:
			return fn(sc)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

type receiptFenceGate struct {
	store.WebhookReceiptGC
	entered, release chan struct{}
	once             sync.Once
}

func (g *receiptFenceGate) open() { g.once.Do(func() { close(g.release) }) }
func (g *receiptFenceGate) WriteWebhookReceiptGC(ctx context.Context, id store.WebhookReceiptIdentity, fn func(store.WebhookReceiptGCScope) error) (store.Completion, error) {
	return g.WebhookReceiptGC.WriteWebhookReceiptGC(ctx, id, func(sc store.WebhookReceiptGCScope) error {
		close(g.entered)
		select {
		case <-g.release:
			return fn(sc)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

// ageReceipt models the passage of time without changing production clocks.
// Both the accepted request identity and the persisted receipt are aged together.
func ageReceipt(t *testing.T, f *fixture, principal model.Principal, owner wm.Owner, m *Mutation, days int) {
	t.Helper()
	m.IssuedAt = time.Now().UTC().Add(-time.Duration(days) * 24 * time.Hour).Format(time.RFC3339Nano)
	fp, err := fingerprint(principal, owner, *m)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_operations SET issued_at_lexeme=$1,semantic_fingerprint=decode($2,'hex'),recorded_at=statement_timestamp()-$3*interval '1 day',expires_at=statement_timestamp()-$3*interval '1 day'+interval '30 days' WHERE owner_kind=$4 AND owner_id=$5 AND operation_id=$6`, m.IssuedAt, fp, days, owner.Kind, owner.ID, m.OperationID)
	if err != nil {
		t.Fatal(err)
	}
}

type operationReplayResult struct {
	result Result
	err    error
}
type receiptCollectResult struct {
	count      int
	completion store.Completion
	err        error
}

func waitReceiptFenceBlocked(t *testing.T, f *fixture, owner wm.Owner, operationID string) {
	t.Helper()
	sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + owner.Kind + "\x00" + owner.ID + "\x00" + operationID))
	key := binary.BigEndian.Uint64(sum[:8])
	for i := 0; i < 200; i++ {
		var n int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 AND NOT granted`, int64(uint32(key>>32)), int64(uint32(key))).Scan(&n)
		if err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("replay did not wait for the receipt collector's operation fence")
}

func TestReceiptGCManagementReplayInterleavings(t *testing.T) {
	for _, order := range []string{"replay-first", "gc-first"} {
		t.Run(order, func(t *testing.T) {
			f := newFixture(t, false)
			p := f.principal(t)
			owner := Owner{Kind: "personal", ID: p.UserID}
			original := createMutation(p, "original", "https://receiver.example/hook")
			created, err := f.svc.Mutate(f.ctx, p, owner, original)
			if err != nil {
				t.Fatal(err)
			}
			_, ep := body(t, created)
			endpoint := ep["id"].(string)
			ageReceipt(t, f, p, owner, &original, 29)
			receipt, err := f.svc.Operation(f.ctx, p, owner, original.OperationID)
			if err != nil || receipt.(map[string]any)["operationId"] != original.OperationID {
				t.Fatalf("29-day receipt: %v %v", receipt, err)
			}
			collector := &core.ReceiptCollector{}
			n, _, err := collector.Pass(f.ctx, f.db, 500)
			if err != nil || n != 0 {
				t.Fatalf("29-day collection: %d %v", n, err)
			}
			replay, err := f.svc.Mutate(f.ctx, p, owner, original)
			if err != nil || !replay.Replay {
				t.Fatalf("29-day replay: %+v %v", replay, err)
			}
			ageReceipt(t, f, p, owner, &original, 30)

			if order == "replay-first" {
				gate := &operationFenceGate{WebhookTransactions: f.db, entered: make(chan struct{}), release: make(chan struct{})}
				defer gate.open()
				f.svc.DB = gate
				replayDone := make(chan operationReplayResult, 1)
				go func() { r, e := f.svc.Mutate(f.ctx, p, owner, original); replayDone <- operationReplayResult{r, e} }()
				select {
				case <-gate.entered:
				case <-f.ctx.Done():
					t.Fatal(f.ctx.Err())
				}
				n, _, err = collector.Pass(f.ctx, f.db, 500)
				if err != nil || n != 0 {
					t.Fatalf("collection while replay owns fence: %d %v", n, err)
				}
				receipt, err = f.svc.Operation(f.ctx, p, owner, original.OperationID)
				if err != nil || receipt.(map[string]any)["operationId"] != original.OperationID {
					t.Fatalf("read during replay: %v %v", receipt, err)
				}
				gate.open()
				finished := <-replayDone
				if finished.err != nil || !finished.result.Replay {
					t.Fatalf("winning replay: %+v %v", finished.result, finished.err)
				}
				f.svc.DB = f.db
				// A busy candidate advances the cursor; the next scan wraps before retrying.
				for i := 0; i < 3 && n == 0; i++ {
					n, _, err = collector.Pass(f.ctx, f.db, 500)
					if err != nil {
						t.Fatal(err)
					}
				}
				if n != 1 {
					t.Fatalf("expired receipt not eventually collected: %d", n)
				}
			} else {
				gate := &receiptFenceGate{WebhookReceiptGC: f.db, entered: make(chan struct{}), release: make(chan struct{})}
				defer gate.open()
				gcDone := make(chan receiptCollectResult, 1)
				go func() { n, c, e := collector.Pass(f.ctx, gate, 500); gcDone <- receiptCollectResult{n, c, e} }()
				select {
				case <-gate.entered:
				case <-f.ctx.Done():
					t.Fatal(f.ctx.Err())
				}
				receipt, err = f.svc.Operation(f.ctx, p, owner, original.OperationID)
				if err != nil || receipt.(map[string]any)["operationId"] != original.OperationID {
					t.Fatalf("read while GC holds fence: %v %v", receipt, err)
				}
				replayDone := make(chan operationReplayResult, 1)
				go func() { r, e := f.svc.Mutate(f.ctx, p, owner, original); replayDone <- operationReplayResult{r, e} }()
				waitReceiptFenceBlocked(t, f, owner, original.OperationID)
				gate.open()
				collected := <-gcDone
				if collected.err != nil || collected.count != 1 || collected.completion.Outcome != store.TransactionCommitted {
					t.Fatalf("winning GC: %+v", collected)
				}
				finished := <-replayDone
				expectFault(t, finished.err, "operation_expired")
			}
			_, err = f.svc.Operation(f.ctx, p, owner, original.OperationID)
			expectFault(t, err, "not_found")
			_, err = f.svc.Mutate(f.ctx, p, owner, original)
			expectFault(t, err, "operation_expired")
			var endpoints, receipts int
			err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_kind=$1 AND owner_id=$2),(SELECT count(*) FROM webhook_operations WHERE owner_kind=$1 AND owner_id=$2)`, owner.Kind, owner.ID).Scan(&endpoints, &receipts)
			if err != nil || endpoints != 1 || receipts != 0 {
				t.Fatalf("endpoint=%s count=%d receipts=%d err=%v", endpoint, endpoints, receipts, err)
			}
		})
	}
}
