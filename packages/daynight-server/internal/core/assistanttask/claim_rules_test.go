package assistanttask

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestClaimTransitionsPreserveCredentialAndOwnershipFences(t *testing.T) {
	for _, name := range []string{"claim", "takeover", "transfer-user", "transfer-bot", "bind", "renew", "renew-paused", "release-user", "release-bot"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			actor := botActor()
			input := ClaimInput{TaskID: taskID, OperationID: entryID, Kind: name, ExpectedGeneration: 2, ClaimToken: token}
			wantGeneration := int64(2)
			wantHolder := botID
			wantEvents := 0
			wantTransfer := false
			switch name {
			case "claim":
				task.ClaimGeneration = 0
				task.HolderBotID = nil
				task.ClaimTokenHash = nil
				task.CredentialOperationID = nil
				task.LeaseUntil = nil
				input.ExpectedGeneration = 0
				input.IfVersion = ptr(int64(7))
				wantGeneration = 1
				wantTransfer = true
			case "takeover":
				input.Kind = "claim"
				actor.BotID = ptr(targetID)
				input.IfVersion = ptr(int64(7))
				task.LeaseUntil = ptr(epoch.Add(-time.Minute))
				wantGeneration = 3
				wantHolder = targetID
				wantEvents = 2
				wantTransfer = true
			case "transfer-user":
				actor = userActor()
				input.ClaimToken = ""
				fallthrough
			case "transfer-bot":
				input.Kind = "transfer"
				input.IfVersion = ptr(int64(7))
				input.TargetBotID = ptr(targetID)
				wantHolder = targetID
				wantGeneration = 3
				wantEvents = 2
				wantTransfer = true
			case "bind":
				task.ClaimTokenHash = nil
				task.CredentialOperationID = nil
			case "renew-paused":
				input.Kind = "renew"
				task.State = "paused"
			case "release-user":
				actor = userActor()
				input.ClaimToken = ""
				input.IfVersion = ptr(int64(7))
				fallthrough
			case "release-bot":
				input.Kind = "release"
				wantHolder = ""
				wantGeneration = 3
			}
			d := baseDAO(t, task)
			var saved model.AssistantTask
			var condition store.AssistantTaskCondition
			var receipt model.AssistantTaskClaimOperation
			var events []model.AssistantTaskEvent
			transfers := 0
			d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
				return model.AssistantTaskClaimOperation{}, model.ErrNotFound
			}
			d.saveTask = func(_ context.Context, v model.AssistantTask, c store.AssistantTaskCondition) (bool, error) {
				saved = v
				condition = c
				return true, nil
			}
			d.insertClaimOperation = func(_ context.Context, v model.AssistantTaskClaimOperation) error { receipt = v; return nil }
			if wantTransfer {
				d.transferOpenItems = func(_ context.Context, owner, id string, holder *string) error {
					transfers++
					if owner != ownerID || id != taskID || holder == nil || *holder != wantHolder {
						t.Fatal("wrong item transfer")
					}
					return nil
				}
			}
			if wantEvents > 0 {
				d.insertEvent = func(_ context.Context, v model.AssistantTaskEvent) (bool, error) {
					events = append(events, v)
					return true, nil
				}
			}
			result, err := New().Claim(context.Background(), d, actor, input)
			if err != nil {
				t.Fatal(err)
			}
			if saved.Version != 8 || saved.ClaimGeneration != wantGeneration || condition.Version != 7 || condition.Generation != task.ClaimGeneration || !condition.CheckClaim {
				t.Fatalf("wrong state or fence %#v %#v", saved, condition)
			}
			if wantHolder == "" {
				if saved.HolderBotID != nil || saved.ClaimTokenHash != nil || saved.LeaseUntil != nil {
					t.Fatal("release retained active credential")
				}
			} else if saved.HolderBotID == nil || *saved.HolderBotID != wantHolder {
				t.Fatal("wrong holder")
			}
			if name == "renew" || name == "renew-paused" {
				if *saved.ClaimTokenHash != *task.ClaimTokenHash || *saved.CredentialOperationID != *task.CredentialOperationID || *saved.ClaimedAt != *task.ClaimedAt || *saved.LeaseUntil != epoch.Add(5*time.Minute) {
					t.Fatal("renewal rotated credentials or wrong lease")
				}
			}
			if input.Kind == "transfer" {
				if saved.ClaimTokenHash != nil || saved.CredentialOperationID != nil || saved.RenewedAt != nil || result.CurrentClaim.State != "pending" {
					t.Fatal("transfer did not create pending claim")
				}
			}
			if input.Kind == "bind" {
				if *saved.LeaseUntil != *task.LeaseUntil || *saved.CredentialOperationID != entryID {
					t.Fatal("bind changed lease or wrong credential identity")
				}
			}
			if result.Operation.OperationID != entryID || receipt.ResultingGeneration != wantGeneration || receipt.AdmittedAt != epoch {
				t.Fatal("wrong receipt")
			}
			if len(events) != wantEvents {
				t.Fatalf("got %d events", len(events))
			}
			if wantTransfer && transfers != 1 {
				t.Fatal("items not transferred once")
			}
			if name == "takeover" {
				var payload map[string]any
				if err = json.Unmarshal(events[0].Payload, &payload); err != nil {
					t.Fatal(err)
				}
				if payload["previousLeaseUntil"] != task.LeaseUntil.Format(time.RFC3339) {
					t.Fatal("takeover lost previous lease")
				}
				if events[1].Type != "claim_lost" || events[1].TargetBotID != botID || !events[1].Attention {
					t.Fatal("old holder not notified")
				}
			}
		})
	}
}

func TestClaimHeldPrecedesStaleCandidateAndRefusesWithoutWrite(t *testing.T) {
	task := baseTask()
	d := baseDAO(t, task)
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{}, model.ErrNotFound
	}
	actor := botActor()
	actor.BotID = ptr(targetID)
	_, err := New().Claim(context.Background(), d, actor, ClaimInput{Kind: "claim", TaskID: taskID, OperationID: entryID, IfVersion: ptr(int64(1)), ExpectedGeneration: 0, ClaimToken: token})
	requireCode(t, err, "claim_held")
	var detail *model.AssistantTaskClaimError
	if !errors.As(err, &detail) || *detail.Claim.HolderBotID != botID || detail.Claim.Generation != 2 {
		t.Fatal("missing responsible Bot")
	}
}

func TestClaimFinalAdmissionUsesOriginalLease(t *testing.T) {
	task := baseTask()
	task.LeaseUntil = ptr(epoch.Add(time.Second))
	d := baseDAO(t, task)
	calls := 0
	d.now = func(context.Context) (time.Time, error) {
		calls++
		if calls == 1 {
			return epoch, nil
		}
		return epoch.Add(time.Second), nil
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{}, model.ErrNotFound
	}
	d.saveTask = func(_ context.Context, v model.AssistantTask, c store.AssistantTaskCondition) (bool, error) {
		if !c.LiveClaim || v.LeaseUntil.Equal(*task.LeaseUntil) {
			t.Fatal("wrong renewal proposal")
		}
		return true, nil
	}
	receiptProposed := false
	d.insertClaimOperation = func(context.Context, model.AssistantTaskClaimOperation) error { receiptProposed = true; return nil }
	result, err := New().Claim(context.Background(), d, botActor(), ClaimInput{TaskID: taskID, OperationID: entryID, Kind: "renew", ExpectedGeneration: 2, ClaimToken: token})
	requireCode(t, err, "claim_lost")
	if !receiptProposed || result.Operation.OperationID != "" {
		t.Fatal("a proposed receipt must not become a success result")
	}
}

func TestClaimReplayDoesNotRenewOrUseLaterObservation(t *testing.T) {
	task := baseTask()
	task.HolderBotID = ptr(targetID)
	task.ObservedAt = epoch.Add(-time.Minute)
	d := baseDAO(t, task)
	input := ClaimInput{Kind: "claim", TaskID: taskID, OperationID: entryID, IfVersion: ptr(int64(1)), ExpectedGeneration: 0, ClaimToken: token}
	hash, _, err := ClaimFingerprint(botActor(), input)
	if err != nil {
		t.Fatal(err)
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{OperationID: entryID, RequestFingerprint: hash, ResultingGeneration: 1}, nil
	}
	result, err := New().Claim(context.Background(), d, botActor(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result.CurrentClaim.ObservedAt != task.ObservedAt || result.CurrentClaim.Generation != 2 || *result.CurrentClaim.HolderBotID != targetID {
		t.Fatal("receipt confused with current claim")
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		return model.AssistantTaskClaimOperation{RequestFingerprint: "different"}, nil
	}
	_, err = New().Claim(context.Background(), d, botActor(), input)
	requireCode(t, err, "operation_conflict")
}

func TestClaimOperationReadRefreshesClaimAfterReceipt(t *testing.T) {
	first := baseTask()
	second := first
	second.ClaimGeneration = 3
	second.HolderBotID = ptr(targetID)
	second.ObservedAt = epoch.Add(time.Second)
	d := baseDAO(t, first)
	reads := 0
	receiptRead := false
	d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) {
		reads++
		if reads == 2 {
			if !receiptRead {
				t.Fatal("claim must follow receipt")
			}
			return second, nil
		}
		return first, nil
	}
	d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
		receiptRead = true
		return model.AssistantTaskClaimOperation{OperationID: entryID, ResultingGeneration: 3}, nil
	}
	result, err := New().ClaimOperation(context.Background(), d, botActor(), taskID, entryID)
	if err != nil {
		t.Fatal(err)
	}
	if result.CurrentClaim.Generation != 3 || result.CurrentClaim.ObservedAt != second.ObservedAt {
		t.Fatal("stale claim accompanied new receipt")
	}
}

func TestClaimRefusalsAndStorageErrors(t *testing.T) {
	for _, name := range []string{"wrong-generation", "expired", "pending", "same-target", "overflow", "save-conflict", "save-error", "read-error", "receipt-error", "credential-error", "missing-credential", "deleted-bot", "foreign-owner", "deleted-task"} {
		t.Run(name, func(t *testing.T) {
			task := baseTask()
			d := baseDAO(t, task)
			input := ClaimInput{Kind: "renew", TaskID: taskID, OperationID: entryID, ExpectedGeneration: 2, ClaimToken: token}
			code := "claim_lost"
			wantSentinel := false
			d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
				return model.AssistantTaskClaimOperation{}, model.ErrNotFound
			}
			switch name {
			case "wrong-generation":
				input.ExpectedGeneration = 1
			case "expired":
				task.LeaseUntil = ptr(epoch)
				d = baseDAO(t, task)
				d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
					return model.AssistantTaskClaimOperation{}, model.ErrNotFound
				}
			case "pending":
				task.ClaimTokenHash = nil
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) { return task, nil }
			case "same-target":
				input.Kind = "transfer"
				input.IfVersion = ptr(int64(7))
				input.TargetBotID = ptr(botID)
				code = "invalid_input"
			case "overflow":
				task.Version = math.MaxInt64
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) { return task, nil }
				code = "invalid_input"
			case "save-conflict":
				d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
					return false, nil
				}
			case "save-error":
				wantSentinel = true
				d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
					return false, sentinel
				}
			case "read-error":
				wantSentinel = true
				d.claimOperation = func(context.Context, string, string, string) (model.AssistantTaskClaimOperation, error) {
					return model.AssistantTaskClaimOperation{}, sentinel
				}
			case "receipt-error":
				wantSentinel = true
				d.saveTask = func(context.Context, model.AssistantTask, store.AssistantTaskCondition) (bool, error) {
					return true, nil
				}
				d.insertClaimOperation = func(context.Context, model.AssistantTaskClaimOperation) error { return sentinel }
			case "credential-error":
				wantSentinel = true
				d.credential = func(context.Context, model.Principal) error { return sentinel }
			case "missing-credential":
				code = "unauthenticated"
				d.credential = func(context.Context, model.Principal) error { return model.ErrNotFound }
			case "deleted-bot":
				code = "forbidden"
				d.bot = func(context.Context, string) (model.Bot, error) {
					return model.Bot{OwnerUserID: ownerID, Deletion: &model.BotDeletion{}}, nil
				}
			case "foreign-owner":
				code = "forbidden"
				task.OwnerUserID = targetID
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) { return task, nil }
			case "deleted-task":
				code = "task_deleted"
				task.State = "deleted"
				d.task = func(context.Context, string, string, bool) (model.AssistantTask, error) { return task, nil }
			}
			_, err := New().Claim(context.Background(), d, botActor(), input)
			if wantSentinel {
				if !errors.Is(err, sentinel) {
					t.Fatalf("lost cause: %v", err)
				}
			} else {
				requireCode(t, err, code)
			}
		})
	}
}

func TestClaimFingerprintRejectsAmbiguousFields(t *testing.T) {
	for _, name := range []string{"token-padding", "token-short", "wrong-kind", "user-claim", "nil-version", "invalid-id", "negative-generation", "bind-version", "nil-target", "user-token", "bot-release-version", "zero-bind"} {
		t.Run(name, func(t *testing.T) {
			actor := botActor()
			input := ClaimInput{Kind: "claim", TaskID: taskID, OperationID: operationID, IfVersion: ptr(int64(7)), ClaimToken: token}
			switch name {
			case "token-padding":
				input.ClaimToken += "="
			case "token-short":
				input.ClaimToken = base64.RawURLEncoding.EncodeToString([]byte{1})
			case "wrong-kind":
				input.Kind = "other"
			case "user-claim":
				actor = userActor()
				input.ClaimToken = ""
			case "nil-version":
				input.IfVersion = nil
			case "invalid-id":
				input.TaskID = "bad"
			case "negative-generation":
				input.ExpectedGeneration = -1
			case "bind-version":
				input.Kind = "bind"
				input.ExpectedGeneration = 1
			case "nil-target":
				input.Kind = "transfer"
			case "user-token":
				actor = userActor()
				input.Kind = "release"
			case "bot-release-version":
				input.Kind = "release"
			case "zero-bind":
				input.Kind = "bind"
				input.IfVersion = nil
			}
			_, _, err := ClaimFingerprint(actor, input)
			requireCode(t, err, "invalid_input")
		})
	}
}
