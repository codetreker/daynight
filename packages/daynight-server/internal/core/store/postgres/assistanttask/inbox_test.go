package assistanttask_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func (f fixture) inbox(t *testing.T) model.AssistantTaskInbox {
	t.Helper()
	current, overlap := "current digest", "overlap digest"
	until := f.task.CreatedAt.Add(24 * time.Hour)
	inbox := model.AssistantTaskInbox{InboxID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, State: model.AssistantTaskInboxEnabled, TokenDigest: &current, OverlapTokenDigest: &overlap, OverlapUntil: &until, Version: 1, CreatedAt: f.task.CreatedAt}
	f.write(t, func(d store.AssistantTaskDAO) error {
		ok, err := d.InsertInbox(t.Context(), inbox)
		if err == nil && !ok {
			t.Fatal("inbox insert skipped")
		}
		return err
	})
	return inbox
}

func (f fixture) receipt(inbox, key string, received, expires time.Time) model.AssistantTaskInboxReceipt {
	event := uuid.NewString()
	return model.AssistantTaskInboxReceipt{InboxID: inbox, IdempotencyKey: key, OwnerUserID: f.owner, TaskID: f.task.ID, BodySHA256: "body", EventID: &event, TargetBotID: uuid.NewString(), ReceivedAt: received, ExpiresAt: expires}
}

// peer is another owner's task in the same database.
func (f fixture) peer() fixture {
	owner := uuid.NewString()
	task := f.task
	task.ID, task.OwnerUserID = uuid.NewString(), owner
	return fixture{db: f.db, owner: owner, task: task}
}

func notFound(t *testing.T, err error, what string) {
	t.Helper()
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("%s: want not found, got %v", what, err)
	}
}

func TestInboxLifecycleCASAndOwnerScope(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	inbox := f.inbox(t)
	foreign := uuid.NewString()
	f.write(t, func(d store.AssistantTaskDAO) error {
		second := inbox
		second.InboxID = uuid.NewString()
		if ok, err := d.InsertInbox(ctx, second); err != nil || ok {
			t.Fatalf("second live inbox for the task: %v %v", ok, err)
		}
		reused := inbox
		reused.TaskID = uuid.NewString()
		if ok, err := d.InsertInbox(ctx, reused); err != nil || ok {
			t.Fatalf("inbox ID reused: %v %v", ok, err)
		}
		current, err := d.CurrentInbox(ctx, f.owner, f.task.ID)
		if err != nil || !reflect.DeepEqual(current, inbox) {
			t.Fatalf("current inbox roundtrip: %#v %v", current, err)
		}
		identity, err := d.InboxIdentity(ctx, inbox.InboxID)
		want := model.AssistantTaskInbox{InboxID: inbox.InboxID, OwnerUserID: f.owner, TaskID: f.task.ID, State: model.AssistantTaskInboxEnabled}
		if err != nil || !reflect.DeepEqual(identity, want) {
			t.Fatalf("identity disclosed more than identity: %#v %v", identity, err)
		}
		_, err = d.InboxIdentity(ctx, uuid.NewString())
		notFound(t, err, "never existing inbox")
		locked, err := d.LockInbox(ctx, f.owner, f.task.ID, inbox.InboxID)
		if err != nil || !reflect.DeepEqual(locked, inbox) {
			t.Fatalf("locked inbox roundtrip: %#v %v", locked, err)
		}
		_, err = d.CurrentInbox(ctx, foreign, f.task.ID)
		notFound(t, err, "foreign current inbox")
		_, err = d.LockInbox(ctx, foreign, f.task.ID, inbox.InboxID)
		notFound(t, err, "foreign inbox lock")
		if ok, err := d.AddInboxSuppressed(ctx, foreign, f.task.ID, inbox.InboxID); err != nil || ok {
			t.Fatalf("foreign suppression count: %v %v", ok, err)
		}

		rotated := inbox
		digest, at := "rotated digest", f.task.CreatedAt.Add(time.Hour)
		rotated.TokenDigest, rotated.OverlapTokenDigest, rotated.OverlapUntil, rotated.RotatedAt, rotated.Version = &digest, nil, nil, &at, 2
		if ok, err := d.SaveInbox(ctx, rotated, 2); err != nil || ok {
			t.Fatalf("stale inbox version saved: %v %v", ok, err)
		}
		foreignRotation := rotated
		foreignRotation.OwnerUserID = foreign
		if ok, err := d.SaveInbox(ctx, foreignRotation, 1); err != nil || ok {
			t.Fatalf("foreign inbox saved: %v %v", ok, err)
		}
		if ok, err := d.SaveInbox(ctx, rotated, 1); err != nil || !ok {
			t.Fatalf("rotation refused: %v %v", ok, err)
		}
		if ok, err := d.AddInboxSuppressed(ctx, f.owner, f.task.ID, inbox.InboxID); err != nil || !ok {
			t.Fatalf("suppression count refused: %v %v", ok, err)
		}
		current, err = d.CurrentInbox(ctx, f.owner, f.task.ID)
		rotated.SuppressedCount = 1
		if err != nil || !reflect.DeepEqual(current, rotated) {
			t.Fatalf("rotation or count not persisted: %#v %v", current, err)
		}

		disabled := rotated
		disabled.State, disabled.TokenDigest, disabled.Version = model.AssistantTaskInboxTombstone, nil, 3
		if ok, err := d.SaveInbox(ctx, disabled, 2); err != nil || !ok {
			t.Fatalf("disable refused: %v %v", ok, err)
		}
		_, err = d.CurrentInbox(ctx, f.owner, f.task.ID)
		notFound(t, err, "disabled current inbox")
		if ok, err := d.AddInboxSuppressed(ctx, f.owner, f.task.ID, inbox.InboxID); err != nil || ok {
			t.Fatalf("tombstone counted suppression: %v %v", ok, err)
		}
		identity, err = d.InboxIdentity(ctx, inbox.InboxID)
		if err != nil || identity.State != model.AssistantTaskInboxTombstone {
			t.Fatalf("tombstone is not distinguishable: %#v %v", identity, err)
		}
		if ok, err := d.InsertInbox(ctx, disabled); err != nil || ok {
			t.Fatalf("tombstone ID revived: %v %v", ok, err)
		}
		next := inbox
		next.InboxID = uuid.NewString()
		if ok, err := d.InsertInbox(ctx, next); err != nil || !ok {
			t.Fatalf("new inbox after disable refused: %v %v", ok, err)
		}
		return nil
	})
}

func TestTaskDeletionTombstonesInboxAndDeletesReceipts(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	inbox := f.inbox(t)
	other := f.peer()
	other.create(t)
	otherInbox := other.inbox(t)
	var now time.Time
	f.write(t, func(d store.AssistantTaskDAO) (err error) {
		now, err = d.Now(ctx)
		return err
	})
	receipt := f.receipt(inbox.InboxID, "key", now, now.Add(time.Hour))
	otherReceipt := other.receipt(otherInbox.InboxID, "key", now, now.Add(time.Hour))
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range []model.AssistantTaskInboxReceipt{receipt, otherReceipt} {
			if ok, err := d.InsertInboxReceipt(ctx, v); err != nil || !ok {
				t.Fatalf("receipt insert: %v %v", ok, err)
			}
		}
		return d.DeleteTaskContent(ctx, f.owner, f.task.ID)
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		_, err := d.CurrentInbox(ctx, f.owner, f.task.ID)
		notFound(t, err, "deleted task inbox")
		locked, err := d.LockInbox(ctx, f.owner, f.task.ID, inbox.InboxID)
		if err != nil || locked.State != model.AssistantTaskInboxTombstone || locked.TokenDigest != nil || locked.OverlapTokenDigest != nil || locked.OverlapUntil != nil || locked.Version != inbox.Version+1 {
			t.Fatalf("task deletion kept a live inbox or digests: %#v %v", locked, err)
		}
		_, err = d.InboxReceipt(ctx, f.owner, inbox.InboxID, "key")
		notFound(t, err, "deleted task receipt")
		if got, err := d.InboxReceipt(ctx, other.owner, otherInbox.InboxID, "key"); err != nil || got.TaskID != other.task.ID {
			t.Fatalf("another task's receipt was deleted: %v", err)
		}
		if live, err := d.CurrentInbox(ctx, other.owner, other.task.ID); err != nil || live.State != model.AssistantTaskInboxEnabled {
			t.Fatalf("another task's inbox changed: %#v %v", live, err)
		}
		return nil
	})
}

func TestReceiptExpiryReplacementAndOwnerScope(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	inbox := f.inbox(t)
	var now time.Time
	f.write(t, func(d store.AssistantTaskDAO) (err error) {
		now, err = d.Now(ctx)
		return err
	})
	expiry := now.Add(300 * time.Millisecond)
	first := f.receipt(inbox.InboxID, "key", now, expiry)
	subject := uuid.NewString()
	first.SubjectTaskID = &subject
	f.write(t, func(d store.AssistantTaskDAO) error {
		if ok, err := d.InsertInboxReceipt(ctx, first); err != nil || !ok {
			t.Fatalf("receipt insert: %v %v", ok, err)
		}
		got, err := d.InboxReceipt(ctx, f.owner, inbox.InboxID, "key")
		if err != nil || !reflect.DeepEqual(got, first) {
			t.Fatalf("receipt roundtrip: %#v %v", got, err)
		}
		_, err = d.InboxReceipt(ctx, uuid.NewString(), inbox.InboxID, "key")
		notFound(t, err, "foreign receipt")
		duplicate := f.receipt(inbox.InboxID, "key", now, now.Add(time.Hour))
		if ok, err := d.InsertInboxReceipt(ctx, duplicate); err != nil || ok {
			t.Fatalf("unexpired key replaced: %v %v", ok, err)
		}
		return nil
	})
	awaitDatabaseTime(t, f, expiry)
	f.write(t, func(d store.AssistantTaskDAO) error {
		_, err := d.InboxReceipt(ctx, f.owner, inbox.InboxID, "key")
		notFound(t, err, "receipt at its expiry")
		// The stored receipt has expired, so only the owner predicate can refuse
		// another owner's replacement.
		foreign := f.receipt(inbox.InboxID, "key", expiry, expiry.Add(time.Hour))
		foreign.OwnerUserID = uuid.NewString()
		if ok, err := d.InsertInboxReceipt(ctx, foreign); err != nil || ok {
			t.Fatalf("foreign owner replaced expired receipt: %v %v", ok, err)
		}
		var owner, body string
		var stored time.Time
		if err := f.db.Pool.QueryRow(ctx, `SELECT owner_user_id::text,body_sha256,expires_at FROM assistant_task_inbox_receipts WHERE inbox_id=$1 AND idempotency_key='key'`, inbox.InboxID).Scan(&owner, &body, &stored); err != nil || owner != f.owner || body != first.BodySHA256 || !stored.Equal(expiry) {
			t.Fatalf("expired receipt changed by foreign owner: %s %s %v %v", owner, body, stored, err)
		}
		replacement := f.receipt(inbox.InboxID, "key", expiry, expiry.Add(time.Hour))
		replacement.EventID, replacement.Suppressed = nil, true
		if ok, err := d.InsertInboxReceipt(ctx, replacement); err != nil || !ok {
			t.Fatalf("expired key not replaced: %v %v", ok, err)
		}
		got, err := d.InboxReceipt(ctx, f.owner, inbox.InboxID, "key")
		if err != nil || !reflect.DeepEqual(got, replacement) {
			t.Fatalf("replacement roundtrip: %#v %v", got, err)
		}
		return nil
	})
}

func TestConcurrentReceiptKeyAdmitsOneWriter(t *testing.T) {
	f := setup(t)
	f.create(t)
	inbox := f.inbox(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	first, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, first)
	winner := f.receipt(inbox.InboxID, "key", now, now.Add(time.Hour))
	if ok, err := assistanttask.New(first).InsertInboxReceipt(ctx, winner); err != nil || !ok {
		t.Fatalf("first receipt: %v %v", ok, err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			ok, err := s.AssistantTaskDAO().InsertInboxReceipt(ctx, f.receipt(inbox.InboxID, "key", now, now.Add(time.Hour)))
			if err == nil && ok {
				return errors.New("two receipts admitted for one key")
			}
			return err
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "INSERT INTO assistant_task_inbox_receipts")
	if err := first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.InboxReceipt(ctx, f.owner, inbox.InboxID, "key")
		if err == nil && !reflect.DeepEqual(got, winner) {
			t.Fatalf("receipt winner lost: %#v", got)
		}
		return err
	})
}

func (f fixture) timedEvent(bot, kind, state string, created time.Time, delivered *time.Time) model.AssistantTaskEvent {
	return model.AssistantTaskEvent{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: bot, Type: kind, State: state, RequestFingerprint: "event", Payload: json.RawMessage(`{}`), CreatedAt: created, DeliveredAt: delivered}
}

func TestPendingInboundEventsCountsTargetUpToLimit(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	bot, other := uuid.NewString(), uuid.NewString()
	stamp := f.task.CreatedAt
	events := []model.AssistantTaskEvent{
		f.timedEvent(bot, "inbound", "pending", stamp, nil),
		f.timedEvent(bot, "inbound", "pending", stamp, nil),
		f.timedEvent(bot, "inbound", "pending", stamp, nil),
		f.timedEvent(bot, "inbound", "delivered", stamp, &stamp),
		f.timedEvent(bot, "update", "pending", stamp, nil),
		f.timedEvent(other, "inbound", "pending", stamp, nil),
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range events {
			if _, err := d.InsertEvent(ctx, v); err != nil {
				return err
			}
		}
		for _, c := range []struct {
			owner, bot  string
			limit, want int
		}{{f.owner, bot, 10, 3}, {f.owner, bot, 2, 2}, {f.owner, other, 10, 1}, {uuid.NewString(), bot, 10, 0}} {
			got, err := d.PendingInboundEvents(ctx, c.owner, f.task.ID, c.bot, c.limit)
			if err != nil || got != c.want {
				t.Fatalf("pending inbound %+v: got %d %v", c, got, err)
			}
		}
		return nil
	})
}

func TestReceivedInboundFindsUnsuppressedReceiptSince(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	inbox := f.inbox(t)
	bot, subject := uuid.NewString(), uuid.NewString()
	since := f.task.CreatedAt
	at := func(key string, received time.Time, suppressed bool, subject string) model.AssistantTaskInboxReceipt {
		v := f.receipt(inbox.InboxID, key, received, received.Add(time.Hour))
		v.TargetBotID, v.SubjectTaskID, v.Suppressed = bot, &subject, suppressed
		return v
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range []model.AssistantTaskInboxReceipt{
			at("old", since.Add(-time.Microsecond), false, subject),
			at("suppressed", since, true, subject),
			at("other", since, false, uuid.NewString()),
		} {
			if _, err := d.InsertInboxReceipt(ctx, v); err != nil {
				return err
			}
		}
		if found, err := d.ReceivedInbound(ctx, f.owner, bot, subject, since); err != nil || found {
			t.Fatalf("old, suppressed or unrelated receipt woke: %v %v", found, err)
		}
		if _, err := d.InsertInboxReceipt(ctx, at("boundary", since, false, subject)); err != nil {
			return err
		}
		if found, err := d.ReceivedInbound(ctx, f.owner, bot, subject, since); err != nil || !found {
			t.Fatalf("receipt at since not found: %v %v", found, err)
		}
		for _, c := range []struct{ owner, bot string }{{uuid.NewString(), bot}, {f.owner, uuid.NewString()}} {
			if found, err := d.ReceivedInbound(ctx, c.owner, c.bot, subject, since); err != nil || found {
				t.Fatalf("receipt found for %+v: %v %v", c, found, err)
			}
		}
		return nil
	})
}

func TestReclamationIsBoundedAndScoped(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	inbox := f.inbox(t)
	other := f.peer()
	other.create(t)
	otherInbox := other.inbox(t)
	var now time.Time
	f.write(t, func(d store.AssistantTaskDAO) (err error) {
		now, err = d.Now(ctx)
		return err
	})
	past, cutoff := now.Add(-time.Hour), now.Add(-time.Minute)
	recent := now
	bot := uuid.NewString()
	settled := []model.AssistantTaskEvent{
		f.timedEvent(bot, "inbound", "delivered", past, &past),
		f.timedEvent(bot, "inbound", "delivered", past, &past),
		f.timedEvent(bot, "inbound", "expired", past, nil),
	}
	kept := []model.AssistantTaskEvent{
		f.timedEvent(bot, "inbound", "pending", past, nil),
		f.timedEvent(bot, "inbound", "delivered", past, &recent),
		f.timedEvent(bot, "inbound", "delivered", past, &cutoff),
		f.timedEvent(bot, "update", "delivered", past, &past),
		other.timedEvent(bot, "inbound", "delivered", past, &past),
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range append(append([]model.AssistantTaskEvent{}, settled...), kept...) {
			if _, err := d.InsertEvent(ctx, v); err != nil {
				return err
			}
		}
		for _, v := range []model.AssistantTaskInboxReceipt{
			f.receipt(inbox.InboxID, "a", past, past),
			f.receipt(inbox.InboxID, "b", past, past),
			f.receipt(uuid.NewString(), "tombstone inbox", past, past),
			f.receipt(inbox.InboxID, "live", past, now.Add(time.Hour)),
			other.receipt(otherInbox.InboxID, "a", past, past),
		} {
			if ok, err := d.InsertInboxReceipt(ctx, v); err != nil || !ok {
				t.Fatalf("receipt insert: %v %v", ok, err)
			}
		}
		reclaimTasks := func(owner string, want ...string) {
			t.Helper()
			ids, err := d.InboundReclaimTasks(ctx, owner, cutoff, 10)
			if err != nil || len(ids) != len(want) || len(want) == 1 && ids[0] != want[0] {
				t.Fatalf("reclamation tasks of %s: got %v want %v %v", owner, ids, want, err)
			}
		}
		reclaimTasks(f.owner, f.task.ID)
		reclaimTasks(other.owner, other.task.ID)
		reclaimTasks(uuid.NewString())
		if ids, err := d.InboundReclaimTasks(ctx, f.owner, cutoff, 0); err != nil || len(ids) != 0 {
			t.Fatalf("reclamation task limit ignored: %v %v", ids, err)
		}
		if n, err := d.ReclaimInboxReceipts(ctx, uuid.NewString(), f.task.ID, 10); err != nil || n != 0 {
			t.Fatalf("foreign owner reclaimed receipts: %d %v", n, err)
		}
		if n, err := d.ReclaimInboundEvents(ctx, uuid.NewString(), f.task.ID, cutoff, 10); err != nil || n != 0 {
			t.Fatalf("foreign owner reclaimed events: %d %v", n, err)
		}
		for _, want := range []int64{2, 1, 0} {
			if n, err := d.ReclaimInboxReceipts(ctx, f.owner, f.task.ID, 2); err != nil || n != want {
				t.Fatalf("receipt reclamation: got %d want %d %v", n, want, err)
			}
			if n, err := d.ReclaimInboundEvents(ctx, f.owner, f.task.ID, cutoff, 2); err != nil || n != want {
				t.Fatalf("event reclamation: got %d want %d %v", n, want, err)
			}
		}
		reclaimTasks(f.owner)
		if _, err := d.InboxReceipt(ctx, f.owner, inbox.InboxID, "live"); err != nil {
			t.Fatalf("unexpired receipt reclaimed: %v", err)
		}
		if _, err := d.InboxReceipt(ctx, other.owner, otherInbox.InboxID, "a"); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired receipt became readable: %v", err)
		}
		if n, err := d.ReclaimInboxReceipts(ctx, other.owner, other.task.ID, 10); err != nil || n != 1 {
			t.Fatalf("another task's receipt was reclaimed: %d %v", n, err)
		}
		for _, v := range settled {
			_, err := d.Event(ctx, f.owner, f.task.ID, v.ID)
			notFound(t, err, "settled inbound event")
		}
		for _, v := range kept {
			if _, err := d.Event(ctx, v.OwnerUserID, v.TaskID, v.ID); err != nil {
				t.Fatalf("event %s/%s reclaimed: %v", v.Type, v.State, err)
			}
		}
		return nil
	})
}

func TestInboundRetentionStartsWhenEventLeavesPending(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	bot := uuid.NewString()
	var created time.Time
	f.write(t, func(d store.AssistantTaskDAO) (err error) {
		created, err = d.Now(ctx)
		created = created.Add(-time.Hour)
		return err
	})
	expired := f.timedEvent(bot, "inbound", "pending", created, nil)
	delivered := f.timedEvent(bot, "inbound", "pending", created, nil)
	retargeted := f.timedEvent(bot, "inbound", "pending", created, nil)
	var settledBy time.Time
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range []model.AssistantTaskEvent{expired, delivered, retargeted} {
			if ok, err := d.InsertEvent(ctx, v); err != nil || !ok {
				t.Fatalf("event insert: %v %v", ok, err)
			}
		}
		now, err := d.Now(ctx)
		if err != nil {
			return err
		}
		expired.State = "expired"
		delivered.State, delivered.DeliveredAt = "delivered", &now
		retargeted.TargetBotID = uuid.NewString()
		for _, v := range []model.AssistantTaskEvent{expired, delivered, retargeted} {
			if ok, err := d.SaveEvent(ctx, v, "pending"); err != nil || !ok {
				t.Fatalf("event save: %v %v", ok, err)
			}
		}
		settledBy, err = d.Now(ctx)
		return err
	})
	settledAt := func() time.Time {
		var at time.Time
		if err := f.db.Pool.QueryRow(ctx, `SELECT settled_at FROM assistant_task_events WHERE id=$1`, expired.ID).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	first := settledAt()
	f.write(t, func(d store.AssistantTaskDAO) error {
		if ok, err := d.SaveEvent(ctx, expired, "expired"); err != nil || !ok {
			t.Fatalf("settled event save: %v %v", ok, err)
		}
		return nil
	})
	if again := settledAt(); !again.Equal(first) || !first.Before(settledBy) || !first.After(created) {
		t.Fatalf("settlement time moved: %v then %v", first, again)
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		if n, err := d.ReclaimInboundEvents(ctx, f.owner, f.task.ID, created.Add(time.Minute), 10); err != nil || n != 0 {
			t.Fatalf("events reclaimed by creation time: %d %v", n, err)
		}
		if n, err := d.ReclaimInboundEvents(ctx, f.owner, f.task.ID, settledBy, 10); err != nil || n != 2 {
			t.Fatalf("settled events not reclaimed: %d %v", n, err)
		}
		if _, err := d.Event(ctx, f.owner, f.task.ID, retargeted.ID); err != nil {
			t.Fatalf("pending event reclaimed: %v", err)
		}
		return nil
	})
}
