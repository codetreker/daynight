package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Each probe supplies fixed DAO facts and one controlled failure. It records
// calls, not database state, and rejects duplicate or post-failure effects.
type failureProbe struct {
	t      *testing.T
	at     string
	refuse bool
	hit    bool
	calls  map[string]bool
}

func (p *failureProbe) call(stage string) error {
	p.t.Helper()
	if p.hit {
		p.t.Fatalf("continued with %s after %s failed", stage, p.at)
	}
	if p.calls[stage] {
		p.t.Fatalf("unexpected duplicate %s", stage)
	}
	p.calls[stage] = true
	if stage == p.at {
		p.hit = true
		return sentinel
	}
	return nil
}
func (p *failureProbe) write(stage string) (bool, error) {
	err := p.call(stage)
	if err != nil && p.refuse {
		return false, nil
	}
	return err == nil, err
}

func materialFailureFixture(t *testing.T, resource, stage string, refuse bool) (func() error, *failureProbe) {
	t.Helper()
	ctx, task, m := context.Background(), baseTask(), New()
	task.Application = "controlled"
	d := baseDAO(t, task)
	p := &failureProbe{t: t, at: stage, refuse: refuse, calls: map[string]bool{}}
	if err := m.RegisterRules("controlled", func(json.RawMessage, json.RawMessage) (bool, error) { return false, p.call("validator") }); err != nil {
		t.Fatal(err)
	}
	d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
		return p.write("save-task")
	}
	d.insertRecord = func(_ context.Context, v model.AssistantTaskRecord) (model.AssistantTaskRecord, error) {
		return v, p.call("insert-record")
	}
	d.insertEvent = func(context.Context, model.AssistantTaskEvent) (bool, error) { return p.write("insert-event") }
	d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
		return model.AssistantTaskRecord{ID: operationID}, p.call("evidence")
	}
	switch resource {
	case "append":
		d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskAppendix{}, err
			}
			return model.AssistantTaskAppendix{}, model.ErrNotFound
		}
		d.insertAppendix = func(context.Context, model.AssistantTaskAppendix) (bool, error) { return p.write("insert") }
		return func() error {
			_, err := m.AddAppendix(ctx, d, botActor(), AppendixInput{Mutation: mutation(), Text: "Evidence", SourceRecords: []string{operationID}})
			return err
		}, p
	case "edit-appendix":
		d.appendix = func(context.Context, string, string, string) (model.AssistantTaskAppendix, error) {
			return model.AssistantTaskAppendix{ID: entryID, Version: 1, State: "active"}, p.call("read")
		}
		d.saveAppendix = func(context.Context, model.AssistantTaskAppendix, int64) (bool, error) { return p.write("save") }
		return func() error {
			_, err := m.UpdateAppendix(ctx, d, userActor(), AppendixInput{Mutation: mutation(), Text: "Replacement", State: "edited", SourceRecords: []string{operationID}})
			return err
		}, p
	case "propose":
		d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskProposal{}, err
			}
			return model.AssistantTaskProposal{}, model.ErrNotFound
		}
		d.manual = func(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
			return model.AssistantTaskManual{Rules: json.RawMessage(`{}`)}, p.call("manual")
		}
		d.insertProposal = func(context.Context, model.AssistantTaskProposal) (bool, error) { return p.write("insert") }
		d.proposals = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskProposal, error) {
			return nil, p.call("matches")
		}
		return func() error {
			_, err := m.Propose(ctx, d, botActor(), ProposalInput{Mutation: mutation(), BaseVersion: 1, Body: "Body", Reason: "Reason", EvidenceRecords: []string{operationID}})
			return err
		}, p
	case "decide":
		d.proposal = func(context.Context, string, string, string) (model.AssistantTaskProposal, error) {
			return model.AssistantTaskProposal{ID: entryID, Status: "pending", BaseVersion: 1, Body: "Body", Rules: json.RawMessage(`{}`)}, p.call("read")
		}
		d.manual = func(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
			return model.AssistantTaskManual{Rules: json.RawMessage(`{}`)}, p.call("manual")
		}
		d.insertManual = func(context.Context, model.AssistantTaskManual) error { return p.call("insert-manual") }
		d.saveProposal = func(context.Context, model.AssistantTaskProposal, string) (bool, error) { return p.write("save") }
		d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
			return model.AssistantTaskEvent{ID: entryID, State: "pending", Attention: true}, p.call("pending-event")
		}
		d.saveEvent = func(context.Context, model.AssistantTaskEvent, string) (bool, error) { return p.write("save-event") }
		return func() error {
			_, err := m.Decide(ctx, d, userActor(), DecisionInput{TaskID: taskID, ID: entryID, IfVersion: 7, Decision: "approved"})
			return err
		}, p
	case "rollback":
		d.manual = func(_ context.Context, owner, id string, v int64) (model.AssistantTaskManual, error) {
			label := "historical"
			if v == 1 {
				label = "current"
			}
			return model.AssistantTaskManual{OwnerUserID: owner, TaskID: id, Version: v, Body: "Previous instructions", Rules: json.RawMessage(`{}`)}, p.call(label)
		}
		d.insertManual = func(context.Context, model.AssistantTaskManual) error { return p.call("insert-manual") }
		return func() error {
			_, err := m.Rollback(ctx, d, userActor(), RollbackInput{TaskID: taskID, IfVersion: 7, ManualVersion: 2})
			return err
		}, p
	case "item-create", "item-update":
		d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskItem{}, err
			}
			if resource == "item-create" {
				return model.AssistantTaskItem{}, model.ErrNotFound
			}
			return model.AssistantTaskItem{ID: entryID, Key: "build-1", Episode: 1, Version: 3}, nil
		}
		d.insertItem = func(context.Context, model.AssistantTaskItem) (bool, error) { return p.write("insert") }
		d.saveItem = func(context.Context, model.AssistantTaskItem, int64) (bool, error) { return p.write("save") }
		return func() error {
			input := itemInput()
			if resource == "item-update" {
				input.ItemVersion = ptr(int64(3))
			}
			_, err := m.SaveItem(ctx, d, botActor(), input)
			return err
		}, p
	case "record":
		d.record = func(context.Context, string, string, string) (model.AssistantTaskRecord, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskRecord{}, err
			}
			return model.AssistantTaskRecord{}, model.ErrNotFound
		}
		d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
			return model.AssistantTaskItem{}, p.call("item")
		}
		return func() error {
			_, err := m.AddRecord(ctx, d, botActor(), RecordInput{Mutation: mutation(), ItemID: ptr(operationID), Kind: "fact", Text: "Observed fact"})
			return err
		}, p
	case "event":
		d.event = func(context.Context, string, string, string) (model.AssistantTaskEvent, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskEvent{}, err
			}
			return model.AssistantTaskEvent{}, model.ErrNotFound
		}
		return func() error {
			_, err := m.AddEvent(ctx, d, botActor(), EventInput{Mutation: mutation(), TargetBotID: botID, Type: "report"})
			return err
		}, p
	case "ask":
		d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
			return model.AssistantTaskItem{State: "open", FollowerBotID: ptr(botID)}, p.call("item")
		}
		d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
			if err := p.call("read"); err != nil {
				return model.AssistantTaskInquiry{}, err
			}
			return model.AssistantTaskInquiry{}, model.ErrNotFound
		}
		d.insertInquiry = func(context.Context, model.AssistantTaskInquiry) (bool, error) { return p.write("insert") }
		return func() error {
			_, err := m.Ask(ctx, d, botActor(), InquiryInput{Mutation: mutation(), ItemID: ptr(operationID), Question: "Question"})
			return err
		}, p
	case "answer":
		d.inquiry = func(context.Context, string, string, string) (model.AssistantTaskInquiry, error) {
			return model.AssistantTaskInquiry{ID: entryID, State: "open", Deadline: epoch.Add(time.Minute), FromBotID: targetID}, p.call("read")
		}
		d.saveInquiry = func(context.Context, model.AssistantTaskInquiry, string) (bool, error) { return p.write("save") }
		return func() error {
			_, err := m.Answer(ctx, d, botActor(), AnswerInput{Mutation: mutation(), Answer: "Observed answer"})
			return err
		}, p
	default:
		t.Fatalf("unsupported fixture %s", resource)
		return nil, p
	}
}

func TestMaterialStorageFailuresPreserveCauseAndStopSubsequentEffects(t *testing.T) {
	for _, tc := range []struct {
		resource string
		stages   []string
	}{
		{"append", []string{"read", "evidence", "insert", "insert-record", "insert-event", "save-task"}},
		{"edit-appendix", []string{"read", "evidence", "save", "save-task"}},
		{"propose", []string{"read", "manual", "validator", "evidence", "insert", "insert-event", "matches", "save-task"}},
		{"decide", []string{"read", "manual", "validator", "insert-manual", "save", "pending-event", "save-event", "insert-event", "save-task"}},
		{"rollback", []string{"historical", "current", "validator", "insert-manual", "save-task"}},
		{"item-create", []string{"read", "insert", "save-task"}}, {"item-update", []string{"read", "save", "save-task"}},
		{"record", []string{"item", "read", "insert-record", "save-task"}},
		{"event", []string{"read", "insert-event", "save-task"}},
		{"ask", []string{"item", "read", "insert", "insert-record", "insert-event", "save-task"}},
		{"answer", []string{"read", "save", "insert-record", "insert-event", "save-task"}},
	} {
		for _, stage := range tc.stages {
			t.Run(tc.resource+"/"+stage, func(t *testing.T) {
				invoke, p := materialFailureFixture(t, tc.resource, stage, false)
				err := invoke()
				if !p.hit || !errors.Is(err, sentinel) {
					t.Fatalf("lost failure at %s: %v", stage, err)
				}
			})
		}
	}
}

func TestMaterialConditionalRefusalsDoNotContinueWrites(t *testing.T) {
	for _, tc := range []struct{ resource, stage, code string }{
		{"append", "insert", "operation_conflict"}, {"append", "insert-event", "operation_conflict"}, {"append", "save-task", "claim_lost"},
		{"edit-appendix", "save", "version_conflict"}, {"edit-appendix", "save-task", "version_conflict"},
		{"propose", "insert", "operation_conflict"}, {"decide", "save", "version_conflict"}, {"decide", "save-event", "version_conflict"},
		{"item-create", "insert", "operation_conflict"}, {"item-update", "save", "version_conflict"}, {"event", "insert-event", "operation_conflict"},
		{"ask", "insert", "operation_conflict"}, {"answer", "save", "version_conflict"},
	} {
		t.Run(tc.resource+"/"+tc.stage, func(t *testing.T) {
			invoke, p := materialFailureFixture(t, tc.resource, tc.stage, true)
			err := invoke()
			requireCode(t, err, tc.code)
			if !p.hit {
				t.Fatal("conditional refusal not reached")
			}
		})
	}
}

func TestReadFailuresSuppressPartiallyLoadedResources(t *testing.T) {
	for _, resource := range []string{"task", "manual", "item", "claim-operation", "records", "events"} {
		for _, stage := range []string{"task-read", "resource-read", "final-auth"} {
			if resource == "task" && stage == "resource-read" {
				continue
			}
			t.Run(resource+"/"+stage, func(t *testing.T) {
				d := baseDAO(t, baseTask())
				calls := 0
				if stage == "task-read" {
					d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
						return model.AssistantTask{}, sentinel
					}
				}
				if stage == "final-auth" {
					d.credential = func(context.Context, model.Principal) error {
						calls++
						limit := 2
						if resource == "claim-operation" {
							limit = 3
						}
						if resource == "events" {
							limit = 4
						}
						if calls == limit {
							return sentinel
						}
						return nil
					}
				}
				resourceError := func() error {
					if stage == "resource-read" {
						return sentinel
					}
					return nil
				}
				var err error
				switch resource {
				case "task":
					_, err = New().Get(context.Background(), d, userActor(), taskID)
				case "manual":
					d.manual = func(context.Context, string, string, int64) (model.AssistantTaskManual, error) {
						return model.AssistantTaskManual{}, resourceError()
					}
					_, err = New().GetManual(context.Background(), d, userActor(), taskID, 1)
				case "item":
					d.item = func(context.Context, string, string, string) (model.AssistantTaskItem, error) {
						return model.AssistantTaskItem{}, resourceError()
					}
					_, err = New().GetItem(context.Background(), d, userActor(), taskID, entryID)
				case "claim-operation":
					d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
						return model.AssistantTaskClaimOperation{}, resourceError()
					}
					_, err = New().ClaimOperation(context.Background(), d, userActor(), taskID, entryID)
				case "records":
					d.records = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskRecord, error) {
						return nil, resourceError()
					}
					_, err = New().ListRecords(context.Background(), d, userActor(), taskID, PageInput{})
				case "events":
					d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
					d.events = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
						return nil, resourceError()
					}
					_, err = New().ListEvents(context.Background(), d, userActor(), taskID, PageInput{})
				}
				if !errors.Is(err, sentinel) {
					t.Fatalf("lost %s %s cause: %v", resource, stage, err)
				}
			})
		}
	}
}

func TestBotAdmissionPreservesLookupFailuresAndRejectsMissingBot(t *testing.T) {
	for _, name := range []string{"invalid-id", "missing", "lookup-error", "oauth", "no-principal"} {
		t.Run(name, func(t *testing.T) {
			d := baseDAO(t, baseTask())
			actor := botActor()
			code := "forbidden"
			switch name {
			case "invalid-id":
				actor.BotID, code = ptr("bad"), "invalid_input"
			case "missing":
				d.bot = func(context.Context, string) (model.Bot, error) { return model.Bot{}, model.ErrNotFound }
			case "lookup-error":
				d.bot = func(context.Context, string) (model.Bot, error) { return model.Bot{}, sentinel }
			case "oauth":
				actor.Principal.Kind = model.OAuthCredential
			case "no-principal":
				actor.Principal = model.Principal{}
				code = "unauthenticated"
			}
			_, err := New().Get(context.Background(), d, actor, taskID)
			if name == "lookup-error" {
				if !errors.Is(err, sentinel) {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, code)
			}
		})
	}
}

func TestInternalRecordAndEventSerializationFailureDoesNotWrite(t *testing.T) {
	m, d := New(), &daoStub{}
	if _, err := m.systemRecord(context.Background(), d, baseTask(), "note", "Text", nil, make(chan int), epoch); err == nil {
		t.Fatal("unsupported record references accepted")
	}
	if _, err := m.systemEvent(context.Background(), d, baseTask(), botID, "report", make(chan int), epoch); err == nil {
		t.Fatal("unsupported event payload accepted")
	}
	_, err := m.systemEvent(context.Background(), d, baseTask(), botID, "invalid", nil, epoch)
	requireCode(t, err, "invalid_input")
}
