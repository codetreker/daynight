package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type effects struct {
	record model.AssistantTaskRecord
	event  model.AssistantTaskEvent
}

func expectSystemEffects(t *testing.T, d *daoStub, recordKind, eventType, target string) *effects {
	t.Helper()
	got := &effects{}
	records, events := 0, 0
	if recordKind != "" {
		d.insertRecord = func(_ context.Context, value model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
			records++
			if value.OwnerUserID != ownerID || value.TaskID != taskID || value.Author != "system" || value.AuthorBotID != nil || value.Kind != recordKind || !strictID(value.ID) || value.RequestFingerprint == "" {
				t.Fatalf("wrong system record: %#v", value)
			}
			got.record = value
			return value, nil
		}
	}
	if eventType != "" {
		d.insertEvent = func(_ context.Context, value model.AssistantTaskEvent) (bool, error) {
			events++
			if value.OwnerUserID != ownerID || value.TaskID != taskID || value.TargetBotID != target || value.Type != eventType || value.State != "pending" || !strictID(value.ID) || value.RequestFingerprint == "" {
				t.Fatalf("wrong system event: %#v", value)
			}
			got.event = value
			return true, nil
		}
	}
	t.Cleanup(func() {
		if recordKind != "" && records != 1 {
			t.Errorf("want one system record, got %d", records)
		}
		if eventType != "" && events != 1 {
			t.Errorf("want one system event, got %d", events)
		}
	})
	return got
}

func TestAppendixUsesScopedEvidenceAndProducesQuietNotification(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
		return model.AssistantTaskAppendix{}, model.ErrNotFound
	}
	evidenceRead := false
	d.record = func(_ context.Context, owner, id, record string) (model.AssistantTaskRecord, error) {
		if owner != ownerID || id != taskID || record != operationID {
			t.Fatal("wrong evidence scope")
		}
		evidenceRead = true
		return model.AssistantTaskRecord{ID: record}, nil
	}
	d.insertAppendix = func(_ context.Context, appendix model.AssistantTaskAppendix) (bool, error) {
		if !evidenceRead || appendix.Text != "Inspect the original result" || appendix.State != "active" || appendix.Version != 1 || appendix.AuthorBotID == nil || *appendix.AuthorBotID != botID || !reflect.DeepEqual(appendix.SourceRecords, []string{operationID}) {
			t.Fatalf("wrong appendix: %#v", appendix)
		}
		return true, nil
	}
	effects := expectSystemEffects(t, d, "note", "appendix_added", botID)
	expectTaskWrite(t, d, task, true)
	result, err := New().AddAppendix(context.Background(), d, botActor(), AppendixInput{Mutation: mutation(), Text: "Inspect the original result", SourceRecords: []string{operationID}})
	if err != nil || result.ID != entryID || effects.event.Attention || effects.record.Text != result.Text {
		t.Fatalf("appendix: %#v %#v %v", result, effects, err)
	}
}

func TestAppendixUserEditReplacesReferencesOnlyWhenProvided(t *testing.T) {
	for _, name := range []string{"retain", "replace", "clear", "delete"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			old := model.AssistantTaskAppendix{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, Version: 3, Text: "Old", State: "active", SourceRecords: []string{operationID}, AuthorBotID: ptr(botID)}
			d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) { return old, nil }
			input := AppendixInput{Mutation: mutation(), State: "edited", Text: "New"}
			want := []string{operationID}
			switch name {
			case "replace":
				input.SourceRecords, want = []string{targetID}, []string{targetID}
			case "clear":
				input.SourceRecords, want = []string{}, []string{}
			case "delete":
				input.State, want = "deleted", []string{}
			}
			if name == "replace" {
				d.record = func(_ context.Context, owner, task, record string) (model.AssistantTaskRecord, error) {
					if owner != ownerID || task != taskID || record != targetID {
						t.Fatal("wrong replacement evidence")
					}
					return model.AssistantTaskRecord{ID: record}, nil
				}
			}
			d.saveAppendix = func(_ context.Context, value model.AssistantTaskAppendix, version int64) (bool, error) {
				if version != 3 || value.Version != 4 || value.State != input.State || !reflect.DeepEqual(value.SourceRecords, want) || value.AuthorBotID == nil || *value.AuthorBotID != botID {
					t.Fatalf("wrong edit: %#v", value)
				}
				if input.State == "deleted" && value.Text != "" {
					t.Fatal("deleted appendix retained content")
				}
				return true, nil
			}
			expectTaskWrite(t, d, task, false)
			_, err := New().UpdateAppendix(context.Background(), d, userActor(), input)
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProposalKeepsManualUnchangedAndReturnsRejectedRuleMatches(t *testing.T) {
	task := baseTask()
	task.Application = "builds"
	d := baseDAO(t, task)
	m := New()
	if err := m.RegisterRules("builds", func(old, next json.RawMessage) (bool, error) {
		if string(old) != `{}` || string(next) != `{"max":2}` {
			t.Fatalf("wrong validator inputs: %s %s", old, next)
		}
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
		return model.AssistantTaskProposal{}, model.ErrNotFound
	}
	d.manual = func(_ context.Context, owner, id string, version int64) (model.AssistantTaskManual, error) {
		if owner != ownerID || id != taskID || version != 1 {
			t.Fatal("wrong proposal base")
		}
		return model.AssistantTaskManual{Rules: json.RawMessage(`{}`)}, nil
	}
	d.insertProposal = func(_ context.Context, proposal model.AssistantTaskProposal) (bool, error) {
		if proposal.Status != "pending" || !proposal.Widens || proposal.BaseVersion != 1 || proposal.Body != "New manual" || proposal.Reason != "Observed repeated failure" {
			t.Fatalf("wrong candidate: %#v", proposal)
		}
		return true, nil
	}
	d.proposals = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
		if q.OwnerUserID != ownerID || q.TaskID != taskID || q.State != "rejected" || q.Limit != 200 || string(q.RulesEqual) != `{"max":2}` {
			t.Fatalf("wrong rejected match query: %#v", q)
		}
		return []model.AssistantTaskProposal{{ID: operationID, Status: "rejected", Reason: "Earlier evidence"}}, nil
	}
	effects := expectSystemEffects(t, d, "", "proposal_pending", botID)
	saved := expectTaskWrite(t, d, task, true)
	result, err := m.Propose(context.Background(), d, botActor(), ProposalInput{Mutation: mutation(), BaseVersion: 1, Body: "New manual", Reason: "Observed repeated failure", Rules: json.RawMessage(`{ "max": 2 }`)})
	if err != nil || len(result.RejectedMatches) != 1 || result.RejectedMatches[0].ID != operationID || saved.ManualVersion != 1 || effects.event.ID != entryID || !effects.event.Attention {
		t.Fatalf("proposal: %#v %#v %v", result, effects, err)
	}
}

func TestProposalReplaySurvivesManualAndValidatorChanges(t *testing.T) {
	task := baseTask()
	task.ManualVersion = 8
	task.Application = "unregistered-now"
	d := baseDAO(t, task)
	input := ProposalInput{Mutation: mutation(), BaseVersion: 1, Body: "Body", Reason: "Reason", Rules: json.RawMessage(`{"level":2}`)}
	hash := savedFingerprint(t, []any{entryID, taskID, ptr(botID), int64(1), "Body", json.RawMessage(`{"level":2}`), "Reason", []string(nil)})
	d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
		return model.AssistantTaskProposal{ID: entryID, Status: "approved", RequestFingerprint: hash}, nil
	}
	result, err := New().Propose(context.Background(), d, botActor(), input)
	if err != nil || result.Proposal.Status != "approved" || result.RejectedMatches == nil {
		t.Fatalf("replay: %#v %v", result, err)
	}
}

func TestUserDecisionAppendsManualAndClearsOnlyPendingProposalAttention(t *testing.T) {
	for _, decision := range []string{"approved", "edited", "rejected"} {
		t.Run(decision, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			proposal := model.AssistantTaskProposal{ID: entryID, OwnerUserID: ownerID, TaskID: taskID, BaseVersion: 1, Body: "Candidate", Rules: json.RawMessage(`{}`), Status: "pending"}
			d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
				return proposal, nil
			}
			input := DecisionInput{TaskID: taskID, ID: entryID, IfVersion: 7, Decision: decision, Note: "User reason"}
			if decision == "edited" {
				input.Body, input.Rules = ptr("Revised"), ptr(json.RawMessage(`[]`))
			}
			if decision != "rejected" {
				d.manual = func(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
					return model.AssistantTaskManual{Rules: json.RawMessage(`{}`)}, nil
				}
				d.insertManual = func(_ context.Context, manual model.AssistantTaskManual) error {
					body, rules := "Candidate", `{}`
					if decision == "edited" {
						body, rules = "Revised", `[]`
					}
					if manual.Version != 2 || manual.Source != "revision" || manual.Body != body || string(manual.Rules) != rules || manual.ProposalID == nil || *manual.ProposalID != entryID {
						t.Fatalf("wrong manual: %#v", manual)
					}
					return nil
				}
			}
			d.saveProposal = func(_ context.Context, value model.AssistantTaskProposal, previous string) (bool, error) {
				if previous != "pending" || value.Status != decision || value.DecisionNote != input.Note || value.DecidedAt == nil || *value.DecidedAt != epoch {
					t.Fatalf("wrong decision: %#v", value)
				}
				return true, nil
			}
			d.event = func(_ context.Context, owner, id, event string) (model.AssistantTaskEvent, error) {
				if owner != ownerID || id != taskID || event != entryID {
					t.Fatal("decision did not locate its exact pending event")
				}
				return model.AssistantTaskEvent{ID: entryID, Type: "proposal_pending", State: "delivered", Attention: true, SeenAt: ptr(epoch.Add(-time.Minute))}, nil
			}
			d.saveEvent = func(_ context.Context, event model.AssistantTaskEvent, previous string) (bool, error) {
				if previous != "delivered" || event.State != "delivered" || event.Attention || event.SeenAt == nil || *event.SeenAt != epoch.Add(-time.Minute) {
					t.Fatalf("decision changed delivery/seen state: %#v", event)
				}
				return true, nil
			}
			effects := expectSystemEffects(t, d, "", "proposal_decided", botID)
			saved := expectTaskWrite(t, d, task, false)
			result, err := New().Decide(context.Background(), d, userActor(), input)
			wantVersion := int64(2)
			if decision == "rejected" {
				wantVersion = 1
			}
			if err != nil || result.Status != decision || saved.ManualVersion != wantVersion || effects.event.Attention {
				t.Fatalf("decision: %#v %v", result, err)
			}
		})
	}
}

func TestManualRulesRefuseUnauthorizedStaleOrInvalidWork(t *testing.T) {
	for _, name := range []string{"bot-decision", "bot-rollback", "bot-edit", "proposal-base", "proposal-rules", "proposal-evidence", "already-decided", "decision-base", "reject-replacement", "deleted-appendix"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			m := New()
			var err error
			code := "forbidden"
			switch name {
			case "bot-decision":
				_, err = m.Decide(context.Background(), d, botActor(), DecisionInput{})
			case "bot-rollback":
				_, err = m.Rollback(context.Background(), d, botActor(), RollbackInput{})
			case "bot-edit":
				_, err = m.UpdateAppendix(context.Background(), d, botActor(), AppendixInput{})
			case "proposal-base", "proposal-rules", "proposal-evidence":
				input := ProposalInput{Mutation: mutation(), BaseVersion: 1, Body: "Body", Reason: "Reason"}
				d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
					return model.AssistantTaskProposal{}, model.ErrNotFound
				}
				code = "invalid_input"
				if name == "proposal-base" {
					input.BaseVersion, code = 2, "version_conflict"
				} else {
					d.manual = func(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
						return model.AssistantTaskManual{}, nil
					}
					if name == "proposal-rules" {
						input.Rules = json.RawMessage(`{"mayWrite":true}`)
					} else {
						input.EvidenceRecords = []string{"invalid"}
					}
				}
				_, err = m.Propose(context.Background(), d, botActor(), input)
			case "already-decided", "decision-base", "reject-replacement":
				proposal := model.AssistantTaskProposal{Status: "pending", BaseVersion: 2}
				input := DecisionInput{TaskID: taskID, ID: entryID, IfVersion: 7, Decision: "approved"}
				code = "version_conflict"
				if name == "already-decided" {
					proposal.Status, code = "rejected", "invalid_transition"
				}
				if name == "reject-replacement" {
					input.Decision, input.Body, code = "rejected", ptr("Replacement"), "invalid_input"
				}
				d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
					return proposal, nil
				}
				_, err = m.Decide(context.Background(), d, userActor(), input)
			case "deleted-appendix":
				d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
					return model.AssistantTaskAppendix{State: "deleted"}, nil
				}
				_, err = m.UpdateAppendix(context.Background(), d, userActor(), AppendixInput{Mutation: mutation(), State: "deleted"})
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal(err)
				}
				return
			}
			requireCode(t, err, code)
		})
	}
}

func TestRollbackCopiesHistoricalContentIntoNewVersion(t *testing.T) {
	task := baseTask()
	task.ManualVersion = 5
	d := baseDAO(t, task)
	old := model.AssistantTaskManual{OwnerUserID: ownerID, TaskID: taskID, Version: 2, Body: "Historical body", Rules: json.RawMessage(`{}`), Source: "revision", ProposalID: ptr(entryID), CreatedAt: epoch.Add(-time.Hour)}
	d.manual = func(_ context.Context, owner, id string, version int64) (model.AssistantTaskManual, error) {
		if owner != ownerID || id != taskID {
			t.Fatal("wrong rollback scope")
		}
		if version == 2 {
			return old, nil
		}
		if version != 5 {
			t.Fatal("wrong current version")
		}
		return model.AssistantTaskManual{Rules: json.RawMessage(`[]`)}, nil
	}
	d.insertManual = func(_ context.Context, manual model.AssistantTaskManual) error {
		if manual.Version != 6 || manual.Source != "rollback" || manual.ProposalID != nil || manual.Body != old.Body || string(manual.Rules) != string(old.Rules) || manual.CreatedAt != epoch {
			t.Fatalf("wrong rollback: %#v", manual)
		}
		return nil
	}
	saved := expectTaskWrite(t, d, task, false)
	result, err := New().Rollback(context.Background(), d, userActor(), RollbackInput{TaskID: taskID, IfVersion: 7, ManualVersion: 2})
	if err != nil || saved.ManualVersion != 6 || result.Version != 6 || old.Version != 2 || old.ProposalID == nil {
		t.Fatalf("rollback changed history: %#v %#v %v", result, old, err)
	}
}
