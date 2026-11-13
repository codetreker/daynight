package postgres

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAssistantTaskMigrationOwnsTablesAndIndexes(t *testing.T) {
	database := isolatedStore(t)
	for _, table := range []string{"assistant_tasks", "assistant_task_manual_versions", "assistant_task_appendix", "assistant_task_proposals", "assistant_task_items", "assistant_task_records", "assistant_task_events", "assistant_task_inquiries", "assistant_task_claim_operations"} {
		var name *string
		if err := database.Pool.QueryRow(t.Context(), `SELECT to_regclass($1)::text`, table).Scan(&name); err != nil || name == nil {
			t.Fatalf("missing assistant task table %s: %v", table, err)
		}
		var constraints int
		if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('f','c')`, table).Scan(&constraints); err != nil || constraints != 0 {
			t.Fatalf("unexpected business constraints on %s: %d %v", table, constraints, err)
		}
	}
	for _, index := range []string{"assistant_tasks_owner_application", "assistant_task_records_page", "assistant_task_events_target_state", "assistant_task_inquiries_state_deadline", "assistant_task_items_open_key"} {
		var present bool
		if err := database.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass($1) AND indisvalid AND indisready)`, index).Scan(&present); err != nil || !present {
			t.Fatalf("missing usable index %s: %v", index, err)
		}
	}
}

func TestAssistantTaskWireCommitLossRecoversOriginalReceiptReadOnly(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
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
	now := time.Now().UTC().Truncate(time.Microsecond)
	task := model.AssistantTask{ID: queryID(1), OwnerUserID: queryID(2), Name: "Durable", Version: 1, ManualVersion: 1, ClaimGeneration: 1, State: "active", CreatedAt: now, UpdatedAt: now}
	receipt := model.AssistantTaskClaimOperation{OwnerUserID: task.OwnerUserID, TaskID: task.ID, OperationID: queryID(3), Kind: "claim", RequestFingerprint: "original", AdmittedAt: now, ResultingVersion: 1, ResultingGeneration: 1}
	armed.Store(true)
	completion, err := (&Store{Pool: pool}).WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		d := scope.AssistantTaskDAO()
		ok, err := d.InsertTask(ctx, task)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("task was not inserted")
		}
		return d.InsertClaimOperation(ctx, receipt)
	})
	var failure *store.TransactionError
	if !lost.Load() || completion.Outcome != store.TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || failure.Phase != "commit" {
		t.Fatalf("lost COMMIT confirmation: lost=%v completion=%#v error=%v", lost.Load(), completion, err)
	}
	// Recovery reads the original operation through a fresh scope. It neither
	// resubmits the claim nor creates a replacement operation identity.
	completion, err = database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		d := scope.AssistantTaskDAO()
		got, err := d.ClaimOperation(ctx, task.OwnerUserID, task.ID, receipt.OperationID)
		if err != nil {
			return err
		}
		if got.RequestFingerprint != "original" || got.ResultingGeneration != 1 || !got.AdmittedAt.Equal(now) {
			return errors.New("original receipt changed")
		}
		persisted, err := d.Task(ctx, task.OwnerUserID, task.ID, false)
		if err != nil {
			return err
		}
		if persisted.Version != 1 || persisted.ClaimGeneration != 1 {
			return errors.New("task and receipt are not atomic")
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("read original receipt: %#v %v", completion, err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_claim_operations WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("recovery wrote another receipt: %d %v", count, err)
	}
}

func TestAssistantTaskScopeReportsBeginFailureWithoutCallingOperation(t *testing.T) {
	database := isolatedStore(t)
	database.Pool.Close()
	called := false
	completion, err := database.WriteAssistantTask(t.Context(), func(store.AssistantTaskScope) error { called = true; return nil })
	if err == nil || called || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("begin failure: called=%v completion=%#v error=%v", called, completion, err)
	}
}
