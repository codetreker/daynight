package assistanttask

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask/watchdog"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type transactionMock struct {
	run func(context.Context, func(store.AssistantTaskScope) error) (store.Completion, error)
}

func (m transactionMock) WriteAssistantTask(ctx context.Context, call func(store.AssistantTaskScope) error) (store.Completion, error) {
	return m.run(ctx, call)
}

type scopeMock struct{ dao store.AssistantTaskDAO }

func (s scopeMock) AssistantTaskDAO() store.AssistantTaskDAO { return s.dao }

type daoMock struct{ store.AssistantTaskDAO }

func TestExecutionSeparatesCandidateAndCompletion(t *testing.T) {
	cause := errors.New("controlled failure")
	for _, test := range []struct {
		name    string
		outcome store.TransactionOutcome
		err     error
		success bool
	}{
		{"committed", store.TransactionCommitted, nil, true},
		{"unknown", store.TransactionUnknown, cause, false},
		{"unknown without cause", store.TransactionUnknown, nil, false},
		{"not committed", store.TransactionNotCommitted, cause, false},
		{"not committed without cause", store.TransactionNotCommitted, nil, false},
		{"committed cleanup failed", store.TransactionCommitted, cause, false},
		{"missing completion", "", nil, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			dao := &daoMock{}
			ctx := context.WithValue(context.Background(), struct{}{}, "scope")
			task := New(transactionMock{run: func(actual context.Context, callback func(store.AssistantTaskScope) error) (store.Completion, error) {
				calls++
				if actual != ctx {
					t.Fatal("transaction context changed")
				}
				if err := callback(scopeMock{dao}); err != nil {
					t.Fatal(err)
				}
				return store.Completion{Outcome: test.outcome}, test.err
			}})
			result, err := execute(ctx, task, "Claim", func(actual store.AssistantTaskDAO) (string, error) {
				if actual != dao {
					t.Fatal("transaction DAO changed")
				}
				return "candidate", nil
			})
			if calls != 1 || (err == nil) != test.success {
				t.Fatalf("calls=%d result=%q err=%v", calls, result, err)
			}
			if test.success {
				if result != "candidate" {
					t.Fatal(result)
				}
			} else if result != "" {
				t.Fatal("unconfirmed result leaked")
			}
			if test.err != nil && !errors.Is(err, test.err) {
				t.Fatal("original failure lost")
			}
			if test.outcome == store.TransactionUnknown {
				var failure *WriteError
				if !errors.As(err, &failure) || failure.TransactionOutcome() != store.TransactionUnknown || failure.Error() == "" {
					t.Fatalf("unknown not retained: %v", err)
				}
			}
		})
	}
}

func TestExecutionPreservesCallbackRefusalAndDoesNotReplay(t *testing.T) {
	refusal := &model.Fault{Code: "claim_lost", Message: "claim lost"}
	calls := 0
	task := New(transactionMock{run: func(ctx context.Context, callback func(store.AssistantTaskScope) error) (store.Completion, error) {
		calls++
		err := callback(scopeMock{&daoMock{}})
		if err != refusal {
			t.Fatalf("callback=%v", err)
		}
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}})
	result, err := execute(context.Background(), task, "Claim", func(store.AssistantTaskDAO) (int, error) { return 42, refusal })
	if calls != 1 || result != 0 || err != refusal {
		t.Fatalf("result=%d calls=%d err=%v", result, calls, err)
	}
}

func TestTasksForwardOnlyTransactionBoundOperations(t *testing.T) {
	actor := core.Actor{Principal: model.Principal{UserID: "owner", CredentialID: "credential", Kind: model.PATCredential}}
	ctx := context.WithValue(context.Background(), struct{}{}, "request")
	dao := &daoMock{}
	tests := []struct {
		name string
		args []any
		run  func(*Tasks) error
	}{
		{"EnablePreset", []any{watchdog.Preset("created"), "bot"}, func(s *Tasks) error { _, err := s.EnableWatchdog(ctx, actor, "created", "bot"); return err }},
		{"Create", []any{core.CreateInput{ID: "created", Name: "name", Body: "manual"}}, func(s *Tasks) error {
			_, err := s.Create(ctx, actor, core.CreateInput{ID: "created", Name: "name", Body: "manual"})
			return err
		}},
		{"Get", []any{"task"}, func(s *Tasks) error { _, err := s.Get(ctx, actor, "task"); return err }},
		{"List", []any{core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.List(ctx, actor, core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"Update", []any{core.UpdateInput{TaskID: "task", IfVersion: 9007199254740993}}, func(s *Tasks) error {
			_, err := s.Update(ctx, actor, core.UpdateInput{TaskID: "task", IfVersion: 9007199254740993})
			return err
		}},
		{"Claim", []any{core.ClaimInput{TaskID: "task", OperationID: "operation", Kind: "bind", ClaimToken: "token", ExpectedGeneration: 7}}, func(s *Tasks) error {
			_, err := s.Claim(ctx, actor, core.ClaimInput{TaskID: "task", OperationID: "operation", Kind: "bind", ClaimToken: "token", ExpectedGeneration: 7})
			return err
		}},
		{"ClaimOperation", []any{"task", "resource"}, func(s *Tasks) error { _, err := s.ClaimOperation(ctx, actor, "task", "resource"); return err }},
		{"GetManual", []any{"task", int64(3)}, func(s *Tasks) error { _, err := s.GetManual(ctx, actor, "task", int64(3)); return err }},
		{"ListManuals", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListManuals(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"ListAppendix", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListAppendix(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"AddAppendix", []any{core.AppendixInput{Mutation: core.Mutation{TaskID: "task", ID: "appendix", ClaimToken: "token", ClaimGeneration: 7}, Text: "appendix"}}, func(s *Tasks) error {
			_, err := s.AddAppendix(ctx, actor, core.AppendixInput{Mutation: core.Mutation{TaskID: "task", ID: "appendix", ClaimToken: "token", ClaimGeneration: 7}, Text: "appendix"})
			return err
		}},
		{"UpdateAppendix", []any{core.AppendixInput{Mutation: core.Mutation{TaskID: "task", ID: "appendix", ClaimToken: "token", ClaimGeneration: 7}, Text: "appendix"}}, func(s *Tasks) error {
			_, err := s.UpdateAppendix(ctx, actor, core.AppendixInput{Mutation: core.Mutation{TaskID: "task", ID: "appendix", ClaimToken: "token", ClaimGeneration: 7}, Text: "appendix"})
			return err
		}},
		{"ListProposals", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListProposals(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"Propose", []any{core.ProposalInput{Mutation: core.Mutation{TaskID: "task", ID: "proposal"}, Body: "proposal", BaseVersion: 3}}, func(s *Tasks) error {
			_, err := s.Propose(ctx, actor, core.ProposalInput{Mutation: core.Mutation{TaskID: "task", ID: "proposal"}, Body: "proposal", BaseVersion: 3})
			return err
		}},
		{"Decide", []any{core.DecisionInput{TaskID: "task", ID: "proposal", IfVersion: 7, Decision: "approved", Note: "reason"}}, func(s *Tasks) error {
			_, err := s.Decide(ctx, actor, core.DecisionInput{TaskID: "task", ID: "proposal", IfVersion: 7, Decision: "approved", Note: "reason"})
			return err
		}},
		{"Rollback", []any{core.RollbackInput{TaskID: "task", IfVersion: 7, ManualVersion: 3}}, func(s *Tasks) error {
			_, err := s.Rollback(ctx, actor, core.RollbackInput{TaskID: "task", IfVersion: 7, ManualVersion: 3})
			return err
		}},
		{"ListItems", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListItems(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"GetItem", []any{"task", "resource"}, func(s *Tasks) error { _, err := s.GetItem(ctx, actor, "task", "resource"); return err }},
		{"SaveItem", []any{core.ItemInput{Mutation: core.Mutation{TaskID: "task", ID: "item"}, Key: "key", Episode: 2}}, func(s *Tasks) error {
			_, err := s.SaveItem(ctx, actor, core.ItemInput{Mutation: core.Mutation{TaskID: "task", ID: "item"}, Key: "key", Episode: 2})
			return err
		}},
		{"ListRecords", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListRecords(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"AddRecord", []any{core.RecordInput{Mutation: core.Mutation{TaskID: "task", ID: "record"}, Kind: "fact", Text: "fact"}}, func(s *Tasks) error {
			_, err := s.AddRecord(ctx, actor, core.RecordInput{Mutation: core.Mutation{TaskID: "task", ID: "record"}, Kind: "fact", Text: "fact"})
			return err
		}},
		{"ListEvents", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListEvents(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"AddEvent", []any{core.EventInput{Mutation: core.Mutation{TaskID: "task", ID: "event"}, TargetBotID: "bot", Type: "trigger"}}, func(s *Tasks) error {
			_, err := s.AddEvent(ctx, actor, core.EventInput{Mutation: core.Mutation{TaskID: "task", ID: "event"}, TargetBotID: "bot", Type: "trigger"})
			return err
		}},
		{"AckEvent", []any{core.AckEventInput{TaskID: "task", ID: "event", OperationID: "operation"}}, func(s *Tasks) error {
			_, err := s.AckEvent(ctx, actor, core.AckEventInput{TaskID: "task", ID: "event", OperationID: "operation"})
			return err
		}},
		{"ListInquiries", []any{"task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"}}, func(s *Tasks) error {
			_, err := s.ListInquiries(ctx, actor, "task", core.PageInput{Limit: 200, Cursor: "cursor", State: "active", ItemID: "item", TargetBotID: "bot"})
			return err
		}},
		{"Ask", []any{core.InquiryInput{Mutation: core.Mutation{TaskID: "task", ID: "inquiry"}, Question: "question"}}, func(s *Tasks) error {
			_, err := s.Ask(ctx, actor, core.InquiryInput{Mutation: core.Mutation{TaskID: "task", ID: "inquiry"}, Question: "question"})
			return err
		}},
		{"Answer", []any{core.AnswerInput{Mutation: core.Mutation{TaskID: "task", ID: "inquiry"}, Answer: "answer"}}, func(s *Tasks) error {
			_, err := s.Answer(ctx, actor, core.AnswerInput{Mutation: core.Mutation{TaskID: "task", ID: "inquiry"}, Answer: "answer"})
			return err
		}},
		{"ClearAttention", []any{"bot"}, func(s *Tasks) error { return s.ClearAttention(ctx, actor, "bot") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			transactionCalls := 0
			s := New(transactionMock{run: func(actual context.Context, callback func(store.AssistantTaskScope) error) (store.Completion, error) {
				transactionCalls++
				if actual != ctx {
					t.Fatal("context changed")
				}
				err := callback(scopeMock{dao})
				return store.Completion{Outcome: store.TransactionCommitted}, err
			}})
			s.operations = &operationMock{call: func(actual context.Context, actualDAO store.AssistantTaskDAO, actualActor core.Actor, name string, args ...any) (any, error) {
				calls++
				if actual != ctx || actualDAO != dao || !reflect.DeepEqual(actor, actualActor) || name != test.name || !reflect.DeepEqual(args, test.args) {
					t.Fatalf("lower call changed: %s %+v", name, args)
				}
				return nil, nil
			}}
			if err := test.run(s); err != nil || calls != 1 || transactionCalls != 1 {
				t.Fatalf("calls=%d tx=%d err=%v", calls, transactionCalls, err)
			}
		})
	}
}
func TestConstructorBindsModuleAndRulesRegistry(t *testing.T) {
	s := New(transactionMock{})
	if s.module == nil || s.operations != s.module {
		t.Fatal("module not assembled")
	}
	if err := s.RegisterRules("test", func(old, new json.RawMessage) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
}

func TestCompletionCannotHideEarlierOperationFailure(t *testing.T) {
	refusal := errors.New("operation refused")
	s := New(transactionMock{run: func(ctx context.Context, callback func(store.AssistantTaskScope) error) (store.Completion, error) {
		_ = callback(scopeMock{&daoMock{}})
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}})
	result, err := execute(context.Background(), s, "test", func(store.AssistantTaskDAO) (int, error) { return 42, refusal })
	var failure *WriteError
	if result != 0 || !errors.Is(err, refusal) || !errors.As(err, &failure) || failure.Outcome != store.TransactionCommitted {
		t.Fatalf("result=%d err=%v", result, err)
	}
}
