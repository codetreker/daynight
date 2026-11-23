package assistanttask

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const (
	// InboxTokenPrefix makes leaked inbox tokens recognizable to secret scanners
	// and to people reading a configuration file.
	InboxTokenPrefix = "dnib_"
	// InboxTokenBytes is the random entropy carried by every inbox token.
	InboxTokenBytes = 32
	// InboxOverlap is how long the previous token stays valid after an overlap
	// rotation, giving external senders time to switch.
	InboxOverlap = 24 * time.Hour

	InboxRotateOverlap   = "overlap"
	InboxRotateImmediate = "immediate"
)

// Inbox management receipts share the claim operation receipt table, so one
// operation ID names at most one task operation of any kind.
const (
	inboxKindEnable          = "inbox_enable"
	inboxKindDisable         = "inbox_disable"
	inboxKindRotateOverlap   = "inbox_rotate_overlap"
	inboxKindRotateImmediate = "inbox_rotate_immediate"
)

var inboxTokenLength = len(InboxTokenPrefix) + base64.RawURLEncoding.EncodedLen(InboxTokenBytes)

// randomRead is replaced only by tests that prove entropy failures are returned.
var randomRead = rand.Read

func isInboxKind(kind string) bool {
	switch kind {
	case inboxKindEnable, inboxKindDisable, inboxKindRotateOverlap, inboxKindRotateImmediate:
		return true
	}
	return false
}

// InboxInput identifies one owner management request. Mode applies only to
// rotation.
type InboxInput struct {
	TaskID, OperationID, Mode string
	IfVersion                 int64
}

// InboxView is the readable inbox state. It never carries a token or digest.
// A task without an enabled inbox has a zero view with Enabled false.
type InboxView struct {
	InboxID                 string
	Enabled                 bool
	CreatedAt               *time.Time
	RotatedAt, OverlapUntil *time.Time
	SuppressedCount         int64
}

// InboxResult reports a management operation. Token is set only by the request
// that actually generated it; replays and receipt reads never return it.
type InboxResult struct {
	Operation model.AssistantTaskClaimOperation
	Inbox     InboxView
	Token     string
}

// NewInboxToken returns a fresh token and its digest.
func NewInboxToken() (string, string, error) {
	data := make([]byte, InboxTokenBytes)
	if _, err := randomRead(data); err != nil {
		return "", "", err
	}
	token := InboxTokenPrefix + base64.RawURLEncoding.EncodeToString(data)
	digest, err := InboxTokenDigest(token)
	return token, digest, err
}

// InboxTokenDigest validates the token form and returns its hex SHA-256 digest.
func InboxTokenDigest(token string) (string, error) {
	encoded, ok := strings.CutPrefix(token, InboxTokenPrefix)
	if !ok || len(token) != inboxTokenLength {
		return "", invalid("The inbox token form is invalid.")
	}
	data, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) != InboxTokenBytes || base64.RawURLEncoding.EncodeToString(data) != encoded {
		return "", invalid("The inbox token form is invalid.")
	}
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:]), nil
}

// VerifyInboxToken reports whether a well-formed token matches the enabled
// inbox's current token, or its overlap token before the overlap deadline.
// Both digests are always compared in constant time.
func VerifyInboxToken(inbox model.AssistantTaskInbox, token string, now time.Time) bool {
	digest, err := InboxTokenDigest(token)
	if err != nil || inbox.State != model.AssistantTaskInboxEnabled {
		return false
	}
	current := digestEqual(inbox.TokenDigest, digest)
	overlap := digestEqual(inbox.OverlapTokenDigest, digest)
	return current || overlap && overlapValid(inbox, now)
}

func digestEqual(saved *string, digest string) bool {
	if saved == nil {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(*saved), []byte(digest)) == 1
}

func overlapValid(inbox model.AssistantTaskInbox, now time.Time) bool {
	return inbox.OverlapTokenDigest != nil && inbox.OverlapUntil != nil && now.Before(*inbox.OverlapUntil)
}

func inboxView(inbox model.AssistantTaskInbox, now time.Time) InboxView {
	if inbox.State != model.AssistantTaskInboxEnabled {
		return InboxView{}
	}
	view := InboxView{InboxID: inbox.InboxID, Enabled: true, CreatedAt: ptr(inbox.CreatedAt), RotatedAt: inbox.RotatedAt, SuppressedCount: inbox.SuppressedCount}
	if overlapValid(inbox, now) {
		view.OverlapUntil = inbox.OverlapUntil
	}
	return view
}

func inboxFingerprint(actor Actor, kind string, input InboxInput) (string, error) {
	if !strictID(input.TaskID) || !strictID(input.OperationID) {
		return "", invalid("Task and operation IDs must be canonical nonzero UUIDs.")
	}
	if input.IfVersion < 1 {
		return "", invalid("A positive expected version is required.")
	}
	return fingerprint([]any{"daynight-assistant-inbox/1", kind, actor.Principal.UserID, input.TaskID, input.OperationID, strconv.FormatInt(input.IfVersion, 10)})
}

// currentInbox reads the enabled inbox after the caller locked the task row,
// then locks the inbox row, keeping the task-then-inbox lock order.
func currentInbox(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask) (model.AssistantTaskInbox, bool, error) {
	inbox, err := dao.CurrentInbox(ctx, task.OwnerUserID, task.ID)
	if errors.Is(err, model.ErrNotFound) {
		return inbox, false, nil
	}
	if err != nil {
		return inbox, false, err
	}
	inbox, err = dao.LockInbox(ctx, task.OwnerUserID, task.ID, inbox.InboxID)
	if err != nil {
		return inbox, false, err
	}
	return inbox, inbox.State == model.AssistantTaskInboxEnabled, nil
}

func (m *Module) EnableInbox(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input InboxInput) (InboxResult, error) {
	actor = actor.requiringBranches("EnableInbox", "default")
	return m.manageInbox(ctx, dao, actor, inboxKindEnable, input)
}

func (m *Module) DisableInbox(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input InboxInput) (InboxResult, error) {
	actor = actor.requiringBranches("DisableInbox", "default")
	return m.manageInbox(ctx, dao, actor, inboxKindDisable, input)
}

func (m *Module) RotateInbox(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input InboxInput) (InboxResult, error) {
	actor = actor.requiringBranches("RotateInbox", "default")
	switch input.Mode {
	case InboxRotateOverlap:
		return m.manageInbox(ctx, dao, actor, inboxKindRotateOverlap, input)
	case InboxRotateImmediate:
		return m.manageInbox(ctx, dao, actor, inboxKindRotateImmediate, input)
	}
	return InboxResult{}, invalid("Rotation mode must be overlap or immediate.")
}

// manageInbox applies one owner operation. A Bot identity is refused so an
// assistant cannot widen its own input channel while working.
func (m *Module) manageInbox(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, kind string, input InboxInput) (InboxResult, error) {
	var result InboxResult
	if actor.BotID != nil {
		return result, forbidden()
	}
	requestHash, err := inboxFingerprint(actor, kind, input)
	if err != nil {
		return result, err
	}
	task, err := loadTask(ctx, dao, actor, input.TaskID, true)
	if err != nil {
		return result, err
	}
	old, err := dao.ClaimOperation(ctx, task.OwnerUserID, task.ID, input.OperationID)
	if err == nil {
		if err = sameRequest(old.RequestFingerprint, requestHash); err != nil {
			return result, err
		}
		return m.inboxReceipt(ctx, dao, actor, task, old)
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if err = expectedVersion(task, input.IfVersion); err != nil {
		return result, err
	}
	inbox, enabled, err := currentInbox(ctx, dao, task)
	if err != nil {
		return result, err
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	if kind == inboxKindEnable && enabled {
		return result, fault("invalid_transition", "The assistant task inbox is already enabled.")
	}
	if kind != inboxKindEnable && !enabled {
		return result, fault("invalid_transition", "The assistant task inbox is not enabled.")
	}
	if kind == inboxKindRotateOverlap && overlapValid(inbox, now) {
		return result, fault("invalid_transition", "The previous inbox token is still in its overlap period; rotate immediately instead.")
	}
	if kind != inboxKindDisable {
		result.Token, err = m.issueInboxToken(ctx, dao, task, &inbox, kind, now)
	} else {
		err = disableInbox(ctx, dao, &inbox)
	}
	if err != nil {
		return result, err
	}
	task, err = saveTask(ctx, dao, task, store.AssistantTaskCondition{Version: task.Version}, now)
	if err != nil {
		return result, err
	}
	receipt := model.AssistantTaskClaimOperation{OwnerUserID: task.OwnerUserID, TaskID: task.ID, OperationID: input.OperationID, Kind: kind, RequestFingerprint: requestHash, AdmittedAt: now, ResultingVersion: task.Version, ResultingGeneration: task.ClaimGeneration, HolderBotID: task.HolderBotID, CredentialOperationID: task.CredentialOperationID, LeaseUntil: task.LeaseUntil}
	if err = dao.InsertClaimOperation(ctx, receipt); err != nil {
		return result, err
	}
	observed, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return InboxResult{}, err
	}
	result.Operation = receipt
	result.Inbox = inboxView(inbox, observed)
	return result, nil
}

// issueInboxToken creates the inbox on enable, or replaces the current token on
// rotation. An overlap rotation keeps the replaced digest for InboxOverlap; an
// immediate rotation drops every earlier digest.
func (m *Module) issueInboxToken(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, inbox *model.AssistantTaskInbox, kind string, now time.Time) (string, error) {
	token, digest, err := NewInboxToken()
	if err != nil {
		return "", err
	}
	if kind == inboxKindEnable {
		*inbox = model.AssistantTaskInbox{InboxID: uuid.NewString(), OwnerUserID: task.OwnerUserID, TaskID: task.ID, State: model.AssistantTaskInboxEnabled, TokenDigest: &digest, Version: 1, CreatedAt: now}
		ok, err := dao.InsertInbox(ctx, *inbox)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", conflict()
		}
		return token, nil
	}
	previous := inbox.Version
	next, err := advance(previous)
	if err != nil {
		return "", err
	}
	if kind == inboxKindRotateOverlap {
		inbox.OverlapTokenDigest, inbox.OverlapUntil = inbox.TokenDigest, ptr(now.Add(InboxOverlap))
	} else {
		inbox.OverlapTokenDigest, inbox.OverlapUntil = nil, nil
	}
	inbox.TokenDigest, inbox.RotatedAt, inbox.Version = &digest, ptr(now), next
	if err = saveInbox(ctx, dao, *inbox, previous); err != nil {
		return "", err
	}
	return token, nil
}

// disableInbox turns the inbox into a tombstone that keeps only its identity, so
// the old inbox ID can never be revived.
func disableInbox(ctx context.Context, dao store.AssistantTaskDAO, inbox *model.AssistantTaskInbox) error {
	previous := inbox.Version
	next, err := advance(previous)
	if err != nil {
		return err
	}
	inbox.State, inbox.Version = model.AssistantTaskInboxTombstone, next
	inbox.TokenDigest, inbox.OverlapTokenDigest, inbox.OverlapUntil = nil, nil, nil
	return saveInbox(ctx, dao, *inbox, previous)
}

func saveInbox(ctx context.Context, dao store.AssistantTaskDAO, inbox model.AssistantTaskInbox, previous int64) error {
	ok, err := dao.SaveInbox(ctx, inbox, previous)
	if err != nil {
		return err
	}
	if !ok {
		return conflict()
	}
	return nil
}

func (m *Module) inboxReceipt(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, task model.AssistantTask, op model.AssistantTaskClaimOperation) (InboxResult, error) {
	inbox, err := dao.CurrentInbox(ctx, task.OwnerUserID, task.ID)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return InboxResult{}, err
	}
	observed, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return InboxResult{}, err
	}
	return InboxResult{Operation: op, Inbox: inboxView(inbox, observed)}, nil
}

// InboxOperation reads the receipt of an inbox management operation, for a
// caller whose earlier request ended with an unknown outcome. It never returns
// the token generated by that operation.
func (m *Module) InboxOperation(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, operationID string) (InboxResult, error) {
	actor = actor.requiringBranches("InboxOperation", "default")
	if actor.BotID != nil {
		return InboxResult{}, forbidden()
	}
	if !strictID(operationID) {
		return InboxResult{}, invalid("Operation ID must be a canonical nonzero UUID.")
	}
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return InboxResult{}, err
	}
	op, err := dao.ClaimOperation(ctx, task.OwnerUserID, task.ID, operationID)
	if err != nil {
		return InboxResult{}, err
	}
	if !isInboxKind(op.Kind) {
		return InboxResult{}, model.ErrNotFound
	}
	return m.inboxReceipt(ctx, dao, actor, task, op)
}

// GetInbox reads the task's inbox state without its token or digests. Only
// management is owner-only; a verified Bot of the owner may read the state
// because the view carries no secret.
func (m *Module) GetInbox(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID string) (InboxView, error) {
	actor = actor.requiringBranches("GetInbox", "default")
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return InboxView{}, err
	}
	inbox, err := dao.CurrentInbox(ctx, task.OwnerUserID, task.ID)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return InboxView{}, err
	}
	observed, err := finish(ctx, dao, actor, nil)
	if err != nil {
		return InboxView{}, err
	}
	return inboxView(inbox, observed), nil
}
