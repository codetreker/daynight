package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
	"github.com/google/uuid"
)

type inboundFixture struct {
	database *Store
	inbox    *service.Inbox
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
	token, digest, err := core.NewInboxToken()
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
	return inboundFixture{database: database, inbox: service.NewInbox(database, "https://daynight.example"), task: task, inboxID: inbox.InboxID, token: token}
}

func (f inboundFixture) input(token, key, body string) service.ReceiveInput {
	return service.ReceiveInput{InboxID: f.inboxID, Token: &token, MediaType: "application/json", IdempotencyKey: key, Body: []byte(body)}
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
	results := make([]service.ReceiveResult, senders)
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
	next, digest, err := core.NewInboxToken()
	if err != nil {
		t.Fatal(err)
	}
	locked, release := make(chan struct{}), make(chan struct{})
	rotated := make(chan error, 1)
	go func() {
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
			<-release
			return nil
		})
		rotated <- err
	}()
	<-locked
	received := make(chan error, 1)
	go func() {
		_, err := f.inbox.Receive(ctx, f.input(f.token, "", `{"n":1}`))
		received <- err
	}()
	select {
	case err := <-received:
		t.Fatalf("receive did not wait for the rotation's task lock: %v", err)
	case <-time.After(200 * time.Millisecond):
	}
	close(release)
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
		SELECT gen_random_uuid(),$1,$2,$3,'inbound','pending','{}',false,'seed',clock_timestamp() FROM generate_series(1,$4)`, f.task.OwnerUserID, f.task.ID, *f.task.HolderBotID, core.InboundBacklogLimit); err != nil {
		t.Fatal(err)
	}
	_, err := f.inbox.Receive(ctx, f.input(f.token, "", `{}`))
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "rate_limited" || f.inboundEvents(t) != core.InboundBacklogLimit {
		t.Fatalf("backlog: %v", err)
	}
	if _, err := f.database.Pool.Exec(ctx, `UPDATE assistant_task_events SET state='delivered',delivered_at=clock_timestamp()-interval '31 days',settled_at=clock_timestamp()-interval '31 days' WHERE task_id=$1`, f.task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.inbox.Receive(ctx, f.input(f.token, "", `{}`)); err != nil {
		t.Fatal(err)
	}
	if got := f.inboundEvents(t); got != core.InboundBacklogLimit+1-core.InboundReclaimLimit {
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
		sources := scope.WebhookInboundSources()
		if _, err := sources.CapturedEventProvenance(ctx, uuid.NewString()); !errors.Is(err, store.ErrWebhookCapturedEventMissing) {
			return errors.Join(errors.New("missing captured event"), err)
		}
		destinations, err := sources.PersonalDeliveryDestinations(ctx, uuid.NewString(), uuid.NewString(), "https://daynight.example", "", 1)
		if err != nil || len(destinations) != 0 {
			return errors.Join(errors.New("unknown event had delivery destinations"), err)
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
