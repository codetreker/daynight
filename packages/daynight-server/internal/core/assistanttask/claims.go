package assistanttask

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func tokenDigest(token string) (string, error) {
	data, err := base64.RawURLEncoding.Strict().DecodeString(token)
	if err != nil || len(data) != 32 || base64.RawURLEncoding.EncodeToString(data) != token {
		return "", invalid("Claim token must encode exactly 32 bytes as unpadded base64url.")
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

// ClaimFingerprint implements the fixed ten-element claim fingerprint v1.
func ClaimFingerprint(actor Actor, input ClaimInput) (string, string, error) {
	if !strictID(actor.Principal.UserID) || !strictID(input.TaskID) || !strictID(input.OperationID) || input.ExpectedGeneration < 0 {
		return "", "", invalid("Claim identities and generation are invalid.")
	}
	if actor.BotID != nil && !strictID(*actor.BotID) {
		return "", "", invalid("Bot ID is invalid.")
	}
	var version any
	if input.IfVersion != nil {
		if *input.IfVersion < 1 {
			return "", "", invalid("Expected version must be positive.")
		}
		version = strconv.FormatInt(*input.IfVersion, 10)
	}
	var actorID, target, hashValue any
	if actor.BotID != nil {
		actorID = *actor.BotID
	}
	if input.TargetBotID != nil {
		target = *input.TargetBotID
	}
	hash := ""
	if actor.BotID != nil {
		var err error
		hash, err = tokenDigest(input.ClaimToken)
		if err != nil {
			return "", "", err
		}
		hashValue = hash
	} else if input.ClaimToken != "" {
		return "", "", invalid("User operations cannot include a Bot credential.")
	}
	switch input.Kind {
	case "claim":
		if actor.BotID == nil || input.IfVersion == nil || target != nil {
			return "", "", invalid("Claim requires a Bot and expected version.")
		}
	case "transfer":
		if input.IfVersion == nil || input.TargetBotID == nil || !strictID(*input.TargetBotID) {
			return "", "", invalid("Transfer requires a target Bot and expected version.")
		}
	case "bind", "renew":
		if actor.BotID == nil || input.IfVersion != nil || target != nil || input.ExpectedGeneration == 0 {
			return "", "", invalid("Binding and renewal require a current Bot generation.")
		}
	case "release":
		if target != nil || (actor.BotID == nil && input.IfVersion == nil) || (actor.BotID != nil && input.IfVersion != nil) {
			return "", "", invalid("Release conditions do not match the caller.")
		}
	default:
		return "", "", invalid("Unknown claim operation.")
	}
	value := []any{"daynight-assistant-claim/1", input.Kind, actor.Principal.UserID, input.TaskID, input.OperationID, actorID, target, version, strconv.FormatInt(input.ExpectedGeneration, 10), hashValue}
	digest, err := fingerprint(value)
	return digest, hash, err
}

func (m *Module) Claim(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, input ClaimInput) (model.AssistantTaskClaimResult, error) {
	var result model.AssistantTaskClaimResult
	requestHash, tokenHash, err := ClaimFingerprint(actor, input)
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
		_, err := finish(ctx, dao, actor, nil)
		if err != nil {
			return result, err
		}
		return model.AssistantTaskClaimResult{Operation: old, CurrentClaim: claimView(task, task.ObservedAt)}, nil
	}
	if !errors.Is(err, model.ErrNotFound) {
		return result, err
	}
	if input.Kind == "transfer" {
		if err = botOwner(ctx, dao, actor.Principal.UserID, *input.TargetBotID); err != nil {
			return result, err
		}
	}
	now, err := dao.Now(ctx)
	if err != nil {
		return result, err
	}
	condition := fence(task, false)
	var until = task.LeaseUntil
	previousLease := task.LeaseUntil
	live := false
	if input.Kind == "claim" {
		state := claimView(task, now).State
		if state == "active" || state == "pending" {
			return result, &model.AssistantTaskClaimError{Fault: &model.Fault{Code: "claim_held", Message: "A valid assistant task claim is held."}, Claim: claimView(task, now)}
		}
	}
	if input.IfVersion != nil {
		if err = expectedVersion(task, *input.IfVersion); err != nil {
			return result, err
		}
	}
	if task.ClaimGeneration != input.ExpectedGeneration {
		return result, lost()
	}
	switch input.Kind {
	case "claim":
		task.ClaimGeneration, err = advance(task.ClaimGeneration)
		task.HolderBotID = actor.BotID
		task.ClaimTokenHash = ptr(tokenHash)
		task.CredentialOperationID = ptr(input.OperationID)
		task.ClaimedAt = ptr(now)
		task.RenewedAt = ptr(now)
		task.LeaseUntil = ptr(now.Add(LeaseDuration))
		task.HolderDeleted = false
		until = nil
	case "transfer":
		if task.HolderBotID != nil && *task.HolderBotID == *input.TargetBotID {
			return result, invalid("Transfer target is already responsible.")
		}
		if actor.BotID != nil {
			if err = protected(task, actor, input.ExpectedGeneration, input.ClaimToken, now, true); err != nil {
				return result, err
			}
			live = true
		} else {
			until = nil
		}
		task.ClaimGeneration, err = advance(task.ClaimGeneration)
		task.HolderBotID = input.TargetBotID
		task.ClaimTokenHash = nil
		task.CredentialOperationID = nil
		task.ClaimedAt = ptr(now)
		task.RenewedAt = nil
		task.LeaseUntil = ptr(now.Add(LeaseDuration))
		task.HolderDeleted = false
	case "bind":
		if task.HolderBotID == nil || *task.HolderBotID != *actor.BotID || claimView(task, now).State != "pending" {
			return result, lost()
		}
		live = true
		task.ClaimTokenHash = ptr(tokenHash)
		task.CredentialOperationID = ptr(input.OperationID)
	case "renew", "release":
		if actor.BotID != nil {
			if err = protected(task, actor, input.ExpectedGeneration, input.ClaimToken, now, true); err != nil {
				return result, err
			}
			live = true
		} else {
			until = nil
		}
		if input.Kind == "renew" {
			task.RenewedAt = ptr(now)
			next := now.Add(LeaseDuration)
			if task.LeaseUntil != nil && task.LeaseUntil.After(next) {
				next = *task.LeaseUntil
			}
			task.LeaseUntil = &next
		} else {
			if task.HolderBotID == nil {
				return result, fault("invalid_transition", "The assistant task is already unowned.")
			}
			task.ClaimGeneration, err = advance(task.ClaimGeneration)
			task.HolderBotID = nil
			task.ClaimTokenHash = nil
			task.CredentialOperationID = nil
			task.ClaimedAt = nil
			task.RenewedAt = nil
			task.LeaseUntil = nil
			task.HolderDeleted = false
		}
	}
	if err != nil {
		return result, err
	}
	condition.LiveClaim = live
	task, err = saveTask(ctx, dao, task, condition, now)
	if err != nil {
		return result, err
	}
	if input.Kind == "claim" || input.Kind == "transfer" {
		if err = dao.TransferOpenItems(ctx, task.OwnerUserID, task.ID, task.HolderBotID); err != nil {
			return result, err
		}
	}
	if input.Kind == "transfer" || input.Kind == "claim" && condition.HolderBotID != nil {
		typeName := "transfer"
		if input.Kind == "claim" {
			typeName = "takeover"
		}
		if _, err = m.systemEvent(ctx, dao, task, *task.HolderBotID, typeName, map[string]any{"generation": strconv.FormatInt(task.ClaimGeneration, 10), "previousLeaseUntil": previousLease}, now); err != nil {
			return result, err
		}
		if condition.HolderBotID != nil && *condition.HolderBotID != *task.HolderBotID {
			if _, err = m.systemEvent(ctx, dao, task, *condition.HolderBotID, "claim_lost", map[string]any{"reason": typeName, "generation": strconv.FormatInt(task.ClaimGeneration, 10), "holderBotId": task.HolderBotID}, now); err != nil {
				return result, err
			}
		}
	}
	receipt := model.AssistantTaskClaimOperation{OwnerUserID: task.OwnerUserID, TaskID: task.ID, OperationID: input.OperationID, Kind: input.Kind, ActorBotID: actor.BotID, RequestFingerprint: requestHash, AdmittedAt: now, ResultingVersion: task.Version, ResultingGeneration: task.ClaimGeneration, HolderBotID: task.HolderBotID, CredentialOperationID: task.CredentialOperationID, LeaseUntil: task.LeaseUntil}
	if err = dao.InsertClaimOperation(ctx, receipt); err != nil {
		return result, err
	}
	var extra []string
	if input.TargetBotID != nil {
		extra = []string{*input.TargetBotID}
	}
	observed, err := finish(ctx, dao, actor, until, extra...)
	if err != nil {
		return result, err
	}
	return model.AssistantTaskClaimResult{Operation: receipt, CurrentClaim: claimView(task, observed)}, nil
}

func (m *Module) ClaimOperation(ctx context.Context, dao store.AssistantTaskDAO, actor Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error) {
	var result model.AssistantTaskClaimResult
	if !strictID(operationID) {
		return result, invalid("Operation ID must be a canonical nonzero UUID.")
	}
	task, err := loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return result, err
	}
	op, err := dao.ClaimOperation(ctx, task.OwnerUserID, task.ID, operationID)
	if err != nil {
		return result, err
	}
	task, err = loadTask(ctx, dao, actor, taskID, false)
	if err != nil {
		return result, err
	}
	if _, err = finish(ctx, dao, actor, nil); err != nil {
		return result, err
	}
	return model.AssistantTaskClaimResult{Operation: op, CurrentClaim: claimView(task, task.ObservedAt)}, nil
}
