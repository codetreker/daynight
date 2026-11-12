package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestTaskSendAdmitsOAuthOwner(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "oauth", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"/literal\r\n消息\n"}],"expectedTurnId":null}`)}
	receipt, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if err != nil || receipt.State != "accepted" {
		t.Fatalf("Task OAuth owner send = %#v, %v", receipt, err)
	}
}

func TestTaskOperationRetainsHistoricalReceiptWithoutWrites(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.OAuthCredential} {
		t.Run(string(kind), func(t *testing.T) {
			f, v := connectFixture(t)
			actor := listCredential(t, f, f.p.UserID, kind)
			operationID := uuid.NewString()
			receipt := sp.Operation{Fence: v.Fence, Protocol: sp.Protocol, OperationID: operationID, Kind: "send_message", State: "provider_accepted"}
			f.dao.SessionOperationFn = func(_ context.Context, session, operation string) (store.SessionOperation, error) {
				if session != v.SessionID || operation != operationID {
					t.Fatal("receipt target changed")
				}
				return store.SessionOperation{Receipt: receipt}, nil
			}
			f.data.Task.Worker.ClaimID = uuid.NewString()
			f.data.Session.Snapshot.Lifecycle = "draining"
			expired := f.s.now().Add(-time.Hour)
			f.data.Session.DrainUntil = &expired
			result, err := f.s.TaskOperation(f.BrowserPhase(t.Context(), map[string]int{"SessionLocation": 1, "SessionOperation": 1}), actor, f.project, f.task, v.SessionID, operationID)
			if err != nil || result.CurrentBinding || !reflect.DeepEqual(result.Operation, receipt) {
				t.Fatalf("historical receipt = %#v, %v", result, err)
			}
		})
	}
}

func TestTaskSendReauthorizesOriginalOAuthActorBeforeOfferAndBegin(t *testing.T) {
	for _, profile := range []string{"mcp", "api"} {
		for _, stage := range []string{"offer", "begin", "reconcile"} {
			t.Run(profile+"/"+stage, func(t *testing.T) {
				f, v := connectFixture(t)
				publishState(t, f, v, idleState())
				actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
				if profile == "api" {
					setAPICredential(f, actor)
				}
				command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"once"}],"expectedTurnId":null}`)}
				if _, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1}); err != nil {
					t.Fatal(err)
				}
				f.SelectOperationWrite(t)
				f.SelectSessionWrite(t)
				f.data.AcceptedIDs = []string{command.OperationID}
				if stage != "offer" {
					if _, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1}); err != nil {
						t.Fatal(err)
					}
					selectContentOffer(t, f)
				}
				revokeContentCredential(t, f, actor)
				switch stage {
				case "offer":
					offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "SetSessionOperationReceipt": 1, "SaveSession": 1})
					if err != nil || len(offers) != 0 {
						t.Fatalf("revoked actor offered: %v %v", offers, err)
					}
				case "begin":
					_, err := fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
					if err != nil {
						t.Fatal(err)
					}
				case "reconcile":
					_, err := fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: "not_submitted"}}, Final: true}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "UnreconciledSessionOperations": 1, "TouchSession": 1, "SaveSession": 1})
					if err != nil {
						t.Fatal(err)
					}
				}
				if f.writes.Receipt == nil || f.writes.Receipt.State != "rejected" {
					t.Fatalf("revoked original Actor was dispatched: %#v", f.writes.Receipt)
				}
			})
		}
	}
}

func TestTaskOAuthPurposeDoesNotAdmitOtherCommandsOrIndependentSessions(t *testing.T) {
	for _, kind := range []string{"cancel", "interaction_response", "update_setting", "execute_command", "refresh_controls"} {
		t.Run(kind, func(t *testing.T) {
			f, v := connectFixture(t)
			actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
			phase := f.dao.ContextPhase(t.Context(), map[string]int{"LockTask": 1})
			_, err := f.s.Submit(phase, actor, f.project, f.task, v.SessionID, controlCommand(v, kind))
			assertCommandAuthorization(t, err, "unauthenticated", nil)
		})
	}
	f, v, _ := testSession(t, "none")
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	_, err := f.s.Submit(f.dao.ContextPhase(t.Context(), map[string]int{"SessionBotID": 1, "LockSession": 1}), actor, "", "", v.SessionID, controlCommand(v, "send_message"))
	assertCommandAuthorization(t, err, "unauthenticated", nil)
}

func TestTaskOperationRetainsReaderVisibilityAndRejectsChangedAccess(t *testing.T) {
	for _, scenario := range []string{"reader", "credential", "project", "other task", "missing operation", "wrong receipt", "Bot", "missing Session"} {
		t.Run(scenario, func(t *testing.T) {
			f, v := connectFixture(t)
			operation := uuid.NewString()
			actor := f.p
			if scenario == "reader" {
				actor = addMember(t, f, "member")
			}
			f.dao.SessionOperationFn = func(context.Context, string, string) (store.SessionOperation, error) {
				if scenario == "missing operation" {
					return store.SessionOperation{}, model.ErrNotFound
				}
				receipt := sp.Operation{Fence: v.Fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "unknown"}
				if scenario == "wrong receipt" {
					receipt.SessionID = uuid.NewString()
				}
				return store.SessionOperation{Receipt: receipt}, nil
			}
			want := map[string]int{"SessionLocation": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1, "SessionOperation": 1}
			switch scenario {
			case "credential":
				f.dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
				delete(want, "ProjectAccess")
				delete(want, "SessionLocation")
				delete(want, "SessionBotID")
				delete(want, "LockSession")
				delete(want, "SessionOperation")
			case "project":
				f.dao.ProjectAccessFn = func(context.Context, string, string) (model.ProjectAccess, error) {
					return model.ProjectAccess{}, model.ErrNotFound
				}
				delete(want, "SessionLocation")
				delete(want, "SessionBotID")
				delete(want, "LockSession")
				delete(want, "SessionOperation")
			case "other task":
				f.data.Session.Snapshot.Identity.TaskID = uuid.NewString()
				delete(want, "SessionOperation")
			case "Bot":
				f.dao.SessionBotIDFn = func(context.Context, string) (*string, error) { id := uuid.NewString(); return &id, nil }
				delete(want, "LockSession")
				delete(want, "SessionOperation")
			case "missing Session":
				f.dao.LockSessionFn = func(context.Context, string) (store.SessionRecord, error) {
					return store.SessionRecord{}, model.ErrNotFound
				}
				delete(want, "SessionOperation")
			}
			result, err := f.s.TaskOperation(f.dao.ContextPhase(t.Context(), want), actor, f.project, f.task, v.SessionID, operation)
			if scenario == "reader" {
				if err != nil || !result.CurrentBinding || result.Operation.OperationID != operation {
					t.Fatalf("reader lost receipt: %#v %v", result, err)
				}
			} else if err == nil {
				t.Fatalf("invalid history access succeeded: %#v", result)
			}
		})
	}
}

func TestTaskOAuthIdempotencyPreservesTextAndTurn(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "exact\r\n😀\n"}}})}
	receipt, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	f.SelectSessionWrite(t)
	command.RequestID = "another"
	again, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1})
	if err != nil || !reflect.DeepEqual(receipt, again) {
		t.Fatalf("duplicate lost original receipt: %#v %v", again, err)
	}
	for _, payload := range []string{`{"content":[{"type":"text","text":"exact\n😀\n"}],"expectedTurnId":null}`, `{"content":[{"type":"text","text":"exact\r\n😀\n"}],"expectedTurnId":"turn"}`} {
		command.Payload = json.RawMessage(payload)
		_, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1})
		assertCommandAuthorization(t, err, "operation_conflict", nil)
	}
}

func TestTaskOperationIdentityAndStorageFailuresLeaveLiveStateUntouched(t *testing.T) {
	for _, scenario := range []string{"location failure", "wrong project", "wrong task", "wrong Session", "association failure", "record failure", "snapshot mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			f, v := connectFixture(t)
			cell := f.s.live[v.SessionID]
			original := cell.value
			command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"already queued"}],"expectedTurnId":null}`)}
			original.Commands[command.OperationID] = command
			commands := fixtureCopy(original.Commands)
			cause := errors.New("receipt storage unavailable")
			var expectedCause error
			counts := map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "SessionLocation": 1}
			switch scenario {
			case "location failure":
				f.data.LocationError = cause
				expectedCause = cause
			case "wrong project":
				f.data.Location.ProjectID = uuid.NewString()
			case "wrong task":
				f.data.Location.TaskID = uuid.NewString()
			case "wrong Session":
				f.data.Location.SessionID = uuid.NewString()
			case "association failure":
				counts["SessionBotID"] = 1
				f.dao.SessionBotIDFn = func(_ context.Context, id string) (*string, error) {
					if id != v.SessionID {
						t.Fatal("association lookup changed Session")
					}
					return nil, cause
				}
				expectedCause = cause
			case "record failure", "snapshot mismatch":
				counts["SessionBotID"], counts["LockSession"] = 1, 1
				f.dao.LockSessionFn = func(_ context.Context, id string) (store.SessionRecord, error) {
					if id != v.SessionID {
						t.Fatal("record lookup changed Session")
					}
					if scenario == "record failure" {
						return store.SessionRecord{}, cause
					}
					record := fixtureCopy(*f.data.Session)
					record.Snapshot.SessionID = uuid.NewString()
					return record, nil
				}
				if scenario == "record failure" {
					expectedCause = cause
				}
			}
			result, err := f.s.TaskOperation(f.dao.ContextPhase(t.Context(), counts), f.p, f.project, f.task, v.SessionID, uuid.NewString())
			assertCommandAuthorization(t, err, "session_conflict", expectedCause)
			if !reflect.DeepEqual(result, TaskOperationResult{}) {
				t.Fatalf("refusal exposed a receipt: %#v", result)
			}
			if f.s.live[v.SessionID] != cell || cell.value != original || !reflect.DeepEqual(cell.value.Commands, commands) {
				t.Fatal("failed historical read attached, discarded, restored or changed live commands")
			}
		})
	}
}
