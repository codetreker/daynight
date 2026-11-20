package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLifecycleWireCommitLossPreservesIntentAndOriginalReceipt(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, id, operation := queryID(1), queryID(2), queryID(3)
	now := time.Now().UTC().Truncate(time.Microsecond)
	putWorkerSnapshot(t, database, workerSnapshotFixture(user, id, now))
	var armed, lost atomic.Bool
	config := database.Pool.Config().Copy()
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	armed.Store(true)
	state := model.WorkerLifecycle{UserID: user, WorkerID: id, ProtocolVersion: 1, IntentVersion: 2, Desired: "disabled", Admission: "closed", CurrentOperationID: &operation, UpdatedAt: now}
	record := model.LifecycleOperation{UserID: user, WorkerID: id, OperationID: operation, Action: "disable", Source: "web", RequestKind: "intent", RequestHash: bytes.Repeat([]byte{1}, 32), Request: json.RawMessage(`{"action":"disable"}`), IntentVersion: 2, State: "accepted", Receipt: json.RawMessage(`{"operationId":"00000000-0000-4000-8000-000000000003","intentVersion":"2"}`), ActivationOutcome: "not_started", CreatedAt: now, UpdatedAt: now}
	completion, err := (&Store{Pool: pool}).WriteWorkerLifecycle(ctx, func(s store.WorkerLifecycleScope) error {
		if err := s.LifecycleDAO().LockWorker(ctx, user, id); err != nil {
			return err
		}
		if err := s.LifecycleDAO().SaveLifecycle(ctx, state); err != nil {
			return err
		}
		return s.LifecycleDAO().SaveOperation(ctx, record)
	})
	var failure *store.TransactionError
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || failure.Phase != "commit" {
		t.Fatalf("lost COMMIT: lost=%v completion=%+v err=%v", lost.Load(), completion, err)
	}
	if err := database.ReadWorkerLifecycle(ctx, func(s store.WorkerLifecycleSnapshot) error {
		value, err := s.LifecycleDAO().Lifecycle(ctx, user, id)
		if err != nil {
			return err
		}
		if value.Desired != "disabled" || value.Admission != "closed" || value.IntentVersion != 2 {
			t.Fatalf("unknown treated as rollback: %+v", value)
		}
		saved, err := s.LifecycleDAO().Operation(ctx, user, id, operation)
		if err != nil {
			return err
		}
		if !bytes.Equal(saved.RequestHash, record.RequestHash) || saved.IntentVersion != 2 || saved.OperationID != operation {
			t.Fatalf("original receipt changed: %+v", saved)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestLifecycleScopeCanceledBeforeTransactionDoesNotInvokeCallback(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result, err := db.WriteWorkerLifecycle(ctx, func(store.WorkerLifecycleScope) error { t.Error("canceled callback invoked"); return nil })
	if result.Outcome != store.TransactionNotCommitted || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation: %+v %v", result, err)
	}
	if err := db.ReadWorkerLifecycle(ctx, func(store.WorkerLifecycleSnapshot) error { t.Error("canceled read invoked"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("read cancellation: %v", err)
	}
}

func TestLifecycleMigrationPreservesLegacyWorkersAndRequiresTheirIdentity(t *testing.T) {
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 110 })
	if index < 0 {
		t.Fatal("lifecycle migration missing")
	}
	if err := migrate(t.Context(), pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	user, id := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	var before, after string
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(t.Context(), `SELECT to_jsonb(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("lifecycle migration rewrote legacy Worker")
	}
	for _, table := range []string{"worker_lifecycle", "worker_lifecycle_operations", "worker_lifecycle_observations"} {
		var count int
		if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM `+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("migration invented %s: %d %v", table, count, err)
		}
	}
	if err := migrate(t.Context(), pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
}
