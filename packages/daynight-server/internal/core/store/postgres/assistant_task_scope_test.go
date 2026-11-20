package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"

	assistantcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	assistantservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAssistantTaskScopedCredentialAdmissionUsesTransactionPolicy(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	bot := testutil.RuntimeStoredBot(t, database)
	principal := testutil.RuntimeBotPAT(t, database, bot)
	scopes := []scopepolicy.ScopeID{"assistant-task:operate", "assistant-task:read", "assistant-task:write"}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=$2,scope_version=1 WHERE id=$1`, principal.CredentialID, scopes); err != nil {
		t.Fatal(err)
	}
	actor := assistantcore.Actor{Principal: principal, Authorization: &model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}}
	tasks := assistantservice.New(database)
	input := assistantcore.CreateInput{ID: queryID(1), Name: "Scoped task", Kind: "continuous", Takeover: "manual", Body: "Manual", Rules: json.RawMessage(`[]`), Trigger: json.RawMessage(`null`)}
	created, err := tasks.Create(ctx, actor, input)
	if err != nil || created.Task.ID != input.ID {
		t.Fatalf("scoped creation: %+v %v", created, err)
	}
	watchdog, err := tasks.EnableWatchdog(ctx, actor, queryID(2), bot.ID)
	if err != nil || watchdog.Task.Application != "watchdog" || watchdog.Task.HolderBotID == nil || *watchdog.Task.HolderBotID != bot.ID {
		t.Fatalf("scoped watchdog: %+v %v", watchdog, err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE personal_access_tokens SET business_scopes=ARRAY['assistant-task:read'],scope_version=2 WHERE id=$1`, principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	input.ID = queryID(3)
	_, err = tasks.Create(ctx, actor, input)
	if !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("stale observed policy authorized creation: %v", err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_tasks WHERE id=$1`, input.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("refused creation persisted: %d %v", count, err)
	}
	read, err := tasks.Get(ctx, actor, created.Task.ID)
	if err != nil || read.Task.ID != created.Task.ID {
		t.Fatalf("retained read policy: %+v %v", read, err)
	}
}

func TestAssistantTaskMigrationOwnsTablesAndIndexes(t *testing.T) {
	database := isolatedStore(t)
	for _, table := range []string{"assistant_tasks", "assistant_task_manual_versions", "assistant_task_appendix", "assistant_task_proposals", "assistant_task_items", "assistant_task_records", "assistant_task_events", "assistant_task_inquiries", "assistant_task_claim_operations", "assistant_task_inboxes", "assistant_task_inbox_receipts"} {
		var name *string
		if err := database.Pool.QueryRow(t.Context(), `SELECT to_regclass($1)::text`, table).Scan(&name); err != nil || name == nil {
			t.Fatalf("missing assistant task table %s: %v", table, err)
		}
		var constraints int
		if err := database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('f','c')`, table).Scan(&constraints); err != nil || constraints != 0 {
			t.Fatalf("unexpected business constraints on %s: %d %v", table, constraints, err)
		}
	}
	for _, index := range []string{"assistant_tasks_owner_application", "assistant_task_records_page", "assistant_task_events_target_state", "assistant_task_inquiries_state_deadline", "assistant_task_items_open_key", "assistant_task_inboxes_live", "assistant_task_inbox_receipts_wake", "assistant_task_inbox_receipts_expiry", "assistant_task_events_inbound_settled"} {
		var present bool
		if err := database.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass($1) AND indisvalid AND indisready)`, index).Scan(&present); err != nil || !present {
			t.Fatalf("missing usable index %s: %v", index, err)
		}
	}
}

func TestAssistantTaskWireCommitLossRecoversOriginalReceiptReadOnly(t *testing.T) {
	parallelRootDatabaseTest(t)
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
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	database.Pool.Close()
	called := false
	completion, err := database.WriteAssistantTask(t.Context(), func(store.AssistantTaskScope) error { called = true; return nil })
	if err == nil || called || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("begin failure: called=%v completion=%#v error=%v", called, completion, err)
	}
}
