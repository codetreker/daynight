package assistanttask_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestAcknowledgementPreservesConcurrentSeenTime(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	event := model.AssistantTaskEvent{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: uuid.NewString(), Type: "changed", State: "pending", RequestFingerprint: "event", Payload: json.RawMessage(`{}`), Attention: true, CreatedAt: f.task.CreatedAt}
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := d.InsertEvent(ctx, event); return err })
	// The acknowledgement retains the earlier event snapshot while another
	// transaction commits the dashboard read across the owner's tasks.
	seen := f.task.CreatedAt.Add(time.Second)
	f.write(t, func(d store.AssistantTaskDAO) error {
		return d.MarkAttentionSeen(ctx, f.owner, event.TargetBotID, seen, []string{})
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		event.State = "delivered"
		event.DeliveredAt = &seen
		ok, err := d.SaveEvent(ctx, event, "pending")
		if err == nil && !ok {
			t.Fatal("acknowledgement was not saved")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Event(ctx, f.owner, f.task.ID, event.ID)
		if err == nil && (got.SeenAt == nil || !got.SeenAt.Equal(seen) || got.State != "delivered") {
			t.Fatalf("acknowledgement overwrote committed seen time: %#v", got)
		}
		return err
	})
}

func TestSeenTypeExclusionsAndNilList(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	bot := uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString()}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i, kind := range []string{"changed", "proposal_pending"} {
			_, err := d.InsertEvent(ctx, model.AssistantTaskEvent{ID: ids[i], OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: bot, Type: kind, State: "pending", Payload: json.RawMessage(`{}`), Attention: true, CreatedAt: f.task.CreatedAt})
			if err != nil {
				return err
			}
		}
		return d.MarkAttentionSeen(ctx, f.owner, bot, f.task.CreatedAt, []string{"proposal_pending"})
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		ordinary, err := d.Event(ctx, f.owner, f.task.ID, ids[0])
		if err != nil {
			return err
		}
		proposal, err := d.Event(ctx, f.owner, f.task.ID, ids[1])
		if err != nil {
			return err
		}
		if ordinary.SeenAt == nil || proposal.SeenAt != nil {
			t.Fatal("attention exclusions were not applied")
		}
		return d.MarkAttentionSeen(ctx, f.owner, bot, f.task.CreatedAt.Add(time.Second), nil)
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		ordinary, err := d.Event(ctx, f.owner, f.task.ID, ids[0])
		if err != nil {
			return err
		}
		proposal, err := d.Event(ctx, f.owner, f.task.ID, ids[1])
		if err != nil {
			return err
		}
		if ordinary.SeenAt == nil || !ordinary.SeenAt.Equal(f.task.CreatedAt) || proposal.SeenAt == nil {
			t.Fatal("nil exclusion list failed or existing seen time changed")
		}
		return nil
	})
}
