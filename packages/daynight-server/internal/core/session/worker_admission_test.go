package session

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"testing"
)

func TestWorkerDisableRejectsBeforeOfferAndBegin(t *testing.T) {
	for _, stage := range []string{"offer", "begin"} {
		t.Run(stage, func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			actor := f.p
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
			disabled := false
			f.writer.WorkerCheck = func(ctx context.Context, user, worker string) error {
				if ctx == nil || user != f.p.UserID || worker != f.r.WorkerID {
					t.Fatal("lost Worker identity")
				}
				if disabled {
					return &model.Fault{Code: "worker_disabled", Message: "closed"}
				}
				return nil
			}

			_, err := fixtureSubmit(f, t.Context(), actor, v, c, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)
			f.data.AcceptedIDs = []string{c.OperationID}
			if stage == "begin" {
				offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
				if err != nil || len(offers) != 1 {
					t.Fatalf("offer: %v %v", offers, err)
				}
				f.SelectReceiptWrite(t)
				f.SelectEpochWrite(t)
				f.SelectSessionWrite(t)
			}
			disabled = true
			if stage == "offer" {
				offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SaveSession": 1})
				if err != nil || len(offers) != 0 {
					t.Fatalf("revoked offer: %v %v", offers, err)
				}
			} else {
				out, err := fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
				if err != nil || out["type"] != "receipt_ack" {
					t.Fatalf("revoked begin: %v %v", out, err)
				}
			}
			if f.writes.Receipt == nil || f.writes.Receipt.State != "rejected" || f.writes.Receipt.Error == nil || f.writes.Receipt.Error.Code != "worker_disabled" {
				t.Fatalf("missing durable rejection: %#v", f.writes.Receipt)
			}
		})
	}
}

func TestWorkerDisableRejectsNewInputButPreservesOriginalReceipt(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, idleState())
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	original, err := fixtureSubmit(f, t.Context(), f.p, v, c, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if err != nil {
		t.Fatal(err)
	}
	f.SelectOperationWrite(t)
	checks := 0
	f.writer.WorkerCheck = func(context.Context, string, string) error { checks++; return &model.Fault{Code: "worker_disabled"} }
	replay, err := fixtureSubmit(f, t.Context(), f.p, v, c, map[string]int{"SessionOperation": 1})
	if err != nil || replay.OperationID != original.OperationID || checks != 0 {
		t.Fatalf("replay lost: %+v %v %d", replay, err, checks)
	}
	c.OperationID = uuid.NewString()
	_, err = fixtureSubmit(f, t.Context(), f.p, v, c, map[string]int{"SessionOperation": 1})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "worker_disabled" || checks != 1 {
		t.Fatalf("new input: %v %d", err, checks)
	}
}

func TestWorkerAdmissionKindsAndMissingScope(t *testing.T) {
	for _, kind := range []string{"send_message", "interaction_response", "execute_command", "update_setting", "refresh_controls"} {
		_, err := commandWorkerVersion(t.Context(), &operationTx{}, &record{Owner: uuid.NewString(), ExecutionWorkerID: uuid.NewString()}, kind)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "lifecycle_unavailable" {
			t.Fatalf("%s: %v", kind, err)
		}
	}
	if _, err := commandWorkerVersion(t.Context(), &operationTx{}, &record{ExecutionWorkerID: uuid.NewString()}, "cancel"); err != nil {
		t.Fatal(err)
	}
	if err := RequireWorkerExecution(t.Context(), nil, "owner", ""); err != nil {
		t.Fatal(err)
	}
}

var _ store.WorkerExecutionAdmissionScope = (*fixtureWriter)(nil)

func TestResumedWorkerRejectsPreDisableCommands(t *testing.T) {
	for _, stage := range []string{"offer", "begin"} {
		t.Run(stage, func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			actor := f.p
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
			version := int64(1)
			f.writer.WorkerVersion = &version
			f.writer.WorkerCheck = func(ctx context.Context, user, worker string) error {
				if ctx == nil || user != f.p.UserID || worker != f.r.WorkerID {
					t.Fatal("lost Worker identity")
				}

				return nil
			}

			_, err := fixtureSubmit(f, t.Context(), actor, v, c, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)
			f.data.AcceptedIDs = []string{c.OperationID}
			if stage == "begin" {
				offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
				if err != nil || len(offers) != 1 {
					t.Fatalf("offer: %v %v", offers, err)
				}
				f.SelectReceiptWrite(t)
				f.SelectEpochWrite(t)
				f.SelectSessionWrite(t)
			}
			version = 3
			f.writer.WorkerVersion = &version
			if stage == "offer" {
				offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "SaveSession": 1})
				if err != nil || len(offers) != 0 {
					t.Fatalf("revoked offer: %v %v", offers, err)
				}
			} else {
				out, err := fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
				if err != nil || out["type"] != "receipt_ack" {
					t.Fatalf("revoked begin: %v %v", out, err)
				}
			}
			if f.writes.Receipt == nil || f.writes.Receipt.State != "rejected" || f.writes.Receipt.Error == nil || f.writes.Receipt.Error.Code != "worker_disabled" {
				t.Fatalf("missing durable rejection: %#v", f.writes.Receipt)
			}
		})
	}
}

func TestBotInputChecksCurrentHostingWorker(t *testing.T) {
	for _, recovered := range []bool{false, true} {
		t.Run(map[bool]string{false: "original", true: "recovered"}[recovered], func(t *testing.T) {
			f, out, _, _ := connectedBotFixture(t)
			worker := out.Bot.WorkerID
			if recovered {
				worker = uuid.NewString()
				botDAO(f).value.Recovery = &model.BotRecovery{WorkerID: worker}
			}
			calls := 0
			f.writer.WorkerCheck = func(_ context.Context, user, actual string) error {
				if user != f.p.UserID || actual != worker {
					t.Fatalf("Worker binding: %s %s", user, actual)
				}
				calls++
				return &model.Fault{Code: "worker_disabled"}
			}
			c := sp.Command{Fence: out.Session.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"new"}],"expectedTurnId":null}`)}
			ctx := botPhase(t, f, t.Context(), map[string]int{"SessionBotID": 1, "Bot": 1, "LockSession": 1, "LockCredential": 2, "SessionOperation": 1})
			_, err := f.s.Submit(ctx, f.p, "", "", out.Session.SessionID, c)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "worker_disabled" || calls != 1 {
				t.Fatalf("Bot input gate: %v calls %d", err, calls)
			}
		})
	}
}

func TestReconcilePreservesWorkerRejectionAndUnknownDispatch(t *testing.T) {
	for _, state := range []string{"accepted", "offered", "dispatching"} {
		t.Run(state, func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
			_, err := fixtureSubmit(f, t.Context(), f.p, v, c, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)
			f.data.Operation.Receipt.State = state
			f.writer.WorkerCheck = func(context.Context, string, string) error { return &model.Fault{Code: "worker_disabled"} }
			_, err = fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: c.OperationID, State: "not_submitted"}}, Final: true}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "UnreconciledSessionOperations": 1, "TouchSession": 1, "SaveSession": 1})
			if err != nil {
				t.Fatal(err)
			}
			receipt := f.writes.Receipt
			if state == "dispatching" {
				if receipt.State != "unknown" {
					t.Fatalf("claimed unsubmitted: %+v", receipt)
				}
			} else if receipt.State != "rejected" || receipt.Error == nil || receipt.Error.Code != "worker_disabled" {
				t.Fatalf("lost refusal proof: %+v", receipt)
			}
		})
	}
}

func TestQueuedWorkerIntentBindsOwnerAndRejectsLegacyAfterAdoption(t *testing.T) {
	version := int64(7)
	worker := uuid.NewString()
	oldWorker := uuid.NewString()
	for _, test := range []struct {
		name                            string
		originalOwner                   *string
		originalVersion, currentVersion *int64
		allowed                         bool
	}{
		{"same Worker and intent", &worker, &version, &version, true},
		{"different Worker same version", &oldWorker, &version, &version, false},
		{"legacy before adoption", nil, nil, nil, true},
		{"legacy after adoption", nil, nil, &version, false},
		{"missing current lifecycle", &worker, &version, nil, false},
		{"missing original owner", nil, &version, &version, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			scope := &fixtureWriter{WorkerVersion: test.currentVersion, WorkerCheck: func(_ context.Context, owner, actual string) error {
				calls++
				if owner != "owner" || actual != worker {
					t.Fatal("wrong execution scope")
				}
				return nil
			}}
			err := requireOperationWorker(t.Context(), &operationTx{scope: scope}, &record{Owner: "owner", ExecutionWorkerID: worker}, operationRecord{WorkerID: test.originalOwner, WorkerIntentVersion: test.originalVersion, Command: sp.Command{Kind: "send_message"}})
			if test.allowed {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "worker_disabled" {
					t.Fatalf("invalid old authorization: %v", err)
				}
			}
			if calls != 1 {
				t.Fatalf("authority checks: %d", calls)
			}
		})
	}
}
