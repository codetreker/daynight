package assistanttask_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestMaterialKeysetsAndOwnerFilters(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	bot := uuid.NewString()
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i, id := range ids {
			if err := d.InsertManual(ctx, model.AssistantTaskManual{OwnerUserID: f.owner, TaskID: f.task.ID, Version: int64(i + 1), Rules: json.RawMessage(`[]`), CreatedAt: f.task.CreatedAt}); err != nil {
				return err
			}
			writes := []func() (bool, error){
				func() (bool, error) {
					return d.InsertAppendix(ctx, model.AssistantTaskAppendix{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, State: "active", SourceRecords: []string{}, Version: 1, CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt})
				},
				func() (bool, error) {
					return d.InsertProposal(ctx, model.AssistantTaskProposal{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Status: "pending", Rules: json.RawMessage(`[]`), EvidenceRecords: []string{}, CreatedAt: f.task.CreatedAt})
				},
				func() (bool, error) {
					return d.InsertItem(ctx, model.AssistantTaskItem{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, Key: id, State: "open", Version: 1, AppState: json.RawMessage(`{}`), CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt})
				},
				func() (bool, error) {
					return d.InsertEvent(ctx, model.AssistantTaskEvent{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, TargetBotID: bot, State: "pending", Payload: json.RawMessage(`{}`), CreatedAt: f.task.CreatedAt})
				},
				func() (bool, error) {
					return d.InsertInquiry(ctx, model.AssistantTaskInquiry{ID: id, OwnerUserID: f.owner, TaskID: f.task.ID, FromBotID: bot, ToBotID: uuid.NewString(), State: "open", CreatedAt: f.task.CreatedAt, Deadline: f.task.CreatedAt})
				},
			}
			for _, write := range writes {
				ok, err := write()
				if err != nil {
					return err
				}
				if !ok {
					return fmt.Errorf("material %s skipped", id)
				}
			}
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		q := store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 1, After: &store.AssistantTaskPosition{CreatedAt: f.task.CreatedAt, ID: ids[0]}}
		check := func(name string, got []string, err error) error {
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(got, ids[1:]) {
				return fmt.Errorf("%s keyset: %v", name, got)
			}
			return nil
		}
		a, err := d.Appendices(ctx, q)
		got := []string{}
		for _, v := range a {
			got = append(got, v.ID)
		}
		if err := check("appendix", got, err); err != nil {
			return err
		}
		p, err := d.Proposals(ctx, q)
		got = nil
		for _, v := range p {
			got = append(got, v.ID)
		}
		if err := check("proposal", got, err); err != nil {
			return err
		}
		i, err := d.Items(ctx, q)
		got = nil
		for _, v := range i {
			got = append(got, v.ID)
		}
		if err := check("item", got, err); err != nil {
			return err
		}
		q.TargetBotID = bot
		q.State = "pending"
		e, err := d.Events(ctx, q)
		got = nil
		for _, v := range e {
			got = append(got, v.ID)
		}
		if err := check("event", got, err); err != nil {
			return err
		}
		q.State = "open"
		q.InquiryBotID = bot
		q.DeadlineBefore = &f.task.CreatedAt
		in, err := d.Inquiries(ctx, q)
		got = nil
		for _, v := range in {
			got = append(got, v.ID)
		}
		if err := check("inquiry", got, err); err != nil {
			return err
		}
		q.After.ID = "1"
		manuals, err := d.Manuals(ctx, q)
		if err != nil {
			return err
		}
		if len(manuals) != 2 || manuals[0].Version != 2 || manuals[1].Version != 3 {
			return fmt.Errorf("manual numeric keyset: %#v", manuals)
		}
		q.After = nil
		q.OwnerUserID = uuid.NewString()
		q.State = ""
		for _, list := range []func() (int, error){func() (int, error) { v, e := d.Manuals(ctx, q); return len(v), e }, func() (int, error) { v, e := d.Appendices(ctx, q); return len(v), e }, func() (int, error) { v, e := d.Proposals(ctx, q); return len(v), e }, func() (int, error) { v, e := d.Items(ctx, q); return len(v), e }, func() (int, error) { v, e := d.Events(ctx, q); return len(v), e }, func() (int, error) { v, e := d.Inquiries(ctx, q); return len(v), e }} {
			n, err := list()
			if err != nil {
				return err
			}
			if n != 0 {
				return fmt.Errorf("foreign owner returned %d materials", n)
			}
		}
		return nil
	})
}

func TestRecordsUseTwoHundredRowPagesAndDurableMonotonicPositions(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	item := uuid.NewString()
	var records []model.AssistantTaskRecord
	f.write(t, func(d store.AssistantTaskDAO) error {
		for i := 0; i < 202; i++ {
			record, err := d.InsertRecord(ctx, model.AssistantTaskRecord{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: &item, Author: "user", Text: fmt.Sprint(i), Refs: json.RawMessage(`[]`)})
			if err != nil {
				return err
			}
			records = append(records, record)
		}
		return nil
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		q := store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, ItemID: item, Limit: 200}
		first, err := d.Records(ctx, q)
		if err != nil {
			return err
		}
		if len(first) != 201 {
			return fmt.Errorf("limit plus lookahead: %d", len(first))
		}
		for i, v := range first {
			if v.ID != records[i].ID || v.Text != fmt.Sprint(i) {
				return fmt.Errorf("record order changed at %d", i)
			}
			if i > 0 && (!v.CreatedAt.After(first[i-1].CreatedAt) && !(v.CreatedAt.Equal(first[i-1].CreatedAt) && v.ID > first[i-1].ID)) {
				return fmt.Errorf("record position did not advance at %d", i)
			}
		}
		q.After = &store.AssistantTaskPosition{CreatedAt: first[199].CreatedAt, ID: first[199].ID}
		last, err := d.Records(ctx, q)
		if err != nil {
			return err
		}
		if len(last) != 2 || last[0].ID != records[200].ID || last[1].ID != records[201].ID {
			return fmt.Errorf("record tail duplicates or omissions: %#v", last)
		}
		q.After = nil
		q.ItemID = uuid.NewString()
		empty, err := d.Records(ctx, q)
		if err != nil {
			return err
		}
		if len(empty) != 0 {
			return fmt.Errorf("item filter ignored")
		}
		q.ItemID = item
		q.OwnerUserID = uuid.NewString()
		empty, err = d.Records(ctx, q)
		if err != nil {
			return err
		}
		if len(empty) != 0 {
			return fmt.Errorf("record owner filter ignored")
		}
		return nil
	})
}
