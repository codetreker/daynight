package assistanttask_test

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestInquiryStateFiltersPrecedeItemCursorAndLimit(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	cutoff := f.task.CreatedAt
	targetItem, otherItem := uuid.NewString(), uuid.NewString()
	bot := uuid.NewString()
	var desired []model.AssistantTaskInquiry
	f.write(t, func(d store.AssistantTaskDAO) error {
		// More than one maintenance batch belongs to another item and must not
		// displace the requested item's effective-state page.
		for i := 0; i < 202; i++ {
			v := model.AssistantTaskInquiry{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: &otherItem, FromBotID: bot, ToBotID: bot, Question: "Other", State: "open", Deadline: cutoff, CreatedAt: cutoff.Add(time.Duration(i-300) * time.Second)}
			if _, err := d.InsertInquiry(ctx, v); err != nil {
				return err
			}
		}
		for i, state := range []string{"timed_out", "open", "open", "answered"} {
			v := model.AssistantTaskInquiry{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: &targetItem, FromBotID: bot, ToBotID: bot, Question: "Requested", State: state, Deadline: cutoff, CreatedAt: cutoff.Add(time.Duration(i-5) * time.Second)}
			if i == 2 {
				v.Deadline = cutoff.Add(time.Minute)
			}
			if _, err := d.InsertInquiry(ctx, v); err != nil {
				return err
			}
			desired = append(desired, v)
		}
		return nil
	})
	for _, tc := range []struct {
		name, state string
		after       *time.Time
		include     *time.Time
		position    *store.AssistantTaskPosition
		want        []string
	}{
		{name: "timed-out-lookahead", state: "timed_out", include: &cutoff, want: []string{desired[0].ID, desired[1].ID}},
		{name: "timed-out-cursor", state: "timed_out", include: &cutoff, position: &store.AssistantTaskPosition{CreatedAt: desired[0].CreatedAt, ID: desired[0].ID}, want: []string{desired[1].ID}},
		{name: "open", state: "open", after: &cutoff, want: []string{desired[2].ID}},
		{name: "answered", state: "answered", want: []string{desired[3].ID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f.write(t, func(d store.AssistantTaskDAO) error {
				values, err := d.Inquiries(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: targetItem, State: tc.state, DeadlineAfter: tc.after, IncludeExpiredOpen: tc.include, After: tc.position, Limit: 1})
				if err != nil {
					return err
				}
				if len(values) != len(tc.want) {
					t.Fatalf("filtered page: %#v", values)
				}
				for i, v := range values {
					if v.ID != tc.want[i] {
						t.Fatalf("wrong filtered position %d: %s", i, v.ID)
					}
				}
				// Querying an effective state does not perform the core-owned transition.
				persisted, err := d.Inquiry(ctx, f.owner, f.task.ID, desired[1].ID)
				if err == nil && persisted.State != "open" {
					t.Fatal("DAO query changed inquiry state")
				}
				return err
			})
		})
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		values, err := d.Inquiries(ctx, store.AssistantTaskQuery{OwnerUserID: uuid.NewString(), TaskID: f.task.ID, State: "timed_out", IncludeExpiredOpen: &cutoff, Limit: 200})
		if err == nil && len(values) != 0 {
			t.Fatal("expired-open union escaped owner scope")
		}
		return err
	})
}
