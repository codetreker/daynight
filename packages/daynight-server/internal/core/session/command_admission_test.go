package session

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type missingOperationProbe struct{ store.SessionDAO }

func TestCommandScopeRejectsUnsupportedKind(t *testing.T) {
	if _, err := commandScope("unknown"); err == nil {
		t.Fatal("unsupported command accepted")
	}
}

func TestScopedReplayFailsWithoutExistenceProbe(t *testing.T) {
	s := &Execution{commandAdmission: func(context.Context, store.SessionScope, model.Principal, scopepolicy.Operation) error {
		t.Fatal("admission ran without a reliable existence probe")
		return nil
	}}
	err := s.admitReplay(t.Context(), &operationTx{dao: missingOperationProbe{}}, model.Principal{}, "session", "operation")
	if err == nil {
		t.Fatal("missing operation existence capability accepted")
	}
}

func TestCommandAdmissionUsesBehaviorIncludingPureImage(t *testing.T) {
	for _, tc := range []struct {
		kind, payload string
		want          scopepolicy.Operation
	}{
		{"send_message", `{"content":[{"type":"image"}]}`, scopepolicy.SessionSend},
		{"send_message", `{"content":[{"type":"text","text":"hi"}]}`, scopepolicy.SessionSend},
		{"cancel", `{}`, scopepolicy.SessionControl},
		{"interaction_response", `{}`, scopepolicy.SessionControl},
		{"update_setting", `{}`, scopepolicy.SessionControl},
		{"execute_command", `{}`, scopepolicy.SessionControl},
		{"refresh_controls", `{}`, scopepolicy.SessionControl},
	} {
		t.Run(tc.kind+tc.payload, func(t *testing.T) {
			f, v := connectFixture(t)
			refusal := &model.Fault{Code: "insufficient_scope", Message: "denied"}
			var got scopepolicy.Operation
			f.s.SetCommandAdmission(func(_ context.Context, scope store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if scope == nil || p != f.p {
					t.Fatal("lost transaction or actor")
				}
				got = op
				return refusal
			})
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: tc.kind, Payload: json.RawMessage(tc.payload)}
			_, err := fixtureSubmit(f, t.Context(), f.p, v, c, nil)
			if !errors.Is(err, refusal) || got != tc.want {
				t.Fatalf("admission: got %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func TestCommandReplayRequiresReadBeforeStoredOperation(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new send", true: "replay"}[existing], func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
			f.dao.SessionOperationExistsFn = func(_ context.Context, session, id string) (bool, error) {
				if session != v.SessionID || id != c.OperationID {
					t.Fatal("probe identity changed")
				}
				return existing, nil
			}
			var calls []scopepolicy.Operation
			refusal := &model.Fault{Code: "insufficient_scope", Message: "no read"}
			f.s.SetCommandAdmission(func(_ context.Context, scope store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if scope == nil || p != f.p {
					t.Fatal("lost transaction or actor")
				}
				calls = append(calls, op)
				if op == scopepolicy.SessionRead {
					return refusal
				}
				return nil
			})
			counts := map[string]int{"SessionOperationExists": 1}
			if !existing {
				counts["SessionOperation"] = 1
				counts["PendingSessionOperationCount"] = 1
				counts["InsertSessionOperation"] = 1
				counts["SaveSession"] = 1
			}
			receipt, err := fixtureSubmit(f, t.Context(), f.p, v, c, counts)
			if existing {
				if !errors.Is(err, refusal) || !reflect.DeepEqual(calls, []scopepolicy.Operation{scopepolicy.SessionSend, scopepolicy.SessionRead}) || receipt.OperationID != "" {
					t.Fatalf("replay disclosed data: %#v %v %v", receipt, err, calls)
				}
			} else if err != nil || receipt.State != "accepted" || !reflect.DeepEqual(calls, []scopepolicy.Operation{scopepolicy.SessionSend}) {
				t.Fatalf("new send required read: %#v %v %v", receipt, err, calls)
			}
		})
	}
}

func TestReceiptAdmissionPrecedesReceiptLookup(t *testing.T) {
	f, v := connectFixture(t)
	refusal := &model.Fault{Code: "insufficient_scope", Message: "no read"}
	f.s.SetCommandAdmission(func(_ context.Context, scope store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
		if scope == nil || p != f.p || op != scopepolicy.SessionRead {
			t.Fatal("incorrect receipt admission")
		}
		return refusal
	})
	ctx := f.BrowserPhase(t.Context(), map[string]int{"SessionLocation": 1})
	_, err := f.s.TaskOperation(ctx, f.p, f.project, f.task, v.SessionID, uuid.NewString())
	f.dao.FinishContext(ctx)
	if !errors.Is(err, refusal) {
		t.Fatalf("receipt read: %v", err)
	}
}

func TestRevokedCommandScopeRejectsBeforeOfferAndBegin(t *testing.T) {
	for _, stage := range []string{"offer", "begin"} {
		t.Run(stage, func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
			f.dao.SessionOperationExistsFn = func(context.Context, string, string) (bool, error) { return false, nil }
			revoked := false
			f.s.SetCommandAdmission(func(_ context.Context, scope store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if scope == nil || p != actor || op != scopepolicy.SessionSend {
					t.Fatalf("wrong original actor or operation: %#v %s", p, op)
				}
				if revoked {
					return &model.Fault{Code: "insufficient_scope", Message: "revoked"}
				}
				return nil
			})
			_, err := fixtureSubmit(f, t.Context(), actor, v, c, map[string]int{"SessionOperationExists": 1, "SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
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
			revoked = true
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
			if f.writes.Receipt == nil || f.writes.Receipt.State != "rejected" || f.writes.Receipt.Error == nil || f.writes.Receipt.Error.Code != "permission_or_state_changed" {
				t.Fatalf("missing durable rejection: %#v", f.writes.Receipt)
			}
		})
	}
}

func TestDispatchAdmissionFailureKeepsOriginalOutcome(t *testing.T) {
	for _, stage := range []string{"offer failure", "dispatching revoked"} {
		t.Run(stage, func(t *testing.T) {
			f, v := connectFixture(t)
			publishState(t, f, v, idleState())
			actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
			c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"queued"}],"expectedTurnId":null}`)}
			f.dao.SessionOperationExistsFn = func(context.Context, string, string) (bool, error) { return false, nil }
			var failure error
			f.s.SetCommandAdmission(func(_ context.Context, scope store.SessionScope, p model.Principal, op scopepolicy.Operation) error {
				if scope == nil || p != actor || op != scopepolicy.SessionSend {
					t.Fatalf("wrong original actor: %#v %s", p, op)
				}
				return failure
			})
			_, err := fixtureSubmit(f, t.Context(), actor, v, c, map[string]int{"SessionOperationExists": 1, "SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil {
				t.Fatal(err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)
			f.data.AcceptedIDs = []string{c.OperationID}
			if stage == "offer failure" {
				failure = errors.New("authorization storage unavailable")
				offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2})
				if !errors.Is(err, failure) || len(offers) != 0 || f.writes.Receipt != nil {
					t.Fatalf("storage failure became rejection: %v %v %#v", offers, err, f.writes.Receipt)
				}
				return
			}
			offers, err := fixturePoll(f, t.Context(), v.ControllerFence, map[string]int{"AcceptedSessionOperations": 1, "SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationEpoch": 1, "SetSessionOperationReceipt": 1, "SaveSession": 1})
			if err != nil || len(offers) != 1 {
				t.Fatalf("offer: %v %v", offers, err)
			}
			f.SelectReceiptWrite(t)
			f.SelectEpochWrite(t)
			f.SelectSessionWrite(t)
			_, err = fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
			if err != nil || f.writes.Receipt.State != "dispatching" {
				t.Fatalf("begin: %v %#v", err, f.writes.Receipt)
			}
			f.SelectReceiptWrite(t)
			f.SelectSessionWrite(t)
			f.SelectTouchWrite(t)
			failure = &model.Fault{Code: "insufficient_scope", Message: "revoked"}
			_, err = fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}, map[string]int{"SessionOperation": 1, "LockCredential": 2, "ProjectAccess": 2})
			if !errors.Is(err, failure) || f.writes.Receipt != nil || f.data.Operation.Receipt.State != "dispatching" {
				t.Fatalf("revocation erased dispatch: %v %#v", err, f.writes.Receipt)
			}
			confirmed := f.data.Operation.Receipt
			confirmed.State = "confirmed"
			_, err = fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &confirmed}, map[string]int{"SessionOperation": 1, "SetSessionOperationReceipt": 1, "TouchSession": 1, "SaveSession": 1})
			if err != nil || f.writes.Receipt == nil || f.writes.Receipt.State != "confirmed" {
				t.Fatalf("native fact lost after revocation: %v %#v", err, f.writes.Receipt)
			}
		})
	}
}

func TestCommandScopeFollowsSessionOwnerAuthorization(t *testing.T) {
	f, v := connectFixture(t)
	actor := addMember(t, f, "member")
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	f.s.SetCommandAdmission(func(context.Context, store.SessionScope, model.Principal, scopepolicy.Operation) error {
		t.Fatal("scope checked before Session owner authorization")
		return nil
	})
	_, err := fixtureSubmit(f, t.Context(), actor, v, c, nil)
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "forbidden" {
		t.Fatalf("non-owner received wrong refusal: %v", err)
	}
}
