package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestOnlineModeBindingAndReconnect(t *testing.T) {
	for _, tc := range []struct {
		name            string
		opted, taskBody bool
		mode, policy    string
	}{
		{"legacy client", false, false, "legacy", "legacy"},
		{"legacy task body", false, true, "legacy", "task_body"},
		{"relay legacy history", true, false, "relay", "legacy"},
		{"relay task body", true, true, "relay", "task_body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := setup(t)
			ctx := context.Background()
			regCtx := f.RegistrationPhase(ctx, map[string]int{"InsertTaskSession": 1})
			v, err := f.s.Register(regCtx, f.p, f.project, f.task, f.r)
			f.dao.FinishContext(regCtx)
			if err != nil {
				t.Fatal(err)
			}
			f.SelectRegistrationWrite(t)
			grantCtx := f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
			g, err := f.s.Grant(grantCtx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
			f.dao.FinishContext(grantCtx)
			if err != nil {
				t.Fatal(err)
			}
			f.SelectGrantWrite(t)
			f.SelectSessionWrite(t)
			hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
			phase := f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1})
			result, err := f.s.connectOnline(phase, g.Token, hello, uuid.NewString(), 0, tc.opted, tc.taskBody)
			f.dao.FinishContext(phase)
			if err != nil || result.OnlineMode != tc.mode || onlineTestPolicy(result.HistoryContentPolicy) != tc.policy {
				t.Fatalf("binding = %+v, %v", result, err)
			}
			if f.writes.Session.OnlineMode != tc.mode {
				t.Fatal("mode not included in transaction")
			}
			if f.writes.Session.HistoryContentPolicy == nil || *f.writes.Session.HistoryContentPolicy != tc.policy {
				t.Fatal("policy not included in transaction")
			}
			f.SelectConnectionWrite(t)
			// A lost welcome does not renegotiate the choice on a fresh grant.
			v = result.Snapshot
			grantCtx = f.BrowserPhase(ctx, map[string]int{"SetSessionGrant": 1, "SaveSession": 1})
			g, err = f.s.Grant(grantCtx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "reconnect"})
			f.dao.FinishContext(grantCtx)
			if err != nil {
				t.Fatal(err)
			}
			f.SelectGrantWrite(t)
			f.SelectSessionWrite(t)
			if tc.mode == "relay" {
				phase = f.GrantPhase(ctx, nil)
				_, err = f.s.connectOnline(phase, g.Token, hello, uuid.NewString(), 0, false, false)
				f.dao.FinishContext(phase)
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "upgrade_required" {
					t.Fatalf("old client: %v", err)
				}
				if tc.taskBody {
					phase = f.GrantPhase(ctx, nil)
					_, err = f.s.connectOnline(phase, g.Token, hello, uuid.NewString(), 0, true, false)
					f.dao.FinishContext(phase)
					if !errors.As(err, &fault) || fault.Code != "upgrade_required" {
						t.Fatalf("missing policy: %v", err)
					}
				}
			}
			phase = f.GrantPhase(ctx, map[string]int{"ConnectSession": 1, "SaveSession": 1})
			result, err = f.s.connectOnline(phase, g.Token, hello, uuid.NewString(), 0, true, true)
			f.dao.FinishContext(phase)
			if err != nil || result.OnlineMode != tc.mode || onlineTestPolicy(result.HistoryContentPolicy) != tc.policy {
				t.Fatalf("reconnect = %+v, %v", result, err)
			}
		})
	}
}

func TestRelayRefusesActiveHistoryWithoutCreatingBundle(t *testing.T) {
	op, dao, r, writer := activeHistoryFixture(t)
	r.OnlineMode = "relay"
	id := uuid.NewString()
	body := activeHistoryBytes(r, localEntry(t, "1"))
	for _, action := range []func() error{
		func() error {
			_, err := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
			return err
		},
		func() error { _, err := op.HistoryLedgerStatus(t.Context(), writer, id); return err },
	} {
		var fault *model.Fault
		if err := action(); !errors.As(err, &fault) || fault.Code != "component_unsupported" {
			t.Fatalf("ledger refusal: %v", err)
		}
		if dao.bundle != nil {
			t.Fatal("relay created an active bundle")
		}
	}
}

func TestUnknownStoredOnlineModeFailsClosed(t *testing.T) {
	f, v := connectFixture(t)
	f.data.Session.OnlineMode = "unknown"
	phase := f.ControllerPhase(t.Context(), map[string]int{"LockCredential": 0, "ProjectAccess": 0})
	defer f.dao.FinishContext(phase)
	_, err := f.s.Handle(phase, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence})
	if err == nil {
		t.Fatal("unknown stored mode was accepted")
	}
}

func onlineTestPolicy(policy *string) string {
	if policy == nil {
		return ""
	}
	return *policy
}

func TestRelayModeSurvivesGenerationHandoff(t *testing.T) {
	f, v := connectFixture(t)
	policy := "task_body"
	f.data.Session.OnlineMode = "relay"
	f.data.Session.HistoryContentPolicy = &policy
	previous := v.ExecutionGeneration
	nextInstance := uuid.NewString()
	grant := sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: nextInstance, ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.r.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	g, err := failureGrant(f, t.Context(), f.p, f.project, f.task, v.SessionID, grant, map[string]int{"SetSessionGenerationStop": 1, "SetSessionGrant": 1, "SaveSession": 1})
	if err != nil {
		t.Fatal(err)
	}
	f.data.Session.StopProof = append([]byte(nil), f.writes.StopProof...)
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: v.SessionID, ClaimID: v.ClaimID, ExecutionGeneration: "2"}}, ControllerID: f.r.ControllerID, ControllerInstanceID: nextInstance, Provider: "codex", SourceEpoch: *f.data.Session.SourceEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	phase := f.GrantPhase(t.Context(), map[string]int{"ConnectSession": 1, "SaveSession": 1})
	result, err := f.s.ConnectWithOnlineMode(phase, g.Token, hello, uuid.NewString(), 0, true, true)
	f.dao.FinishContext(phase)
	if err != nil || result.OnlineMode != "relay" || onlineTestPolicy(result.HistoryContentPolicy) != policy {
		t.Fatalf("takeover: %+v %v", result, err)
	}
}
