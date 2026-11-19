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
	// EventType keeps only events of that type and ExcludeEventType drops
	// events of that type. ExcludePausedTasks drops events whose task is
	// paused, evaluated against the task row in the same query.
	EventType, ExcludeEventType string
	ExcludePausedTasks          bool
	Limit                       int
	After                       *AssistantTaskPosition
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
	// DeleteTaskContent deletes task material and inbox receipts and turns the
	// task's enabled inbox into a tombstone in the caller's transaction.
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
	// RetargetPendingInbound moves the task's pending inbound events that target
	// another Bot to the given responsible Bot; other event types are unchanged.
	RetargetPendingInbound(context.Context, string, string, string) error
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
	AssistantTaskInboxDAO
}

// AssistantTaskInboxDAO stores task inboxes, their receipts, and the inbound
// event facts used by inbox admission. Every method except InboxIdentity is
// owner scoped. Lock order is the task row (Task with lock=true) before the
// inbox row, for management and inbound admission alike, so rotation or
// disabling interleaved with admission cannot deadlock.
type AssistantTaskInboxDAO interface {
	// InsertInbox returns false when the inbox ID exists or the task already has
	// an enabled inbox.
	InsertInbox(context.Context, model.AssistantTaskInbox) (bool, error)
	// CurrentInbox reads the task's enabled inbox without locking it.
	CurrentInbox(ctx context.Context, owner, task string) (model.AssistantTaskInbox, error)
	// InboxIdentity reads an inbox by ID without owner scope or lock for the
	// public route. It returns only identity, owner, task and state; tombstones
	// are returned with their state, and an ID that never existed is not found.
	InboxIdentity(ctx context.Context, inbox string) (model.AssistantTaskInbox, error)
	// LockInbox locks and reads the inbox row. The caller already holds the
	// task lock.
	LockInbox(ctx context.Context, owner, task, inbox string) (model.AssistantTaskInbox, error)
	// SaveInbox writes state, digests, overlap deadline, rotation time and
	// version when the stored version equals the expected version.
	SaveInbox(ctx context.Context, inbox model.AssistantTaskInbox, version int64) (bool, error)
	// AddInboxSuppressed increments the suppressed count of an enabled inbox.
	AddInboxSuppressed(ctx context.Context, owner, task, inbox string) (bool, error)
	// InboxReceipt reads a receipt whose expiry is after current database time.
	InboxReceipt(ctx context.Context, owner, inbox, key string) (model.AssistantTaskInboxReceipt, error)
	// InsertInboxReceipt inserts a receipt or replaces an expired receipt with
	// the same key. It returns false while an unexpired receipt holds the key.
	InsertInboxReceipt(context.Context, model.AssistantTaskInboxReceipt) (bool, error)
	// PendingInboundEvents counts, up to limit, pending inbound events of the
	// task targeted at bot.
	PendingInboundEvents(ctx context.Context, owner, task, bot string, limit int) (int, error)
	// ReceivedInbound reports whether bot was the target of an unsuppressed
	// receipt about the project Task subject at or after since, across the
	// owner's assistant tasks.
	ReceivedInbound(ctx context.Context, owner, bot, subject string, since time.Time) (bool, error)
	// ReclaimInboxReceipts deletes at most limit receipts of the task, from any
	// of its inboxes, that expired by current database time.
	ReclaimInboxReceipts(ctx context.Context, owner, task string, limit int) (int64, error)
	// ReclaimInboundEvents deletes at most limit delivered or expired inbound
	// events of the task that left pending, by delivery or expiry, before the
	// cutoff.
	ReclaimInboundEvents(ctx context.Context, owner, task string, before time.Time, limit int) (int64, error)
	// InboundReclaimTasks lists, in ascending ID order and up to limit, the
	// owner's undeleted assistant tasks that hold a receipt expired by current
	// database time or a delivered or expired inbound event settled before the
	// cutoff.
	InboundReclaimTasks(ctx context.Context, owner string, before time.Time, limit int) ([]string, error)
}
