// Package assistanttask assembles account-owned collaboration operations in one
// transaction, including Bot deletion barriers, receipts and associated records.
package assistanttask

import (
	"context"
	"errors"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask/watchdog"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Tasks struct {
	database   store.AssistantTaskWriter
	module     *core.Module
	operations operations
}

func New(database store.AssistantTaskWriter) *Tasks {
	module := core.New()
	// The fresh registry cannot reject this valid, unique application and validator.
	_ = module.RegisterRules("watchdog", watchdog.ValidateRules)
	return &Tasks{database: database, module: module, operations: module}
}

// WriteError retains the actual completion fact and original failure. A proposed
// callback result is never returned without confirmed transaction completion.
type WriteError struct {
	Operation string
	Outcome   store.TransactionOutcome
	Cause     error
}

func (e *WriteError) Error() string {
	return fmt.Sprintf("assistant task %s did not complete normally", e.Operation)
}
func (e *WriteError) Unwrap() error                                { return e.Cause }
func (e *WriteError) TransactionOutcome() store.TransactionOutcome { return e.Outcome }

func execute[T any](ctx context.Context, s *Tasks, operation string, action func(store.AssistantTaskDAO) (T, error)) (T, error) {
	var result T
	var callbackError error
	completion, err := s.database.WriteAssistantTask(ctx, func(scope store.AssistantTaskScope) error {
		result, callbackError = action(scope.AssistantTaskDAO())
		return callbackError
	})
	if callbackError != nil && !errors.Is(err, callbackError) {
		err = errors.Join(err, callbackError)
	}
	if err == nil && completion.Outcome == store.TransactionCommitted {
		return result, nil
	}
	var zero T
	if completion.Outcome == store.TransactionNotCommitted && err != nil {
		return zero, err
	}
	if err == nil {
		err = errors.New("transaction completion was not confirmed")
	}
	return zero, &WriteError{Operation: operation, Outcome: completion.Outcome, Cause: err}
}

func (s *Tasks) Create(ctx context.Context, actor core.Actor, input core.CreateInput) (core.TaskResult, error) {
	return execute(ctx, s, "Create", func(dao store.AssistantTaskDAO) (core.TaskResult, error) {
		return s.operations.Create(ctx, dao, actor, input)
	})
}

func (s *Tasks) Get(ctx context.Context, actor core.Actor, taskID string) (core.TaskResult, error) {
	return execute(ctx, s, "Get", func(dao store.AssistantTaskDAO) (core.TaskResult, error) {
		return s.operations.Get(ctx, dao, actor, taskID)
	})
}

func (s *Tasks) List(ctx context.Context, actor core.Actor, input core.PageInput) (model.AssistantTaskPage[core.TaskResult], error) {
	return execute(ctx, s, "List", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[core.TaskResult], error) {
		return s.operations.List(ctx, dao, actor, input)
	})
}

func (s *Tasks) Update(ctx context.Context, actor core.Actor, input core.UpdateInput) (core.TaskResult, error) {
	return execute(ctx, s, "Update", func(dao store.AssistantTaskDAO) (core.TaskResult, error) {
		return s.operations.Update(ctx, dao, actor, input)
	})
}

func (s *Tasks) Claim(ctx context.Context, actor core.Actor, input core.ClaimInput) (model.AssistantTaskClaimResult, error) {
	return execute(ctx, s, "Claim", func(dao store.AssistantTaskDAO) (model.AssistantTaskClaimResult, error) {
		return s.operations.Claim(ctx, dao, actor, input)
	})
}

func (s *Tasks) ClaimOperation(ctx context.Context, actor core.Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error) {
	return execute(ctx, s, "ClaimOperation", func(dao store.AssistantTaskDAO) (model.AssistantTaskClaimResult, error) {
		return s.operations.ClaimOperation(ctx, dao, actor, taskID, operationID)
	})
}

func (s *Tasks) GetManual(ctx context.Context, actor core.Actor, taskID string, version int64) (model.AssistantTaskManual, error) {
	return execute(ctx, s, "GetManual", func(dao store.AssistantTaskDAO) (model.AssistantTaskManual, error) {
		return s.operations.GetManual(ctx, dao, actor, taskID, version)
	})
}

func (s *Tasks) ListManuals(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error) {
	return execute(ctx, s, "ListManuals", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskManual], error) {
		return s.operations.ListManuals(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) ListAppendix(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error) {
	return execute(ctx, s, "ListAppendix", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskAppendix], error) {
		return s.operations.ListAppendix(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) AddAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error) {
	return execute(ctx, s, "AddAppendix", func(dao store.AssistantTaskDAO) (model.AssistantTaskAppendix, error) {
		return s.operations.AddAppendix(ctx, dao, actor, input)
	})
}

func (s *Tasks) UpdateAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error) {
	return execute(ctx, s, "UpdateAppendix", func(dao store.AssistantTaskDAO) (model.AssistantTaskAppendix, error) {
		return s.operations.UpdateAppendix(ctx, dao, actor, input)
	})
}

func (s *Tasks) ListProposals(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskProposal], error) {
	return execute(ctx, s, "ListProposals", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskProposal], error) {
		return s.operations.ListProposals(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) Propose(ctx context.Context, actor core.Actor, input core.ProposalInput) (core.ProposalResult, error) {
	return execute(ctx, s, "Propose", func(dao store.AssistantTaskDAO) (core.ProposalResult, error) {
		return s.operations.Propose(ctx, dao, actor, input)
	})
}

func (s *Tasks) Decide(ctx context.Context, actor core.Actor, input core.DecisionInput) (model.AssistantTaskProposal, error) {
	return execute(ctx, s, "Decide", func(dao store.AssistantTaskDAO) (model.AssistantTaskProposal, error) {
		return s.operations.Decide(ctx, dao, actor, input)
	})
}

func (s *Tasks) Rollback(ctx context.Context, actor core.Actor, input core.RollbackInput) (model.AssistantTaskManual, error) {
	return execute(ctx, s, "Rollback", func(dao store.AssistantTaskDAO) (model.AssistantTaskManual, error) {
		return s.operations.Rollback(ctx, dao, actor, input)
	})
}

func (s *Tasks) ListItems(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskItem], error) {
	return execute(ctx, s, "ListItems", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskItem], error) {
		return s.operations.ListItems(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) GetItem(ctx context.Context, actor core.Actor, taskID, id string) (model.AssistantTaskItem, error) {
	return execute(ctx, s, "GetItem", func(dao store.AssistantTaskDAO) (model.AssistantTaskItem, error) {
		return s.operations.GetItem(ctx, dao, actor, taskID, id)
	})
}

func (s *Tasks) SaveItem(ctx context.Context, actor core.Actor, input core.ItemInput) (model.AssistantTaskItem, error) {
	return execute(ctx, s, "SaveItem", func(dao store.AssistantTaskDAO) (model.AssistantTaskItem, error) {
		return s.operations.SaveItem(ctx, dao, actor, input)
	})
}

func (s *Tasks) ListRecords(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskRecord], error) {
	return execute(ctx, s, "ListRecords", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskRecord], error) {
		return s.operations.ListRecords(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) AddRecord(ctx context.Context, actor core.Actor, input core.RecordInput) (model.AssistantTaskRecord, error) {
	return execute(ctx, s, "AddRecord", func(dao store.AssistantTaskDAO) (model.AssistantTaskRecord, error) {
		return s.operations.AddRecord(ctx, dao, actor, input)
	})
}

func (s *Tasks) ListEvents(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskEvent], error) {
	return execute(ctx, s, "ListEvents", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskEvent], error) {
		return s.operations.ListEvents(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) AddEvent(ctx context.Context, actor core.Actor, input core.EventInput) (model.AssistantTaskEvent, error) {
	return execute(ctx, s, "AddEvent", func(dao store.AssistantTaskDAO) (model.AssistantTaskEvent, error) {
		return s.operations.AddEvent(ctx, dao, actor, input)
	})
}

func (s *Tasks) AckEvent(ctx context.Context, actor core.Actor, input core.AckEventInput) (model.AssistantTaskEvent, error) {
	return execute(ctx, s, "AckEvent", func(dao store.AssistantTaskDAO) (model.AssistantTaskEvent, error) {
		return s.operations.AckEvent(ctx, dao, actor, input)
	})
}

func (s *Tasks) ListInquiries(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskInquiry], error) {
	return execute(ctx, s, "ListInquiries", func(dao store.AssistantTaskDAO) (model.AssistantTaskPage[model.AssistantTaskInquiry], error) {
		return s.operations.ListInquiries(ctx, dao, actor, taskID, input)
	})
}

func (s *Tasks) Ask(ctx context.Context, actor core.Actor, input core.InquiryInput) (model.AssistantTaskInquiry, error) {
	return execute(ctx, s, "Ask", func(dao store.AssistantTaskDAO) (model.AssistantTaskInquiry, error) {
		return s.operations.Ask(ctx, dao, actor, input)
	})
}

func (s *Tasks) Answer(ctx context.Context, actor core.Actor, input core.AnswerInput) (model.AssistantTaskInquiry, error) {
	return execute(ctx, s, "Answer", func(dao store.AssistantTaskDAO) (model.AssistantTaskInquiry, error) {
		return s.operations.Answer(ctx, dao, actor, input)
	})
}

func (s *Tasks) ClearAttention(ctx context.Context, actor core.Actor, targetBotID string) error {
	_, err := execute(ctx, s, "ClearAttention", func(dao store.AssistantTaskDAO) (struct{}, error) {
		return struct{}{}, s.operations.ClearAttention(ctx, dao, actor, targetBotID)
	})
	return err
}

type operations interface {
	EnablePreset(context.Context, store.AssistantTaskDAO, core.Actor, core.CreateInput, string) (core.TaskResult, error)
	Create(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.CreateInput) (core.TaskResult, error)
	Get(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string) (core.TaskResult, error)
	List(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.PageInput) (model.AssistantTaskPage[core.TaskResult], error)
	Update(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.UpdateInput) (core.TaskResult, error)
	Claim(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ClaimInput) (model.AssistantTaskClaimResult, error)
	ClaimOperation(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error)
	GetManual(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, version int64) (model.AssistantTaskManual, error)
	ListManuals(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error)
	ListAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error)
	AddAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	UpdateAppendix(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	ListProposals(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskProposal], error)
	Propose(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ProposalInput) (core.ProposalResult, error)
	Decide(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.DecisionInput) (model.AssistantTaskProposal, error)
	Rollback(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.RollbackInput) (model.AssistantTaskManual, error)
	ListItems(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskItem], error)
	GetItem(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID, id string) (model.AssistantTaskItem, error)
	SaveItem(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.ItemInput) (model.AssistantTaskItem, error)
	ListRecords(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskRecord], error)
	AddRecord(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.RecordInput) (model.AssistantTaskRecord, error)
	ListEvents(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskEvent], error)
	AddEvent(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.EventInput) (model.AssistantTaskEvent, error)
	AckEvent(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AckEventInput) (model.AssistantTaskEvent, error)
	ListInquiries(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskInquiry], error)
	Ask(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.InquiryInput) (model.AssistantTaskInquiry, error)
	Answer(ctx context.Context, dao store.AssistantTaskDAO, actor core.Actor, input core.AnswerInput) (model.AssistantTaskInquiry, error)
	ClearAttention(context.Context, store.AssistantTaskDAO, core.Actor, string) error
}

// RegisterRules installs the application-owned validation boundary used by all
// manual, proposal, decision and rollback paths.
func (s *Tasks) RegisterRules(application string, validator core.RulesValidator) error {
	return s.module.RegisterRules(application, validator)
}

func (s *Tasks) EnableWatchdog(ctx context.Context, actor core.Actor, id, target string) (core.TaskResult, error) {
	return execute(ctx, s, "EnableWatchdog", func(dao store.AssistantTaskDAO) (core.TaskResult, error) {
		return s.operations.EnablePreset(ctx, dao, actor, watchdog.Preset(id), target)
	})
}
