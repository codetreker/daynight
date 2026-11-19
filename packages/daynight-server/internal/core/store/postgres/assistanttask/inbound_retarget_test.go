package assistanttask_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func (f fixture) event(task, target, kind, state string) model.AssistantTaskEvent {
	return model.AssistantTaskEvent{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: task, TargetBotID: target, Type: kind, State: state, RequestFingerprint: "event", Payload: json.RawMessage(`{"stable":true}`), CreatedAt: f.task.CreatedAt}
}

func (f fixture) eventTarget(t *testing.T, owner, id string) string {
	t.Helper()
	var target string
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT target_bot_id::text FROM assistant_task_events WHERE owner_user_id=$1 AND id=$2`, owner, id).Scan(&target); err != nil {
		t.Fatal(err)
	}
	return target
}

// transfer moves the task to holder with the follower updates the claim
// transaction performs; hold, when set, keeps the transaction open after them.
func (f fixture) transfer(ctx context.Context, holder string, hold func() error) error {
	_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		d := s.AssistantTaskDAO()
		current, err := d.Task(ctx, f.owner, f.task.ID, true)
		if err != nil {
			return err
		}
		candidate := current
		candidate.Version++
		candidate.ClaimGeneration++
		candidate.HolderBotID = &holder
		if ok, err := d.SaveTask(ctx, candidate, store.AssistantTaskCondition{Version: current.Version}); err != nil || !ok {
			return errors.Join(err, errors.New("transfer save refused"))
		}
		if err = d.TransferOpenItems(ctx, f.owner, f.task.ID, &holder); err != nil {
			return err
		}
		if err = d.RetargetPendingInbound(ctx, f.owner, f.task.ID, holder); err != nil {
			return err
		}
		if hold != nil {
			return hold()
		}
		return nil
	})
	return err
}

// admit writes an inbound event for the holder read under the task row lock,
// as inbox admission does.
func (f fixture) admit(ctx context.Context, id string, hold func() error) error {
	_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
		d := s.AssistantTaskDAO()
		current, err := d.Task(ctx, f.owner, f.task.ID, true)
		if err != nil {
			return err
		}
		event := f.event(f.task.ID, *current.HolderBotID, "inbound", "pending")
		event.ID = id
		if ok, err := d.InsertEvent(ctx, event); err != nil || !ok {
			return errors.Join(err, errors.New("inbound insert skipped"))
		}
		if hold != nil {
			return hold()
		}
		return nil
	})
	return err
}

func TestRetargetMovesOnlyTheTasksPendingInboundEvents(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	oldBot, releasedBot, newBot := uuid.NewString(), uuid.NewString(), uuid.NewString()
	otherTask := uuid.NewString()
	moved := []model.AssistantTaskEvent{f.event(f.task.ID, oldBot, "inbound", "pending"), f.event(f.task.ID, releasedBot, "inbound", "pending")}
	kept := []model.AssistantTaskEvent{
		f.event(f.task.ID, newBot, "inbound", "pending"),
		f.event(f.task.ID, oldBot, "inbound", "delivered"),
		f.event(f.task.ID, oldBot, "inbound", "expired"),
		f.event(f.task.ID, oldBot, "changed", "pending"),
		f.event(f.task.ID, oldBot, "claim_lost", "pending"),
		f.event(otherTask, oldBot, "inbound", "pending"),
	}
	foreign := f.event(f.task.ID, oldBot, "inbound", "pending")
	foreign.OwnerUserID = uuid.NewString()
	kept = append(kept, foreign)
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, event := range append(append([]model.AssistantTaskEvent{}, moved...), kept...) {
			if _, err := d.InsertEvent(ctx, event); err != nil {
				return err
			}
		}
		return d.RetargetPendingInbound(ctx, f.owner, f.task.ID, newBot)
	})
	for _, event := range moved {
		got := f.eventTarget(t, f.owner, event.ID)
		if got != newBot {
			t.Fatalf("pending inbound %s targets %s", event.ID, got)
		}
	}
	for _, event := range kept {
		if got := f.eventTarget(t, event.OwnerUserID, event.ID); got != event.TargetBotID {
			t.Fatalf("%s %s event for task %s moved to %s", event.State, event.Type, event.TaskID, got)
		}
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Event(ctx, f.owner, f.task.ID, moved[0].ID)
		if err != nil {
			return err
		}
		var payload map[string]bool
		if err = json.Unmarshal(got.Payload, &payload); err != nil || !payload["stable"] || got.State != "pending" || got.Type != "inbound" || !got.CreatedAt.Equal(moved[0].CreatedAt) || got.DeliveredAt != nil {
			t.Fatalf("retarget changed event identity: %#v", got)
		}
		return err
	})
}

func TestRetargetRollsBackWithTheClaimTransaction(t *testing.T) {
	f := setup(t)
	oldBot, _ := f.bot(t)
	newBot, _ := f.bot(t)
	f.task.HolderBotID = &oldBot
	f.task.ClaimGeneration = 1
	f.create(t)
	event := f.event(f.task.ID, oldBot, "inbound", "pending")
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := d.InsertEvent(t.Context(), event); return err })
	failure := errors.New("controlled receipt failure")
	if err := f.transfer(t.Context(), newBot, func() error { return failure }); !errors.Is(err, failure) {
		t.Fatalf("transfer error %v", err)
	}
	if got := f.eventTarget(t, f.owner, event.ID); got != oldBot {
		t.Fatalf("rolled back transfer left inbound event at %s", got)
	}
	if err := f.transfer(t.Context(), newBot, nil); err != nil {
		t.Fatal(err)
	}
	if got := f.eventTarget(t, f.owner, event.ID); got != newBot {
		t.Fatalf("committed transfer left inbound event at %s", got)
	}
}

func TestInboundAdmissionAndTransferSerializeOnTheTaskLock(t *testing.T) {
	for _, admissionFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "admission holds lock", false: "transfer holds lock"}[admissionFirst], func(t *testing.T) {
			f := setup(t)
			oldBot, _ := f.bot(t)
			newBot, _ := f.bot(t)
			f.task.HolderBotID = &oldBot
			f.task.ClaimGeneration = 1
			f.create(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			id := uuid.NewString()
			holding, release := make(chan struct{}), make(chan struct{})
			hold := func() error {
				close(holding)
				select {
				case <-release:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			first, second := func(context.Context) error { return f.admit(ctx, id, hold) }, func(context.Context) error { return f.transfer(ctx, newBot, nil) }
			if !admissionFirst {
				first, second = func(context.Context) error { return f.transfer(ctx, newBot, hold) }, func(context.Context) error { return f.admit(ctx, id, nil) }
			}
			firstResult := asyncDatabase(t, ctx, first)
			select {
			case <-holding:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			secondResult := asyncDatabase(t, ctx, second)
			testutil.WaitForQueryLock(t, f.db.Pool, "SELECT id::text FROM assistant_tasks WHERE owner_user_id")
			close(release)
			for _, result := range []<-chan error{firstResult, secondResult} {
				if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
					t.Fatal(err)
				}
			}
			if got := f.eventTarget(t, f.owner, id); got != newBot {
				t.Fatalf("inbound event stranded with %s", got)
			}
		})
	}
}
