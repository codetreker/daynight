package session

import (
	"context"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestServiceOperationRefusalProofSurvivesRestart(t *testing.T) {
	for _, stage := range []string{"poll", "begin", "controller-receipt", "controller-reconcile", "legacy"} {
		t.Run(stage, func(t *testing.T) {
			f := newServiceFixture(t)
			v := f.connectWeb(t, f.registerWeb(t))
			synchronizeServiceSession(t, f, v)
			command := serviceMessage(v)
			receipt, err := f.service.Submit(t.Context(), f.owner, f.project, f.task, v.SessionID, command)
			if err != nil || receipt.State != "accepted" {
				t.Fatalf("submit: %+v %v", receipt, err)
			}
			if stage != "poll" {
				if offers, err := f.service.Poll(t.Context(), v.ControllerFence); err != nil || len(offers) != 1 {
					t.Fatalf("offer: %v %v", offers, err)
				}
			}
			proof := stage == "poll" || stage == "begin"
			if proof {
				native := "native"
				state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "unknown"}
				if _, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
					t.Fatal(err)
				}
				if stage == "poll" {
					if offers, err := f.service.Poll(t.Context(), v.ControllerFence); err != nil || len(offers) != 0 {
						t.Fatalf("refusal offered native work: %v %v", offers, err)
					}
				} else {
					reply, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
					if err != nil || reply["type"] != "receipt_ack" {
						t.Fatalf("begin refusal: %v %v", reply, err)
					}
				}
			} else {
				receipt.State = "rejected"
				// Controller-origin errors must never manufacture the server proof,
				// even when their code matches and their message contains private text.
				receipt.Error = &sp.OperationError{Code: "permission_or_state_changed", Message: "private native error"}
				if stage == "legacy" {
					receipt.Error = nil
				}
				message := sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}
				if stage == "controller-reconcile" {
					message = sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: receipt.State, Error: receipt.Error}}}
				}
				if _, err := f.service.Handle(t.Context(), message); err != nil {
					t.Fatal(err)
				}
			}
			assertReceipt := func(service *Service) sp.Operation {
				t.Helper()
				got, err := service.TaskOperation(t.Context(), f.owner, f.project, f.task, v.SessionID, command.OperationID)
				if err != nil || got.Operation.State != "rejected" || got.Operation.ProviderResult != nil {
					t.Fatalf("read refusal: %+v %v", got, err)
				}
				if proof {
					if got.Operation.Error == nil || got.Operation.Error.Code != "permission_or_state_changed" || got.Operation.Error.Message != "Operation no longer has current permission or state." {
						t.Fatalf("lost trusted refusal: %+v", got.Operation)
					}
				} else if got.Operation.Error != nil {
					t.Fatalf("persisted Controller diagnostic as proof: %+v", got.Operation)
				}
				return got.Operation
			}
			saved := assertReceipt(f.service)
			if stage != "poll" {
				duplicate := saved
				duplicate.Error = &sp.OperationError{Code: "native_operation_error", Message: "private journal diagnostic"}
				if stage == "legacy" {
					duplicate.Error.Code = "permission_or_state_changed"
				}
				reply, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &duplicate})
				if err != nil {
					t.Fatalf("duplicate rejection failed: %v", err)
				}
				ack := reply["operation"].(sp.Operation)
				if proof && (ack.Error == nil || ack.Error.Code != saved.Error.Code) || !proof && ack.Error != nil {
					t.Fatalf("duplicate replaced durable proof: %+v", ack)
				}
				if _, err := f.service.Handle(t.Context(), sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Operations: []sp.Reconciliation{{OperationID: command.OperationID, State: "rejected", Error: duplicate.Error}}}); err != nil {
					t.Fatalf("terminal reconciliation failed: %v", err)
				}
			}
			// A fresh Engine has no live cache; both reads use committed PostgreSQL
			// operations through the same public service path as the GET endpoint.
			engine := core.NewEngine(nil)
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := engine.Stop(ctx); err != nil {
					t.Error(err)
				}
			})
			assertReceipt(New(f.db, engine))
		})
	}
}
