package assistanttask

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const LeaseDuration = 5 * time.Minute

func fault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func invalid(message string) error     { return fault("invalid_input", message) }
func forbidden() error {
	return fault("forbidden", "The assistant task operation is not permitted for this identity.")
}
func lost() error     { return fault("claim_lost", "The assistant task claim is no longer valid.") }
func conflict() error { return fault("version_conflict", "The assistant task resource changed.") }
func strictID(id string) bool {
	parsed, err := model.CanonicalID(id)
	return err == nil && parsed == id && parsed != uuid.Nil.String()
}
func textValid(value string, required bool) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && (!required || strings.TrimSpace(value) != "")
}
func ptr[T any](v T) *T { return &v }

func authorize(ctx context.Context, dao store.AssistantTaskDAO, actor Actor) error {
	if err := model.RequirePrincipal(actor.Principal); err != nil {
		return err
	}
	if actor.Principal.Kind == model.OAuthCredential {
		return forbidden()
	}
	if err := dao.Credential(ctx, actor.Principal); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return model.Unauthenticated(err)
		}
		return err
	}
	if actor.BotID != nil {
		return botOwner(ctx, dao, actor.Principal.UserID, *actor.BotID)
	}
	return nil
}
func botOwner(ctx context.Context, dao store.AssistantTaskDAO, owner, id string) error {
	if !strictID(id) {
		return invalid("Bot ID must be a canonical nonzero UUID.")
	}
	bot, err := dao.Bot(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return forbidden()
	}
	if err != nil {
		return err
	}
	if bot.OwnerUserID != owner || bot.Deletion != nil {
		return forbidden()
	}
	return nil
}
func finish(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, until *time.Time, extraBots ...string) (time.Time, error) {
	if err := authorize(ctx, dao, actor); err != nil {
		return time.Time{}, err
	}
	for _, id := range extraBots {
		if err := botOwner(ctx, dao, actor.Principal.UserID, id); err != nil {
			return time.Time{}, err
		}
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return now, err
	}
	if until != nil && !now.Before(*until) {
		return now, lost()
	}
	return now, nil
}
func loadTask(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, id string, lock bool) (model.AssistantTask, error) {
	if !strictID(id) {
		return model.AssistantTask{}, invalid("Task ID must be a canonical nonzero UUID.")
	}
	if err := authorize(ctx, dao, actor); err != nil {
		return model.AssistantTask{}, err
	}
	task, err := dao.Task(ctx, actor.Principal.UserID, id, lock)
	if err != nil {
		return task, err
	}
	if task.OwnerUserID != actor.Principal.UserID {
		return task, forbidden()
	}
	if task.State == "deleted" {
		return task, fault("task_deleted", "The assistant task was deleted.")
	}
	return task, nil
}
func claimView(task model.AssistantTask, now time.Time) model.AssistantTaskClaim {
	state := "unowned"
	if task.HolderBotID != nil {
		switch {
		case task.HolderDeleted || task.LeaseUntil == nil || !now.Before(*task.LeaseUntil):
			state = "expired"
		case task.ClaimTokenHash == nil:
			state = "pending"
		default:
			state = "active"
		}
	}
	return model.AssistantTaskClaim{HolderBotID: task.HolderBotID, CredentialOperationID: task.CredentialOperationID, Generation: task.ClaimGeneration, State: state, ClaimedAt: task.ClaimedAt, RenewedAt: task.RenewedAt, LeaseUntil: task.LeaseUntil, ObservedAt: now}
}
func taskResult(task model.AssistantTask) TaskResult {
	return TaskResult{Task: task, Claim: claimView(task, task.ObservedAt)}
}
func expectedVersion(task model.AssistantTask, version int64) error {
	if version < 1 {
		return invalid("A positive expected version is required.")
	}
	if task.Version != version {
		return conflict()
	}
	return nil
}
func advance(value int64) (int64, error) {
	if value < 0 || value == math.MaxInt64 {
		return 0, invalid("The resource version cannot be advanced.")
	}
	return value + 1, nil
}
func fence(task model.AssistantTask, live bool) store.AssistantTaskCondition {
	return store.AssistantTaskCondition{Version: task.Version, CheckClaim: true, LiveClaim: live, Generation: task.ClaimGeneration, HolderBotID: task.HolderBotID, TokenHash: task.ClaimTokenHash}
}
func saveTask(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, condition store.AssistantTaskCondition, now time.Time) (model.AssistantTask, error) {
	version, err := advance(task.Version)
	if err != nil {
		return task, err
	}
	task.Version = version
	task.UpdatedAt = now
	task.ObservedAt = now
	ok, err := dao.SaveTask(ctx, task, condition)
	if err != nil {
		return task, err
	}
	if !ok {
		if condition.LiveClaim {
			return task, lost()
		}
		return task, conflict()
	}
	return task, nil
}
func protected(task model.AssistantTask, actor Actor, generation int64, token string, now time.Time, allowPaused bool) error {
	hash, err := tokenDigest(token)
	if err != nil {
		return err
	}
	if actor.BotID == nil || task.HolderBotID == nil || *actor.BotID != *task.HolderBotID || task.ClaimGeneration != generation || task.ClaimTokenHash == nil || *task.ClaimTokenHash != hash || claimView(task, now).State != "active" {
		return lost()
	}
	if task.State == "paused" && !allowPaused {
		return fault("task_paused", "The assistant task is paused.")
	}
	return nil
}
func canonicalJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage("null"), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, invalid("The JSON value is invalid.")
	}
	if !json.Valid(raw) {
		return nil, invalid("The JSON value is invalid.")
	}
	encoded, err := json.Marshal(value)
	return encoded, err
}
func fingerprint(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
func sameRequest(saved, proposed string) error {
	if saved != proposed {
		return fault("operation_conflict", "The resource ID belongs to a different request.")
	}
	return nil
}
func recordIDs(ctx context.Context, dao store.AssistantTaskDAO, task model.AssistantTask, ids []string) error {
	for _, id := range ids {
		if !strictID(id) {
			return invalid("Record IDs must be canonical UUIDs.")
		}
		if _, err := dao.Record(ctx, task.OwnerUserID, task.ID, id); err != nil {
			return err
		}
	}
	return nil
}

func (m *Module) RegisterRules(application string, validator RulesValidator) error {
	if application == "" || !textValid(application, true) || validator == nil {
		return invalid("An application name and validator are required.")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.validators[application]; ok {
		return invalid("The application validator is already registered.")
	}
	m.validators[application] = validator
	return nil
}
func (m *Module) rules(application string, oldRules, newRules json.RawMessage) (json.RawMessage, bool, error) {
	normalized, err := canonicalJSON(newRules)
	if err != nil {
		return nil, false, err
	}
	m.mu.RLock()
	validate := m.validators[application]
	m.mu.RUnlock()
	if validate != nil {
		widens, err := validate(oldRules, normalized)
		return normalized, widens, err
	}
	if string(normalized) != "null" && string(normalized) != "[]" && string(normalized) != "{}" {
		return nil, false, invalid("Unregistered applications only accept empty rules.")
	}
	return normalized, false, nil
}
