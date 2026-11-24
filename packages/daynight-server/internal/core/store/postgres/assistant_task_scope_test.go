package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	assistantcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	assistantservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
	"github.com/google/uuid"
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

func TestAssistantTaskCredentialAuthorizationPreservesSessionAndRejectsUnsupportedCredential(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := t.Context()
	user, session, _ := testutil.AuthRecords(t, database)
	_, err := database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		authorization, err := scope.AssistantTaskDAO().(assistantcore.AuthorizationReader).CredentialAuthorization(ctx, session)
		if err != nil {
			return err
		}
		if authorization.Principal != session || authorization.Profile != model.SessionProfile || authorization.Policy != nil {
			t.Fatalf("session profile changed: %+v", authorization)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	missing := session
	missing.CredentialID = queryID(41)
	_, err = database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		_, err := scope.AssistantTaskDAO().(assistantcore.AuthorizationReader).CredentialAuthorization(ctx, missing)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing credential was not refused: %v", err)
	}
	grant, _, _ := testutil.OAuthFamily(t, database, user.ID, time.Now().UTC())
	oauth := model.Principal{Kind: model.OAuthCredential, UserID: user.ID}
	if err := database.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE grant_id=$1`, grant.ID).Scan(&oauth.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		_, err := scope.AssistantTaskDAO().(assistantcore.AuthorizationReader).CredentialAuthorization(ctx, oauth)
		return err
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("Assistant Task accepted unsupported OAuth credential: %v", err)
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

type inboundFixture struct {
	database *Store
	inbox    *assistantservice.Inbox
	task     model.AssistantTask
	inboxID  string
	token    string
}

// newInboundFixture stores a task actively held by a live Bot and its enabled
// inbox, so a receive reaches every step of the use case.
func newInboundFixture(t *testing.T) inboundFixture {
	t.Helper()
	database := isolatedStore(t)
	ctx := t.Context()
	owner, worker, bot := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,clock_timestamp(),clock_timestamp())`, []any{owner, "github:" + owner}},
		{`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,clock_timestamp(),clock_timestamp(),'{}','{"state":"unavailable","items":[]}')`, []any{owner, worker}},
		{`INSERT INTO bots(id,owner_user_id,worker_id,name,request_fingerprint,requested_overrides,resolved_configuration,startup_result) VALUES($1,$2,$3,'Bot',repeat('a',64),'{}','{}','{"state":"pending"}')`, []any{bot, owner, worker}},
	} {
		if _, err := database.Pool.Exec(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	lease, hash := now.Add(time.Hour), "claim"
	task := model.AssistantTask{ID: uuid.NewString(), OwnerUserID: owner, Name: "Inbox", Kind: "continuous", State: "active", Takeover: "manual", RequestFingerprint: "create", Version: 1, ManualVersion: 1, ClaimGeneration: 1, HolderBotID: &bot, ClaimTokenHash: &hash, ClaimedAt: &now, RenewedAt: &now, LeaseUntil: &lease, CreatedAt: now, UpdatedAt: now}
	token, digest, err := assistantcore.NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	inbox := model.AssistantTaskInbox{InboxID: uuid.NewString(), OwnerUserID: owner, TaskID: task.ID, State: model.AssistantTaskInboxEnabled, TokenDigest: &digest, Version: 1, CreatedAt: now}
	completion, err := database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		d := scope.AssistantTaskDAO()
		if ok, err := d.InsertTask(ctx, task); err != nil || !ok {
			return errors.Join(err, errors.New("task was not inserted"))
		}
		if ok, err := d.InsertInbox(ctx, inbox); err != nil || !ok {
			return errors.Join(err, errors.New("inbox was not inserted"))
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatal(completion, err)
	}
	return inboundFixture{database: database, inbox: assistantservice.NewInbox(database, "https://daynight.example"), task: task, inboxID: inbox.InboxID, token: token}
}

func (f inboundFixture) input(token, key, body string) assistantservice.ReceiveInput {
	return assistantservice.ReceiveInput{InboxID: f.inboxID, Token: &token, MediaType: "application/json", IdempotencyKey: key, Body: []byte(body)}
}

func (f inboundFixture) inboundEvents(t *testing.T) int {
	t.Helper()
	var count int
	if err := f.database.Pool.QueryRow(t.Context(), `SELECT count(*) FROM assistant_task_events WHERE owner_user_id=$1 AND task_id=$2 AND type='inbound'`, f.task.OwnerUserID, f.task.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestAssistantTaskInboundConcurrentSameKeyWritesOneEvent(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newInboundFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	const senders = 8
	results := make([]assistantservice.ReceiveResult, senders)
	errs := make([]error, senders)
	start := make(chan struct{})
	var wait sync.WaitGroup
	for i := range senders {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			results[i], errs[i] = f.inbox.Receive(ctx, f.input(f.token, "same-key", `{"n":1}`))
		}()
	}
	close(start)
	wait.Wait()
	duplicates := 0
	for i := range senders {
		if errs[i] != nil || results[i].EventID == nil || *results[i].EventID != *results[0].EventID {
			t.Fatalf("sender %d: %+v %v", i, results[i], errs[i])
		}
		if results[i].Duplicate {
			duplicates++
		}
	}
	if duplicates != senders-1 || f.inboundEvents(t) != 1 {
		t.Fatalf("duplicates=%d events=%d", duplicates, f.inboundEvents(t))
	}
	_, err := f.inbox.Receive(ctx, f.input(f.token, "same-key", `{"n":2}`))
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "operation_conflict" || f.inboundEvents(t) != 1 {
		t.Fatalf("different body under the same key: %v", err)
	}
	var receipts int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_inbox_receipts WHERE inbox_id=$1 AND idempotency_key='same-key' AND expires_at>received_at+interval '71 hours'`, f.inboxID).Scan(&receipts); err != nil || receipts != 1 {
		t.Fatalf("receipts=%d err=%v", receipts, err)
	}
}

// A receive that waits for a concurrent immediate rotation must observe the
// rotated digest after the task lock is released, never the stale token.
func TestAssistantTaskInboundWaitsForConcurrentRotation(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newInboundFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	next, digest, err := assistantcore.NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	// Every exit releases the rotation's transaction and joins both
	// goroutines, so a failed assertion cannot leave a transaction open
	// during cleanup.
	locked, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	releaseRotation := func() { releaseOnce.Do(func() { close(release) }) }
	var workers sync.WaitGroup
	defer workers.Wait()
	defer releaseRotation()
	rotated := make(chan error, 1)
	workers.Add(1)
	go func() {
		defer workers.Done()
		_, err := f.database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
			d := scope.AssistantTaskDAO()
			if _, err := d.Task(ctx, f.task.OwnerUserID, f.task.ID, true); err != nil {
				return err
			}
			inbox, err := d.LockInbox(ctx, f.task.OwnerUserID, f.task.ID, f.inboxID)
			if err != nil {
				return err
			}
			previous := inbox.Version
			inbox.TokenDigest, inbox.Version = &digest, previous+1
			if ok, err := d.SaveInbox(ctx, inbox, previous); err != nil || !ok {
				return errors.Join(err, errors.New("rotation was not saved"))
			}
			close(locked)
			select {
			case <-release:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		rotated <- err
	}()
	select {
	case <-locked:
	case err := <-rotated:
		t.Fatalf("rotation failed before holding the task lock: %v", err)
	case <-ctx.Done():
		t.Fatalf("rotation did not take the task lock: %v", ctx.Err())
	}
	received := make(chan error, 1)
	workers.Add(1)
	go func() {
		defer workers.Done()
		_, err := f.inbox.Receive(ctx, f.input(f.token, "", `{"n":1}`))
		received <- err
	}()
	select {
	case err := <-received:
		t.Fatalf("receive did not wait for the rotation's task lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	releaseRotation()
	if err := <-rotated; err != nil {
		t.Fatal(err)
	}
	var fault *model.Fault
	if err := <-received; !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatalf("stale token after rotation: %v", err)
	}
	if result, err := f.inbox.Receive(ctx, f.input(next, "", `{"n":2}`)); err != nil || result.EventID == nil || f.inboundEvents(t) != 1 {
		t.Fatalf("rotated token: %+v %v", result, err)
	}
}

func TestAssistantTaskInboundRejectsBacklogAndReclaims(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newInboundFixture(t)
	ctx := t.Context()
	if _, err := f.database.Pool.Exec(ctx, `INSERT INTO assistant_task_events(id,owner_user_id,task_id,target_bot_id,type,state,payload,attention,request_fingerprint,created_at)
		SELECT gen_random_uuid(),$1,$2,$3,'inbound','pending','{}',false,'seed',clock_timestamp() FROM generate_series(1,$4)`, f.task.OwnerUserID, f.task.ID, *f.task.HolderBotID, assistantcore.InboundBacklogLimit); err != nil {
		t.Fatal(err)
	}
	_, err := f.inbox.Receive(ctx, f.input(f.token, "", `{}`))
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "rate_limited" || f.inboundEvents(t) != assistantcore.InboundBacklogLimit {
		t.Fatalf("backlog: %v", err)
	}
	if _, err := f.database.Pool.Exec(ctx, `UPDATE assistant_task_events SET state='delivered',delivered_at=clock_timestamp()-interval '31 days',settled_at=clock_timestamp()-interval '31 days' WHERE task_id=$1`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.inbox.Receive(ctx, f.input(f.token, "", `{}`)); err != nil {
		t.Fatal(err)
	}
	if got := f.inboundEvents(t); got != assistantcore.InboundBacklogLimit+1-assistantcore.InboundReclaimLimit {
		t.Fatalf("one call reclaimed beyond its bound: %d events remain", got)
	}
}

// The inbound scope exposes the webhook source and project access readers on
// the receive transaction, so a missing event or project surfaces each
// reader's documented absence error instead of a generic query failure.
func TestAssistantTaskInboundScopeExposesSourceReaders(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	completion, err := database.WriteAssistantTaskInbound(ctx, func(scope store.AssistantTaskInboundScope) error {
		if _, err := scope.WebhookInboundSources().CapturedEventProvenance(ctx, uuid.NewString()); !errors.Is(err, store.ErrWebhookCapturedEventMissing) {
			return errors.Join(errors.New("missing captured event"), err)
		}
		if _, err := scope.ProjectAccessReader().ProjectAccess(ctx, model.Principal{UserID: uuid.NewString()}, uuid.NewString()); !errors.Is(err, model.ErrNotFound) {
			return errors.Join(errors.New("missing project"), err)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatal(completion, err)
	}
}
