package assistanttask_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMaterialConditionsRejectForeignAndStaleWrites(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	foreign := uuid.NewString()
	id := uuid.NewString()
	appendix := model.AssistantTaskAppendix{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Text: "Before", State: "active", SourceRecords: []string{}, Version: 1, CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt}
	proposal := model.AssistantTaskProposal{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Body: "Before", Status: "pending", Rules: json.RawMessage(`[]`), EvidenceRecords: []string{}, CreatedAt: f.task.CreatedAt}
	item := model.AssistantTaskItem{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Key: "identity", State: "open", Version: 1, AppState: json.RawMessage(`{}`), CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt}
	event := model.AssistantTaskEvent{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: uuid.NewString(), State: "pending", Payload: json.RawMessage(`{}`), CreatedAt: f.task.CreatedAt}
	inquiry := model.AssistantTaskInquiry{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, FromBotID: uuid.NewString(), ToBotID: uuid.NewString(), State: "open", CreatedAt: f.task.CreatedAt, Deadline: f.task.CreatedAt}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, insert := range []func() (bool, error){func() (bool, error) { return d.InsertAppendix(ctx, appendix) }, func() (bool, error) { return d.InsertProposal(ctx, proposal) }, func() (bool, error) { return d.InsertItem(ctx, item) }, func() (bool, error) { return d.InsertEvent(ctx, event) }, func() (bool, error) { return d.InsertInquiry(ctx, inquiry) }} {
			for _, want := range []bool{true, false} {
				ok, err := insert()
				if err != nil {
					return err
				}
				if ok != want {
					return fmt.Errorf("insert idempotency: %v != %v", ok, want)
				}
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		appendix.Text = "After"
		appendix.Version = 2
		proposal.Body = "After"
		proposal.Status = "approved"
		item.State = "closed"
		item.Version = 2
		event.State = "delivered"
		inquiry.State = "answered"
		inquiry.Answer = "After"
		writers := []func(string, bool) (bool, error){
			func(owner string, wrong bool) (bool, error) {
				v := appendix
				v.OwnerUserID = owner
				version := int64(1)
				if wrong {
					version = 9
				}
				return d.SaveAppendix(ctx, v, version)
			},
			func(owner string, wrong bool) (bool, error) {
				v := proposal
				v.OwnerUserID = owner
				state := "pending"
				if wrong {
					state = "rejected"
				}
				return d.SaveProposal(ctx, v, state)
			},
			func(owner string, wrong bool) (bool, error) {
				v := item
				v.OwnerUserID = owner
				version := int64(1)
				if wrong {
					version = 9
				}
				return d.SaveItem(ctx, v, version)
			},
			func(owner string, wrong bool) (bool, error) {
				v := event
				v.OwnerUserID = owner
				state := "pending"
				if wrong {
					state = "expired"
				}
				return d.SaveEvent(ctx, v, state)
			},
			func(owner string, wrong bool) (bool, error) {
				v := inquiry
				v.OwnerUserID = owner
				state := "open"
				if wrong {
					state = "timed_out"
				}
				return d.SaveInquiry(ctx, v, state)
			},
		}
		for i, write := range writers {
			for _, step := range []struct {
				owner       string
				wrong, want bool
			}{{foreign, false, false}, {f.owner, true, false}, {f.owner, false, true}, {f.owner, false, false}} {
				ok, err := write(step.owner, step.wrong)
				if err != nil {
					return err
				}
				if ok != step.want {
					return fmt.Errorf("material %d conditional save: %v != %v", i, ok, step.want)
				}
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		a, err := d.Appendix(ctx, f.owner, f.task.ID, id)
		if err != nil {
			return err
		}
		if a.Text != "After" || a.Version != 2 {
			return fmt.Errorf("appendix update lost")
		}
		p, err := d.Proposal(ctx, f.owner, f.task.ID, id)
		if err != nil {
			return err
		}
		if p.Body != "After" || p.Status != "approved" {
			return fmt.Errorf("proposal update lost")
		}
		i, err := d.Item(ctx, f.owner, f.task.ID, id)
		if err != nil {
			return err
		}
		if i.State != "closed" || i.Key != "identity" || i.Version != 2 {
			return fmt.Errorf("item identity lost")
		}
		e, err := d.Event(ctx, f.owner, f.task.ID, id)
		if err != nil {
			return err
		}
		if e.State != "delivered" {
			return fmt.Errorf("event update lost")
		}
		in, err := d.Inquiry(ctx, f.owner, f.task.ID, id)
		if err != nil {
			return err
		}
		if in.State != "answered" || in.Answer != "After" {
			return fmt.Errorf("inquiry update lost")
		}
		return nil
	})
}

func TestTransferOnlyMovesOpenItemsAndPreservesIdentity(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	oldBot, newBot := uuid.NewString(), uuid.NewString()
	openID, closedID := uuid.NewString(), uuid.NewString()
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i, id := range []string{openID, closedID} {
			state := "open"
			if i == 1 {
				state = "closed"
			}
			_, err := d.InsertItem(ctx, model.AssistantTaskItem{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Key: id, State: state, FollowerBotID: &oldBot, Version: 1, Episode: 4, AppState: json.RawMessage(`{"external":"stable"}`), CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt})
			if err != nil {
				return err
			}
		}
		return d.TransferOpenItems(ctx, f.owner, f.task.ID, &newBot)
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		if err := d.TransferOpenItems(ctx, f.owner, f.task.ID, &newBot); err != nil {
			return err
		}
		open, err := d.Item(ctx, f.owner, f.task.ID, openID)
		if err != nil {
			return err
		}
		closed, err := d.Item(ctx, f.owner, f.task.ID, closedID)
		if err != nil {
			return err
		}
		if open.FollowerBotID == nil || *open.FollowerBotID != newBot || open.Version != 2 || open.Episode != 4 || open.Key != openID || closed.FollowerBotID == nil || *closed.FollowerBotID != oldBot || closed.Version != 1 {
			return fmt.Errorf("transfer changed identity or closed work: open=%#v closed=%#v", open, closed)
		}
		var state map[string]string
		if err := json.Unmarshal(open.AppState, &state); err != nil || state["external"] != "stable" {
			return fmt.Errorf("external operation identity changed: %s", open.AppState)
		}
		return nil
	})
}

func TestDeletedAppendixPersistsEmptySourceRecords(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	appendix := model.AssistantTaskAppendix{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Text: "Evidence", State: "edited", SourceRecords: []string{uuid.NewString()}, Version: 2, CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt}
	f.write(t, func(d store.AssistantTaskDAO) error {
		_, err := d.InsertAppendix(ctx, appendix)
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		appendix.Text, appendix.State = "", "deleted"
		appendix.SourceRecords = []string{}
		appendix.Version = 3
		ok, err := d.SaveAppendix(ctx, appendix, 2)
		if err == nil && !ok {
			t.Fatal("matching appendix deletion refused")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		got, err := d.Appendix(ctx, f.owner, f.task.ID, appendix.ID)
		if err == nil && (got.State != "deleted" || got.Text != "" || got.SourceRecords == nil || len(got.SourceRecords) != 0 || got.Version != 3) {
			t.Fatalf("deleted appendix readback differs: %#v", got)
		}
		return err
	})
}
