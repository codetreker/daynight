package assistanttask_test

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestProposalRulesFilterRunsBeforePagination(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	matched := "00000000-0000-4000-8000-000000000003"
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i, id := range []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", matched} {
			rules := json.RawMessage(`{"scope":"other"}`)
			if i == 2 {
				rules = json.RawMessage(`{"enabled":true,"scope":"selected"}`)
			}
			_, err := d.InsertProposal(ctx, model.AssistantTaskProposal{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Rules: rules, EvidenceRecords: []string{}, Status: "pending", CreatedAt: f.task.CreatedAt})
			if err != nil {
				return err
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Proposals(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, State: "pending", RulesEqual: json.RawMessage(`{"scope":"selected", "enabled":true}`), Limit: 1})
		if err == nil && (len(got) != 1 || got[0].ID != matched) {
			t.Fatalf("rules were not filtered before limit: %#v", got)
		}
		return err
	})
}

func TestInquiryPreservesOriginalTargetAndActualAnswerer(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	answerer := uuid.NewString()
	inquiry := model.AssistantTaskInquiry{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, FromBotID: uuid.NewString(), ToBotID: uuid.NewString(), Question: "Status?", State: "open", CreatedAt: f.task.CreatedAt, Deadline: f.task.CreatedAt}
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := d.InsertInquiry(ctx, inquiry); return err })
	f.write(t, func(d store.AssistantTaskDAO) error {
		inquiry.State = "answered"
		inquiry.Answer = "Ready"
		inquiry.AnswerBotID = &answerer
		inquiry.AnsweredAt = &f.task.CreatedAt
		ok, err := d.SaveInquiry(ctx, inquiry, "open")
		if err == nil && !ok {
			t.Fatal("answer refused")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Inquiry(ctx, f.owner, f.task.ID, inquiry.ID)
		if err == nil && (got.ToBotID != inquiry.ToBotID || got.AnswerBotID == nil || *got.AnswerBotID != answerer || got.Answer != "Ready") {
			t.Fatalf("answer identity lost: %#v", got)
		}
		return err
	})
}

func TestInquiryItemFilterRunsBeforePagination(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	selected, other := uuid.NewString(), uuid.NewString()
	matched := "00000000-0000-4000-8000-000000000003"
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i, id := range []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", matched} {
			item := &other
			if i == 2 {
				item = &selected
			}
			_, err := d.InsertInquiry(ctx, model.AssistantTaskInquiry{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, FromBotID: uuid.NewString(), ToBotID: uuid.NewString(), ItemID: item, State: "open", CreatedAt: f.task.CreatedAt, Deadline: f.task.CreatedAt})
			if err != nil {
				return err
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Inquiries(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, State: "open", ItemID: selected, Limit: 1})
		if err == nil && (len(got) != 1 || got[0].ID != matched) {
			t.Fatalf("item filter did not precede limit: %#v", got)
		}
		return err
	})
}
