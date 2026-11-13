package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AssistantTaskWriter interface {
	WriteAssistantTask(context.Context, func(AssistantTaskScope) error) (Completion, error)
}

type AssistantTaskScope interface{ AssistantTaskDAO() AssistantTaskDAO }

type AssistantTaskPosition struct {
	CreatedAt time.Time
	ID        string
}

// AssistantTaskQuery filters before ordering and limit+1 selection. Every DAO
// method is owner scoped; TaskID is optional for task and target-event lists,
// and for the bounded due-inquiry query used by event reads.
type AssistantTaskQuery struct {
	OwnerUserID, TaskID, State, ItemID, TargetBotID string
	InquiryBotID                                    string
	DeadlineBefore                                  *time.Time
	DeadlineAfter                                   *time.Time
	// IncludeExpiredOpen adds open inquiries due at this time to State matches.
	// It selects candidates only; core owns their timed_out transition.
	IncludeExpiredOpen *time.Time
	RulesEqual         json.RawMessage
	Limit              int
	After              *AssistantTaskPosition
}

// AssistantTaskCondition contains the actual write predicates chosen by core.
// A zero Version omits that predicate. CheckClaim compares all claim fields;
// LiveClaim additionally checks the stored lease against current database time.
type AssistantTaskCondition struct {
	Version                int64
	CheckClaim, LiveClaim  bool
	Generation             int64
	HolderBotID, TokenHash *string
}

// AssistantTaskDAO is bound to the caller's transaction. Credential takes the
// credential's existing shared protection; Bot holds a shared deletion barrier.
// Task(lock=true) locks the task before a fresh projection. Now uses current
// database time after waits, never the transaction-start timestamp. Core repeats
// credential/Bot/time admission after its last mutation before returning.
type AssistantTaskDAO interface {
	Credential(context.Context, model.Principal) error
	Bot(context.Context, string) (model.Bot, error)
	Now(context.Context) (time.Time, error)
	LockCreation(context.Context, string) error
	// A task owned by another account may return only ID and OwnerUserID so core
	// can distinguish forbidden from absent without loading private content.
	Task(context.Context, string, string, bool) (model.AssistantTask, error)
	ApplicationTask(context.Context, string, string) (model.AssistantTask, error)
	Tasks(context.Context, AssistantTaskQuery) ([]model.AssistantTask, error)
	InsertTask(context.Context, model.AssistantTask) (bool, error)
	SaveTask(context.Context, model.AssistantTask, AssistantTaskCondition) (bool, error)
	DeleteTaskContent(context.Context, string, string) error
	ClaimOperation(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error)
	InsertClaimOperation(context.Context, model.AssistantTaskClaimOperation) error
	Manual(context.Context, string, string, int64) (model.AssistantTaskManual, error)
	Manuals(context.Context, AssistantTaskQuery) ([]model.AssistantTaskManual, error)
	InsertManual(context.Context, model.AssistantTaskManual) error
	Appendix(context.Context, string, string, string) (model.AssistantTaskAppendix, error)
	Appendices(context.Context, AssistantTaskQuery) ([]model.AssistantTaskAppendix, error)
	InsertAppendix(context.Context, model.AssistantTaskAppendix) (bool, error)
	SaveAppendix(context.Context, model.AssistantTaskAppendix, int64) (bool, error)
	Proposal(context.Context, string, string, string) (model.AssistantTaskProposal, error)
	Proposals(context.Context, AssistantTaskQuery) ([]model.AssistantTaskProposal, error)
	InsertProposal(context.Context, model.AssistantTaskProposal) (bool, error)
	SaveProposal(context.Context, model.AssistantTaskProposal, string) (bool, error)
	Item(context.Context, string, string, string) (model.AssistantTaskItem, error)
	Items(context.Context, AssistantTaskQuery) ([]model.AssistantTaskItem, error)
	InsertItem(context.Context, model.AssistantTaskItem) (bool, error)
	SaveItem(context.Context, model.AssistantTaskItem, int64) (bool, error)
	TransferOpenItems(context.Context, string, string, *string) error
	Record(context.Context, string, string, string) (model.AssistantTaskRecord, error)
	Records(context.Context, AssistantTaskQuery) ([]model.AssistantTaskRecord, error)
	// InsertRecord obtains a real monotonically increasing database timestamp,
	// under the task's record-head barrier, and returns the persisted position.
	InsertRecord(context.Context, model.AssistantTaskRecord) (model.AssistantTaskRecord, error)
	Event(context.Context, string, string, string) (model.AssistantTaskEvent, error)
	Events(context.Context, AssistantTaskQuery) ([]model.AssistantTaskEvent, error)
	InsertEvent(context.Context, model.AssistantTaskEvent) (bool, error)
	SaveEvent(context.Context, model.AssistantTaskEvent, string) (bool, error)
	MarkAttentionSeen(context.Context, string, string, time.Time, []string) error
	Inquiry(context.Context, string, string, string) (model.AssistantTaskInquiry, error)
	Inquiries(context.Context, AssistantTaskQuery) ([]model.AssistantTaskInquiry, error)
	InsertInquiry(context.Context, model.AssistantTaskInquiry) (bool, error)
	SaveInquiry(context.Context, model.AssistantTaskInquiry, string) (bool, error)
}
