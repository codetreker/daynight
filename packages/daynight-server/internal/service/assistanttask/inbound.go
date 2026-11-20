package assistanttask

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/google/uuid"
)

// inboxDeliveryScan is the page size of the deliveries read for one
// verification. Verification pages through every candidate, because an owner
// may have any number of personal endpoints at this server's origin.
const inboxDeliveryScan = 100

// ReceiveInput is one inbox request after the protocol adapter extracted its
// parts. Token is nil when the request carried none. WebhookID and
// IdempotencyKey are the request headers; an external request may use either,
// and both must match when both are present.
type ReceiveInput struct {
	InboxID                   string
	Token                     *string
	MediaType                 string
	WebhookID, IdempotencyKey string
	Body                      []byte
}

// ReceiveResult reports an accepted, duplicate or suppressed request. EventID
// is nil only for a suppressed request.
type ReceiveResult struct {
	EventID               *string
	Classification        string
	Duplicate, Suppressed bool
}

// Inbox receives public inbox requests. Origin is this server's public origin;
// only a Daynight delivery whose target has this origin and the inbox path
// verifies as a Daynight event.
type Inbox struct {
	database store.AssistantTaskInboundWriter
	module   *core.Module
	origin   string
	newID    func() string
}

func NewInbox(database store.AssistantTaskInboundWriter, origin string) *Inbox {
	return &Inbox{database: database, module: core.New(), origin: origin, newID: uuid.NewString}
}

func inboxFault(code, message string) error { return &model.Fault{Code: code, Message: message} }

var (
	errInboxMissing      = inboxFault("not_found", "The assistant task inbox does not exist.")
	errInboxGone         = inboxFault("inbox_gone", "The assistant task inbox was disabled or its task deleted.")
	errInboxUnauthorized = inboxFault("unauthenticated", "A valid inbox token is required.")
	errInboxConflict     = inboxFault("operation_conflict", "The idempotency key was already used with a different body.")
	errInboxBacklog      = inboxFault("rate_limited", "The assistant task has too many pending inbound events.")
	errInboxUnavailable  = inboxFault("service_unavailable", "The assistant task has no responsible assistant.")
)

// Receive applies one request in a single transaction. An unknown commit
// returns a WriteError with TransactionUnknown; the sender retries with the
// same idempotency identity, which converges on the committed receipt.
func (s *Inbox) Receive(ctx context.Context, input ReceiveInput) (ReceiveResult, error) {
	var result ReceiveResult
	var callbackError error
	completion, err := s.database.WriteAssistantTaskInbound(ctx, func(scope store.AssistantTaskInboundScope) error {
		result, callbackError = s.receive(ctx, scope, input)
		return callbackError
	})
	if callbackError != nil && !errors.Is(err, callbackError) {
		err = errors.Join(err, callbackError)
	}
	if err == nil && completion.Outcome == store.TransactionCommitted {
		return result, nil
	}
	if completion.Outcome == store.TransactionNotCommitted && err != nil {
		return ReceiveResult{}, err
	}
	if err == nil {
		err = errors.New("transaction completion was not confirmed")
	}
	return ReceiveResult{}, &WriteError{Operation: "Receive", Outcome: completion.Outcome, Cause: err}
}

func (s *Inbox) receive(ctx context.Context, scope store.AssistantTaskInboundScope, input ReceiveInput) (ReceiveResult, error) {
	var result ReceiveResult
	if input.WebhookID != "" && input.IdempotencyKey != "" && input.WebhookID != input.IdempotencyKey {
		return result, inboxFault("invalid_input", "Webhook-Id and Idempotency-Key must match.")
	}
	var digest string
	if input.Token != nil {
		var err error
		if digest, err = core.InboxTokenDigest(*input.Token); err != nil {
			return result, err
		}
	}
	dao := scope.AssistantTaskDAO()
	inbox, task, admitted, err := s.lockInbox(ctx, dao, input.InboxID)
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if input.Token != nil && !core.VerifyInboxToken(inbox, *input.Token, now) {
		return result, errInboxUnauthorized
	}
	// The responsible Bot must be the one whose deletion barrier this
	// transaction holds; a holder change between the unlocked read and the
	// task lock is retryable like any other unavailable recipient.
	target, ok := core.ResponsibleBot(task, now)
	if !ok || target != admitted {
		return result, errInboxUnavailable
	}
	verified, err := s.verifyDaynight(ctx, scope, inbox, input)
	if err != nil {
		return result, err
	}
	in := core.InboundInput{InboxID: inbox.InboxID, Classification: core.InboundExternal, ReceivedAt: now, MediaType: input.MediaType, Body: input.Body}
	ttl := core.InboxExternalReceiptTTL
	var subject *string
	if verified != nil {
		in.Classification, in.IdempotencyKey, in.Actor = core.InboundDaynight, verified.eventID, verified.actor
		ttl, subject = core.InboxDaynightReceiptTTL, &verified.taskID
	} else {
		if digest == "" {
			return result, errInboxUnauthorized
		}
		in.IdempotencyKey = input.IdempotencyKey
		if in.IdempotencyKey == "" {
			in.IdempotencyKey = input.WebhookID
		}
		if in.IdempotencyKey != "" && !core.ValidInboundIdempotencyKey(in.IdempotencyKey) {
			return result, inboxFault("invalid_input", "The idempotency key must be 1-200 visible ASCII characters.")
		}
	}
	result.Classification = in.Classification
	sum := sha256.Sum256(input.Body)
	bodySHA := hex.EncodeToString(sum[:])
	if in.IdempotencyKey != "" {
		receipt, err := dao.InboxReceipt(ctx, task.OwnerUserID, inbox.InboxID, in.IdempotencyKey)
		if err == nil {
			if subtle.ConstantTimeCompare([]byte(receipt.BodySHA256), []byte(bodySHA)) != 1 {
				return ReceiveResult{}, errInboxConflict
			}
			result.EventID, result.Duplicate, result.Suppressed = receipt.EventID, true, receipt.Suppressed
			return result, nil
		}
		if !errors.Is(err, model.ErrNotFound) {
			return ReceiveResult{}, err
		}
	}
	if verified != nil {
		suppressed, err := core.SuppressInbound(ctx, dao, task.OwnerUserID, target, verified.taskID, in.Actor, verified.occurredAt)
		if err != nil {
			return ReceiveResult{}, err
		}
		if suppressed {
			receipt := model.AssistantTaskInboxReceipt{InboxID: inbox.InboxID, IdempotencyKey: in.IdempotencyKey, OwnerUserID: task.OwnerUserID, TaskID: task.ID, BodySHA256: bodySHA, Suppressed: true, TargetBotID: target, SubjectTaskID: subject, ReceivedAt: now, ExpiresAt: now.Add(ttl)}
			if err = suppressInbound(ctx, dao, receipt); err != nil {
				return ReceiveResult{}, err
			}
			if err = admissionHolds(ctx, dao, task); err != nil {
				return ReceiveResult{}, err
			}
			result.Suppressed = true
			return result, nil
		}
	}
	pending, err := dao.PendingInboundEvents(ctx, task.OwnerUserID, task.ID, target, core.InboundBacklogLimit)
	if err != nil {
		return ReceiveResult{}, err
	}
	if pending >= core.InboundBacklogLimit {
		return ReceiveResult{}, errInboxBacklog
	}
	event, err := s.module.AddInboundEvent(ctx, dao, task, s.newID(), target, in)
	if err != nil {
		return ReceiveResult{}, err
	}
	if in.IdempotencyKey != "" {
		receipt := model.AssistantTaskInboxReceipt{InboxID: inbox.InboxID, IdempotencyKey: in.IdempotencyKey, OwnerUserID: task.OwnerUserID, TaskID: task.ID, BodySHA256: bodySHA, EventID: &event.ID, TargetBotID: target, SubjectTaskID: subject, ReceivedAt: now, ExpiresAt: now.Add(ttl)}
		if err := insertReceipt(ctx, dao, receipt); err != nil {
			return ReceiveResult{}, err
		}
	}
	if err = core.ReclaimInbound(ctx, dao, task.OwnerUserID, task.ID, now); err != nil {
		return ReceiveResult{}, err
	}
	if err = admissionHolds(ctx, dao, task); err != nil {
		return ReceiveResult{}, err
	}
	result.EventID = &event.ID
	return result, nil
}

// admissionHolds rechecks, with fresh database time after the writes, the
// lease that admitted the responsible Bot. The task lock keeps the lease and
// the Bot deletion barrier keeps the Bot live, so only natural expiry remains;
// an expired admission rolls the reception back as retryable.
func admissionHolds(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask) error {
	now, err := dao.Now(ctx)
	if err != nil {
		return err
	}
	if task.LeaseUntil == nil || !now.Before(*task.LeaseUntil) {
		return errInboxUnavailable
	}
	return nil
}

// suppressInbound records a suppressed request: its receipt makes a retry
// return the same result, and the inbox counts it. No event is written, so
// the backlog limit does not apply.
func suppressInbound(ctx context.Context, dao store.AssistantTaskDAO, receipt model.AssistantTaskInboxReceipt) error {
	counted, err := dao.AddInboxSuppressed(ctx, receipt.OwnerUserID, receipt.TaskID, receipt.InboxID)
	if err != nil {
		return err
	}
	// The inbox row is locked and was enabled, so the count always applies.
	if !counted {
		return fmt.Errorf("assistant inbox left the enabled state under its lock")
	}
	if err = insertReceipt(ctx, dao, receipt); err != nil {
		return err
	}
	return core.ReclaimInbound(ctx, dao, receipt.OwnerUserID, receipt.TaskID, receipt.ReceivedAt)
}

func insertReceipt(ctx context.Context, dao store.AssistantTaskDAO, receipt model.AssistantTaskInboxReceipt) error {
	inserted, err := dao.InsertInboxReceipt(ctx, receipt)
	if err != nil {
		return err
	}
	// The task lock serializes receipts of one inbox, so an unexpired
	// receipt cannot appear after the idempotency read.
	if !inserted {
		return fmt.Errorf("assistant inbox receipt appeared under the task lock")
	}
	return nil
}

// lockInbox reads the inbox and its task without locks to find the task's
// holder Bot, takes that Bot's shared deletion barrier, then locks the task and
// the inbox. This keeps the Bot-before-task order of declared Bot writes and
// the task-then-inbox order of inbox management. It returns the Bot whose
// barrier is held and found live, or "" when the task had no holder or the
// holder is absent or deleted; the caller decides availability after its
// authentication checks.
func (s *Inbox) lockInbox(ctx context.Context, dao store.AssistantTaskDAO, id string) (model.AssistantTaskInbox, model.AssistantTask, string, error) {
	var inbox model.AssistantTaskInbox
	var task model.AssistantTask
	if parsed, err := uuid.Parse(id); err != nil || parsed.String() != id || parsed == uuid.Nil {
		return inbox, task, "", errInboxMissing
	}
	identity, err := dao.InboxIdentity(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return inbox, task, "", errInboxMissing
	}
	if err != nil {
		return inbox, task, "", err
	}
	if identity.State != model.AssistantTaskInboxEnabled {
		return inbox, task, "", errInboxGone
	}
	peek, err := liveTask(ctx, dao, identity, false)
	if err != nil {
		return inbox, task, "", err
	}
	admitted := ""
	if peek.HolderBotID != nil {
		err = botcore.RequireOwnedBot(ctx, dao, identity.OwnerUserID, *peek.HolderBotID)
		var fault *model.Fault
		switch {
		case err == nil:
			admitted = *peek.HolderBotID
		case !errors.As(err, &fault):
			return inbox, task, "", err
		}
	}
	if task, err = liveTask(ctx, dao, identity, true); err != nil {
		return inbox, task, "", err
	}
	inbox, err = dao.LockInbox(ctx, task.OwnerUserID, task.ID, id)
	if errors.Is(err, model.ErrNotFound) {
		return inbox, task, "", errInboxGone
	}
	if err != nil {
		return inbox, task, "", err
	}
	if inbox.State != model.AssistantTaskInboxEnabled {
		return inbox, task, "", errInboxGone
	}
	return inbox, task, admitted, nil
}

// liveTask reads the inbox's task, locked or not, and reports a missing,
// deleted or reassigned task as a gone inbox.
func liveTask(ctx context.Context, dao store.AssistantTaskDAO, identity model.AssistantTaskInbox, lock bool) (model.AssistantTask, error) {
	task, err := dao.Task(ctx, identity.OwnerUserID, identity.TaskID, lock)
	if errors.Is(err, model.ErrNotFound) {
		return model.AssistantTask{}, errInboxGone
	}
	if err != nil {
		return model.AssistantTask{}, err
	}
	if task.OwnerUserID != identity.OwnerUserID || task.State == "deleted" {
		return model.AssistantTask{}, errInboxGone
	}
	return task, nil
}

type verifiedEvent struct {
	eventID, taskID string
	occurredAt      time.Time
	actor           *core.InboundActor
}

// verifyDaynight returns the verified event, or nil when the request does not
// prove it is a Daynight delivery to this inbox. Storage failures abort the
// request instead of downgrading it to external.
func (s *Inbox) verifyDaynight(ctx context.Context, scope store.AssistantTaskInboundScope, inbox model.AssistantTaskInbox, input ReceiveInput) (*verifiedEvent, error) {
	essence, _, err := mime.ParseMediaType(input.MediaType)
	if err != nil || essence != protocol.MediaType || input.WebhookID == "" {
		return nil, nil
	}
	id, fact, err := protocol.Decode(input.Body)
	if err != nil || id != input.WebhookID {
		return nil, nil
	}
	sources := scope.WebhookInboundSources()
	provenance, err := sources.CapturedEventProvenance(ctx, id)
	if errors.Is(err, store.ErrWebhookCapturedEventMissing) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(input.Body)
	if provenance.FactRemovedAt != nil || !bytes.Equal(provenance.FactSHA256, sum[:]) {
		return nil, nil
	}
	targeted, err := inboxTargeted(ctx, sources, id, inbox, s.origin)
	if err != nil || !targeted {
		return nil, err
	}
	_, err = scope.ProjectAccessReader().ProjectAccess(ctx, model.Principal{UserID: inbox.OwnerUserID}, fact.ProjectID)
	if errors.Is(err, model.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &verifiedEvent{eventID: id, taskID: fact.TaskID, occurredAt: fact.OccurredAt, actor: inboundActor(provenance.Actor)}, nil
}

// inboxTargeted reports whether any of the owner's personal deliveries of the
// event targets this inbox, reading candidates page by page.
func inboxTargeted(ctx context.Context, sources store.WebhookInboundSourceReader, eventID string, inbox model.AssistantTaskInbox, origin string) (bool, error) {
	after := ""
	for {
		page, err := sources.PersonalDeliveryDestinations(ctx, eventID, inbox.OwnerUserID, origin, after, inboxDeliveryScan)
		if err != nil {
			return false, err
		}
		for _, destination := range page {
			if core.InboxTargetMatches(destination.Configuration, origin, inbox.InboxID) {
				return true, nil
			}
		}
		if len(page) < inboxDeliveryScan {
			return false, nil
		}
		after = page[len(page)-1].DeliveryID
	}
}

func inboundActor(actor wm.Actor) *core.InboundActor {
	if actor.Kind == wm.ActorUnknown {
		return nil
	}
	out := &core.InboundActor{Kind: string(actor.Kind)}
	if actor.UserID != "" {
		out.UserID = &actor.UserID
	}
	if actor.BotID != "" {
		out.BotID = &actor.BotID
	}
	return out
}
