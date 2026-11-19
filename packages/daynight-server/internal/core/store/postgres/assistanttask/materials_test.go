package assistanttask_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
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

func appendixFixture(f fixture) model.AssistantTaskAppendix {
	return model.AssistantTaskAppendix{ID: uuid.NewString(), OwnerUserID: f.owner, TaskID: f.task.ID, Text: "Lesson", State: "active", RequestFingerprint: "appendix", SourceRecords: []string{}, Version: 1, CreatedAt: f.task.CreatedAt, UpdatedAt: f.task.CreatedAt,
		Scope: model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{}}}
}

func TestAppendixScopeAndCountsSaveWithoutVersionChange(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	appendix := appendixFixture(f)
	f.write(t, func(d store.AssistantTaskDAO) error { _, err := d.InsertAppendix(ctx, appendix); return err })
	stamp := f.task.CreatedAt.Add(time.Minute)
	appendix.Scope = model.AssistantTaskAppendixScope{ProjectIDs: []string{uuid.NewString()}, EventTypes: []string{"report", "escalation"}, ItemCategories: []string{"build"}}
	appendix.SuccessCount, appendix.FailureCount, appendix.LastValidatedAt = 4, 1, &stamp
	f.write(t, func(d store.AssistantTaskDAO) error {
		if ok, err := d.SaveAppendix(ctx, appendix, 2); err != nil || ok {
			t.Fatalf("stale version saved: %v %v", ok, err)
		}
		ok, err := d.SaveAppendix(ctx, appendix, 1)
		if err == nil && !ok {
			t.Fatal("current version refused")
		}
		return err
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		page, err := d.Appendices(ctx, store.AssistantTaskQuery{OwnerUserID: f.owner, TaskID: f.task.ID, Limit: 10})
		if err == nil && (len(page) != 1 || !reflect.DeepEqual(page[0], appendix)) {
			t.Fatalf("scope and counts did not round-trip: %#v", page)
		}
		return err
	})
}

func TestAppendixValidationIsUniquePerOutcomeAndRemovedWithAppendix(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	first, second := appendixFixture(f), appendixFixture(f)
	outcome := uuid.NewString()
	validation := func(appendix string) model.AssistantTaskAppendixValidation {
		return model.AssistantTaskAppendixValidation{OwnerUserID: f.owner, TaskID: f.task.ID, AppendixID: appendix, OutcomeRecordID: outcome, Outcome: "effective", ValidatorBotID: uuid.NewString(), CreatedAt: f.task.CreatedAt}
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, appendix := range []model.AssistantTaskAppendix{first, second} {
			if _, err := d.InsertAppendix(ctx, appendix); err != nil {
				return err
			}
			if ok, err := d.InsertAppendixValidation(ctx, validation(appendix.ID)); err != nil || !ok {
				t.Fatalf("first validation of %s refused: %v %v", appendix.ID, ok, err)
			}
		}
		ok, err := d.InsertAppendixValidation(ctx, validation(first.ID))
		if err == nil && ok {
			t.Fatal("duplicate validation counted")
		}
		return err
	})
	count := func(appendix string) int {
		var n int
		if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM assistant_task_appendix_validations WHERE appendix_id=$1`, appendix).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Another owner's delete cannot remove the registrations.
	f.write(t, func(d store.AssistantTaskDAO) error {
		return d.DeleteAppendixValidations(ctx, uuid.NewString(), f.task.ID, first.ID)
	})
	f.write(t, func(d store.AssistantTaskDAO) error {
		return d.DeleteAppendixValidations(ctx, f.owner, f.task.ID, first.ID)
	})
	if count(first.ID) != 0 || count(second.ID) != 1 {
		t.Fatalf("validation removal scope: %d %d", count(first.ID), count(second.ID))
	}
	f.write(t, func(d store.AssistantTaskDAO) error {
		ok, err := d.InsertAppendixValidation(ctx, validation(first.ID))
		if err == nil && !ok {
			t.Fatal("removed validation still blocks registration")
		}
		return err
	})
}

func TestConcurrentDuplicateValidationWaitsAndIsRefused(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	appendix, outcome := uuid.NewString(), uuid.NewString()
	blocker, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rollbackDatabase(t, blocker)
	if _, err := blocker.Exec(ctx, `INSERT INTO assistant_task_appendix_validations(owner_user_id,task_id,appendix_id,outcome_record_id,outcome,validator_bot_id,created_at) VALUES($1,$2,$3,$4,'effective',$5,clock_timestamp())`, f.owner, f.task.ID, appendix, outcome, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	result := asyncDatabase(t, ctx, func(ctx context.Context) error {
		_, err := f.db.WriteAssistantTask(ctx, func(s store.AssistantTaskScope) error {
			ok, err := s.AssistantTaskDAO().InsertAppendixValidation(ctx, model.AssistantTaskAppendixValidation{OwnerUserID: f.owner, TaskID: f.task.ID, AppendixID: appendix, OutcomeRecordID: outcome, Outcome: "ineffective", ValidatorBotID: uuid.NewString(), CreatedAt: f.task.CreatedAt})
			if err == nil && ok {
				t.Error("concurrent duplicate validation inserted")
			}
			return err
		})
		return err
	})
	testutil.WaitForQueryLock(t, f.db.Pool, "INSERT INTO assistant_task_appendix_validations")
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	var outcomeValue string
	if err := f.db.Pool.QueryRow(ctx, `SELECT outcome FROM assistant_task_appendix_validations WHERE appendix_id=$1`, appendix).Scan(&outcomeValue); err != nil || outcomeValue != "effective" {
		t.Fatalf("committed validation changed: %s %v", outcomeValue, err)
	}
}

func TestRelatedAppendicesRankScopeMatchesInTheDatabase(t *testing.T) {
	f := setup(t)
	f.create(t)
	ctx := t.Context()
	project := uuid.NewString()
	t1, t2, t3 := f.task.CreatedAt.Add(time.Minute), f.task.CreatedAt.Add(2*time.Minute), f.task.CreatedAt.Add(3*time.Minute)
	// Fixed IDs make the final ID tie-break observable.
	id := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
	scoped := func(n int, scope model.AssistantTaskAppendixScope, validated *time.Time) model.AssistantTaskAppendix {
		v := appendixFixture(f)
		v.ID = id(n)
		for _, set := range []*[]string{&scope.ProjectIDs, &scope.EventTypes, &scope.ItemCategories} {
			if *set == nil {
				*set = []string{}
			}
		}
		v.Scope, v.LastValidatedAt = scope, validated
		if validated != nil {
			v.SuccessCount = 1
		}
		return v
	}
	full := scoped(1, model.AssistantTaskAppendixScope{ProjectIDs: []string{project}, EventTypes: []string{"report"}, ItemCategories: []string{"build"}}, nil)
	eventOld := scoped(2, model.AssistantTaskAppendixScope{EventTypes: []string{"escalation", "report"}}, &t2)
	eventTie := scoped(3, model.AssistantTaskAppendixScope{ItemCategories: []string{"deploy", "build"}}, &t2)
	eventNew := scoped(4, model.AssistantTaskAppendixScope{ProjectIDs: []string{project}}, &t3)
	open := scoped(5, model.AssistantTaskAppendixScope{}, &t1)
	edited := scoped(6, model.AssistantTaskAppendixScope{}, nil)
	edited.State = "edited"
	unvalidated := scoped(7, model.AssistantTaskAppendixScope{}, nil)
	// Each of these declares a dimension that the full context does not match.
	mismatched := []model.AssistantTaskAppendix{
		scoped(10, model.AssistantTaskAppendixScope{ProjectIDs: []string{uuid.NewString()}}, &t3),
		scoped(11, model.AssistantTaskAppendixScope{EventTypes: []string{"report"}, ItemCategories: []string{" build "}}, &t3),
		scoped(12, model.AssistantTaskAppendixScope{EventTypes: []string{"escalation"}}, &t3),
	}
	deleted := scoped(13, model.AssistantTaskAppendixScope{}, &t3)
	deleted.State = "deleted"
	otherTask := scoped(14, model.AssistantTaskAppendixScope{}, &t3)
	otherTask.TaskID = uuid.NewString()
	otherOwner := scoped(15, model.AssistantTaskAppendixScope{}, &t3)
	otherOwner.OwnerUserID = uuid.NewString()
	f.write(t, func(d store.AssistantTaskDAO) error {
		for _, v := range append([]model.AssistantTaskAppendix{unvalidated, open, eventTie, full, edited, eventNew, eventOld, deleted, otherTask, otherOwner}, mismatched...) {
			if ok, err := d.InsertAppendix(ctx, v); err != nil || !ok {
				t.Fatalf("insert %s: %v %v", v.ID, ok, err)
			}
		}
		return nil
	})
	related := func(q store.AssistantTaskRelatedQuery) []string {
		t.Helper()
		q.OwnerUserID, q.TaskID = f.owner, f.task.ID
		var ids []string
		f.write(t, func(d store.AssistantTaskDAO) error {
			rows, err := d.RelatedAppendices(ctx, q)
			for _, row := range rows {
				ids = append(ids, row.ID)
			}
			return err
		})
		return ids
	}
	query := store.AssistantTaskRelatedQuery{ProjectID: project, EventType: "report", ItemCategory: "build", Limit: 10}
	want := []string{full.ID, eventNew.ID, eventTie.ID, eventOld.ID, open.ID, unvalidated.ID, edited.ID}
	if got := related(query); !reflect.DeepEqual(got, want) {
		t.Fatalf("related order %v, want %v", got, want)
	}
	query.Limit = 5
	if got := related(query); !reflect.DeepEqual(got, want[:5]) {
		t.Fatalf("bounded related order %v, want %v", got, want[:5])
	}
	// Omitted dimensions are neutral: scoped appendices stay visible and the
	// order falls back to the remaining declared matches and validation time.
	want = []string{mismatched[2].ID, mismatched[1].ID, mismatched[0].ID, eventNew.ID, eventTie.ID, eventOld.ID, open.ID, unvalidated.ID, edited.ID, full.ID}
	if got := related(store.AssistantTaskRelatedQuery{Limit: 10}); !reflect.DeepEqual(got, want) {
		t.Fatalf("unrestricted related order %v, want %v", got, want)
	}
	want = []string{mismatched[2].ID, eventOld.ID, mismatched[0].ID, eventNew.ID, eventTie.ID, open.ID, unvalidated.ID, edited.ID}
	if got := related(store.AssistantTaskRelatedQuery{EventType: "escalation", Limit: 10}); !reflect.DeepEqual(got, want) {
		t.Fatalf("event-only related order %v, want %v", got, want)
	}
}
