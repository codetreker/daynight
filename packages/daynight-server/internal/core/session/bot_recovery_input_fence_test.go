package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func readyRecoveryBot(t *testing.T) (fixture, sp.Snapshot) {
	t.Helper()
	f, registered, _, _ := connectedBotFixture(t)
	f.project, f.task = "", ""
	v := registered.Session
	native := "native-before-recovery"
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}, map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	f.SelectTouchWrite(t)
	return f, f.s.live[v.SessionID].value.Snapshot
}

func recoveryBrowserSnapshot(t *testing.T, f fixture, id string) sp.Snapshot {
	t.Helper()
	ctx := f.BrowserPhase(t.Context(), nil)
	defer f.dao.FinishContext(ctx)
	v, err := f.s.TestSnapshot(ctx, f.p, id)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func recoveryMessage(v sp.Snapshot) sp.Command {
	return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, OperationID: uuid.NewString(), Kind: "send_message", Payload: []byte(`{"content":[{"type":"text","text":"next input"}],"expectedTurnId":null}`)}
}

func TestBotRecoveryDurableLeaseBlocksCachedBrowserInput(t *testing.T) {
	for _, completion := range []string{"other relay", "unknown commit"} {
		t.Run(completion, func(t *testing.T) {
			f, before := readyRecoveryBot(t)
			now := f.s.now()
			f.s.now = func() time.Time { return now }
			if view := recoveryBrowserSnapshot(t, f, before.SessionID); !view.Operations.CanSend {
				t.Fatal("original synchronized Bot cannot send")
			}
			original := recoveryMessage(before)
			prior, err := fixtureSubmit(f, t.Context(), f.p, before, original, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil || prior.State != "accepted" {
				t.Fatalf("original input: %+v %v", prior, err)
			}
			f.SelectOperationWrite(t)
			f.SelectSessionWrite(t)

			recoveryEngine := f.s.Engine
			if completion == "other relay" {
				recoveryEngine = NewEngine(nil)
				t.Cleanup(func() {
					ctx, cancel := context.WithTimeout(context.Background(), time.Second)
					defer cancel()
					if err := recoveryEngine.Stop(ctx); err != nil {
						t.Error(err)
					}
				})
			}
			op, err := recoveryEngine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(op.Close)
			ctx := botPhase(t, f, t.Context(), map[string]int{"LockSession": 1, "SetSessionGrant": 1, "SaveSession": 2, "DisconnectSession": 1})
			bot := botDAO(f).value
			a, err := op.Load(ctx, f.writer, before.SessionID, &bot)
			if err != nil {
				t.Fatal(err)
			}
			input := BotRecoveryGrant{BotRecoveryBinding: BotRecoveryBinding{SessionID: before.SessionID, TestExecutionID: before.TestExecutionID, NativeSessionID: before.Identity.NativeSessionID}, ControllerToken: "dncontroller_" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{31}, 32)), Grant: sp.Grant{Protocol: sp.Protocol, TestExecutionID: before.TestExecutionID, ControllerID: before.Identity.ControllerID, ControllerInstanceID: before.Identity.ControllerInstanceID, ExecutionGeneration: before.ExecutionGeneration, Kind: "reconnect"}}
			grant, err := op.GrantBotRecovery(ctx, a, f.p, input)
			if err != nil {
				t.Fatal(err)
			}
			if a.record.Snapshot.ControllerFence != before.ControllerFence {
				t.Fatal("recovery changed the execution or connection fence")
			}
			// Select the database's committed response separately from the relay's
			// observed transaction result. Unknown completion must not publish its draft.
			f.SelectGrantWrite(t)
			f.SelectSessionWrite(t)
			if !f.writes.Disconnected {
				t.Fatal("recovery did not revoke the durable connection")
			}
			f.data.Session.ConnectionExpiry = nil
			f.writes.Disconnected = false
			outcome := store.TransactionCommitted
			if completion == "unknown commit" {
				outcome = store.TransactionUnknown
			}
			op.Finish(outcome)
			cached := f.s.live[before.SessionID].value
			if cached.Snapshot.ControllerFence != before.ControllerFence || !cached.Synced || !cached.Snapshot.Synchronized || cached.Snapshot.ConnectionState != "connected" {
				t.Fatal("fixture did not retain the old synchronized relay cache")
			}
			if f.data.Session.ConnectionExpiry != nil || f.data.Session.LastSeen == nil || f.s.now().Sub(*f.data.Session.LastSeen) > HeartbeatTimeout {
				t.Fatal("fixture must isolate durable lease revocation from heartbeat expiry")
			}

			for _, lease := range []string{"revoked", "at expiry", "past expiry"} {
				if lease != "revoked" {
					expiry := f.s.now()
					if lease == "past expiry" {
						expiry = expiry.Add(-time.Second)
					}
					f.data.Session.ConnectionExpiry = &expiry
				}
				view := recoveryBrowserSnapshot(t, f, before.SessionID)
				if view.Operations.CanSend || view.ConnectionState != "disconnected" || view.Synchronized {
					t.Fatalf("%s retained input authority: %+v", lease, view)
				}
				fresh := recoveryMessage(before)
				_, err = fixtureSubmit(f, t.Context(), f.p, before, fresh, map[string]int{"SessionOperation": 1})
				botFault(t, err, "session_conflict")
				if f.writes.Operation != nil || f.writes.Session != nil {
					t.Fatal("rejected input wrote an operation or Session")
				}
			}
			f.data.Session.ConnectionExpiry = nil
			readback, err := fixtureSubmit(f, t.Context(), f.p, before, original, map[string]int{"SessionOperation": 1})
			if err != nil || readback != prior || f.writes.Operation != nil {
				t.Fatalf("original operation was reissued after recovery: %+v %v", readback, err)
			}
			readback, err = fixtureOperation(f, t.Context(), before, original.OperationID)
			if err != nil || readback != prior || f.writes.Operation != nil {
				t.Fatalf("original receipt read changed its operation: %+v %v", readback, err)
			}

			hello := sp.ControllerMessage{Type: "hello", ControllerFence: before.ControllerFence, ControllerID: before.Identity.ControllerID, ControllerInstanceID: before.Identity.ControllerInstanceID, Provider: before.Identity.Provider, SchemaVersion: 1, ProjectionVersion: 1, SourceEpoch: *f.data.Session.SourceEpoch, LastAckedSourceSeq: "0"}
			phase := f.GrantPhase(t.Context(), map[string]int{"ConnectSession": 1, "SaveSession": 1})
			connected, err := f.s.Connect(phase, grant.Token, hello, f.s.instance)
			f.dao.FinishContext(phase)
			if err != nil {
				t.Fatal(err)
			}
			f.SelectConnectionWrite(t)
			if connected.ExecutionGeneration != before.ExecutionGeneration || connected.Identity.ControllerInstanceID != before.Identity.ControllerInstanceID || !equalNative(connected.Identity.NativeSessionID, before.Identity.NativeSessionID) || connected.ConnectionEpoch == before.ConnectionEpoch {
				t.Fatal("new authorization replaced native execution or retained old connection epoch")
			}
			if view := recoveryBrowserSnapshot(t, f, before.SessionID); view.Operations.CanSend || view.Synchronized {
				t.Fatal("new connection accepted input before synchronization")
			}
			_, err = fixtureSubmit(f, t.Context(), f.p, connected, recoveryMessage(connected), map[string]int{"SessionOperation": 1})
			botFault(t, err, "controller_offline")
			state := sp.State{NativeSessionID: before.Identity.NativeSessionID, InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
			if _, err = fixtureHandle(f, t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: connected.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}, map[string]int{"UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1}); err != nil {
				t.Fatal(err)
			}
			f.SelectSessionWrite(t)
			f.SelectTouchWrite(t)
			if view := recoveryBrowserSnapshot(t, f, before.SessionID); !view.Operations.CanSend {
				t.Fatal("newly synchronized authorization did not restore input")
			}
			accepted, err := fixtureSubmit(f, t.Context(), f.p, connected, recoveryMessage(connected), map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
			if err != nil || accepted.State != "accepted" {
				t.Fatalf("new authorized input: %+v %v", accepted, err)
			}
		})
	}
}
