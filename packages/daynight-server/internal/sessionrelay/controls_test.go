package sessionrelay

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func nativeControls() *sp.Controls {
	value := "native"
	return &sp.Controls{Revision: "1", Settings: []sp.Setting{{ID: "model", Category: "model", Label: "Model", Value: &value, Options: []sp.SettingOption{{Value: "native", Label: "Native"}, {Value: "next", Label: "Next"}}, Mutable: true, Scope: "session"}}, Commands: []sp.NativeCommand{{ID: "compact", Name: "compact", Description: "Compact context", Available: true}}}
}
func controlCommand(v sp.Snapshot, kind string) sp.Command {
	var payload any
	switch kind {
	case "update_setting":
		payload = sp.UpdateSetting{SettingID: "model", Value: "next", ExpectedControlsRevision: "1"}
	case "execute_command":
		payload = sp.ExecuteCommand{CommandID: "compact", ExpectedControlsRevision: "1"}
	default:
		payload = map[string]any{}
	}
	return sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "controls", OperationID: uuid.NewString(), Kind: kind, Payload: encode(payload)}
}
func controlState() sp.State {
	s := idleState()
	s.Controls = nativeControls()
	started := "2026-10-28T05:00:00.000Z"
	s.TurnStartedAt = &started
	return s
}

func TestControlsPermissionProjectionDoesNotMutateCatalog(t *testing.T) {
	now := time.Now()
	native := "native"
	original := sp.Snapshot{Controls: nativeControls(), Lifecycle: "active", ConnectionState: "connected", Synchronized: true, Identity: sp.Identity{NativeSessionID: &native}, InitialInputState: "confirmed", Activity: "idle"}
	for _, test := range []struct {
		name   string
		write  bool
		mutate func(*record)
	}{
		{"reader", false, func(*record) {}},
		{"disconnected", true, func(r *record) { r.LastSeen = nil }},
		{"stale heartbeat", true, func(r *record) { old := now.Add(-HeartbeatTimeout - time.Second); r.LastSeen = &old }},
		{"syncing", true, func(r *record) { r.Snapshot.Synchronized = false }},
		{"draining", true, func(r *record) { r.Snapshot.Lifecycle = "draining" }},
		{"archived", true, func(r *record) { r.Snapshot.Lifecycle = "archived" }},
		{"initializing", true, func(r *record) { r.Snapshot.Activity = "initializing" }},
		{"stopped", true, func(r *record) { r.Snapshot.Activity = "stopped" }},
		{"unknown", true, func(r *record) { r.Snapshot.Activity = "unknown" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := record{Snapshot: original, LastSeen: &now}
			test.mutate(&r)
			view := permissions(&r, test.write, now)
			if view.Controls.Settings[0].Mutable || view.Controls.Commands[0].Available {
				t.Fatal("unavailable controls enabled")
			}
			if !r.Snapshot.Controls.Settings[0].Mutable || !r.Snapshot.Controls.Commands[0].Available {
				t.Fatal("projection mutated persisted catalog")
			}
			if view.Controls.Settings[0].Value == nil || *view.Controls.Settings[0].Value != "native" {
				t.Fatal("read lost confirmed value")
			}
		})
	}
	view := permissions(&record{Snapshot: original, LastSeen: &now}, true, now)
	if !view.Controls.Settings[0].Mutable || !view.Controls.Commands[0].Available {
		t.Fatal("owner controls disabled")
	}
}

func TestDurableControlOperationKinds(t *testing.T) {
	for _, kind := range []string{"update_setting", "execute_command", "refresh_controls"} {
		t.Run(kind, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			state := controlState()
			publishState(t, f, v, state)
			current, err := f.s.Current(ctx, f.p, f.project, f.task)
			if err != nil {
				t.Fatal(err)
			}
			raw := encode(current)
			if !json.Valid(raw) {
				t.Fatal("invalid current")
			}
			var response struct {
				Session sp.Snapshot `json:"session"`
			}
			if json.Unmarshal(raw, &response) != nil || response.Session.Controls == nil || response.Session.TurnStartedAt == nil {
				t.Fatal("controller controls or turn start lost")
			}
			c := controlCommand(v, kind)
			receipt, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c)
			if err != nil || receipt.State != "accepted" {
				t.Fatal(receipt, err)
			}
			if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
				t.Fatal("stable intent replay rejected", err)
			}
			conflict := c
			conflict.Payload = encode(map[string]any{"changed": true})
			if _, err = f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, conflict); err == nil {
				t.Fatal("different intent reused operation ID")
			}
			offers, err := f.s.Poll(ctx, v.ControllerFence)
			if err != nil || len(offers) != 1 {
				t.Fatal(offers, err)
			}
			if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: c.OperationID}); err != nil {
				t.Fatal(err)
			}
			receipt.State = "confirmed"
			if _, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err != nil {
				t.Fatal(err)
			}
			got, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, c.OperationID)
			if err != nil || got.State != "confirmed" || got.Kind != kind {
				t.Fatal(got, err)
			}
		})
	}
}

func TestControlAuthorizationRejectsCatalogAndRuntimeMismatch(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	base := controlState()
	publishState(t, f, v, base)
	cases := []struct {
		name, kind string
		payload    any
		mutate     func(*sp.State)
	}{
		{"stale settings revision", "update_setting", sp.UpdateSetting{SettingID: "model", Value: "next", ExpectedControlsRevision: "2"}, nil},
		{"unknown setting", "update_setting", sp.UpdateSetting{SettingID: "unknown", Value: "next", ExpectedControlsRevision: "1"}, nil},
		{"unknown option", "update_setting", sp.UpdateSetting{SettingID: "model", Value: "unknown", ExpectedControlsRevision: "1"}, nil},
		{"immutable setting", "update_setting", nil, func(s *sp.State) { s.Controls.Settings[0].Mutable = false }},
		{"missing controls", "update_setting", nil, func(s *sp.State) { s.Controls = nil }},
		{"stale command revision", "execute_command", sp.ExecuteCommand{CommandID: "compact", ExpectedControlsRevision: "2"}, nil},
		{"unknown command", "execute_command", sp.ExecuteCommand{CommandID: "unknown", ExpectedControlsRevision: "1"}, nil},
		{"unavailable command", "execute_command", nil, func(s *sp.State) { s.Controls.Commands[0].Available = false }},
		{"working command", "execute_command", nil, func(s *sp.State) { turn := "turn"; s.Activity = "working"; s.CurrentTurnID = &turn }},
		{"stale turn", "execute_command", sp.ExecuteCommand{CommandID: "compact", ExpectedControlsRevision: "1", ExpectedTurnID: func() *string { s := "turn"; return &s }()}, nil},
		{"unsynchronized refresh", "refresh_controls", nil, func(s *sp.State) { s.Synchronized = false }},
		{"unexpected command args", "execute_command", sp.ExecuteCommand{CommandID: "compact", Arguments: "not supported", ExpectedControlsRevision: "1"}, nil},
		{"initial setting gate", "update_setting", nil, func(s *sp.State) { s.InitialInputState = "not_submitted" }},
		{"initial command gate", "execute_command", nil, func(s *sp.State) { s.InitialInputState = "not_submitted" }},
		{"old controller refresh", "refresh_controls", nil, func(s *sp.State) { s.Controls = nil }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, v := connectFixture(t)
			state := controlState()
			if tc.mutate != nil {
				tc.mutate(&state)
			}
			publishState(t, f, v, state)
			c := controlCommand(v, tc.kind)
			if tc.payload != nil {
				c.Payload = encode(tc.payload)
			}
			if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
				t.Fatal("unauthorized control accepted")
			}
		})
	}
	publishState(t, f, v, controlState())
	c := controlCommand(v, "update_setting")
	outsider := core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	if _, err := f.s.Submit(ctx, outsider, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("outsider submitted control")
	}
}

func TestControlRevisionRecheckedAtOfferAndDispatch(t *testing.T) {
	for _, phase := range []string{"offer", "begin"} {
		t.Run(phase, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			state := controlState()
			publishState(t, f, v, state)
			c := controlCommand(v, "update_setting")
			if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
				t.Fatal(err)
			}
			if phase == "begin" {
				if offers, err := f.s.Poll(ctx, v.ControllerFence); err != nil || len(offers) != 1 {
					t.Fatal(offers, err)
				}
			}
			state.Controls.Revision = "2"
			publishState(t, f, v, state)
			if phase == "offer" {
				if offers, err := f.s.Poll(ctx, v.ControllerFence); err != nil || len(offers) != 0 {
					t.Fatal(offers, err)
				}
				got, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, c.OperationID)
				if err != nil || got.State != "rejected" {
					t.Fatal(got, err)
				}
			} else {
				assertRejectedBegin(t, f, v, c.OperationID)
			}
		})
	}
}

func TestControlCatalogRevisionAndExecutionBoundary(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	state := controlState()
	publishState(t, f, v, state)
	state.Controls.Revision = "2"
	publishState(t, f, v, state)
	state.Controls.Revision = "1"
	if _, err := f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "state", Payload: encode(state)})); err == nil {
		t.Fatal("control revision regressed")
	}
	state.Controls.Revision = "2"
	state.Controls.Settings[0].Mutable = false
	if _, err := f.s.Handle(ctx, source(t, f, v, sp.SourceEvent{Kind: "state", Payload: encode(state)})); err == nil {
		t.Fatal("same revision changed content")
	}
	state.Controls.Revision = "3"
	publishState(t, f, v, state)
	publishState(t, f, v, state)
	previous := "1"
	_, err := f.s.Grant(ctx, f.p, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: uuid.NewString(), ExecutionGeneration: "2", Kind: "reconnect", PreviousGeneration: &previous, StopProof: &sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.r.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}})
	if err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	snapshot, err := sp.DecodeSnapshot(raw)
	if err != nil || snapshot.Controls != nil || snapshot.TurnStartedAt != nil {
		t.Fatal("new execution retained obsolete controls", err)
	}
}

func TestControlsBeforeFirstLazyTestSessionInput(t *testing.T) {
	f, v, _ := testSession(t, "none")
	ctx := context.Background()
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	publishState(t, f, v, state)
	refresh := controlCommand(v, "refresh_controls")
	if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, refresh); err != nil {
		t.Fatal("initial catalog refresh rejected", err)
	}
	for _, kind := range []string{"update_setting", "execute_command"} {
		if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, controlCommand(v, kind)); err == nil {
			t.Fatal("absent catalog accepted", kind)
		}
	}
	state.Controls = nativeControls()
	publishState(t, f, v, state)
	for _, kind := range []string{"update_setting", "execute_command"} {
		if _, err := f.s.Submit(ctx, f.p, "", "", v.SessionID, controlCommand(v, kind)); err != nil {
			t.Fatal("lazy provider controls rejected", kind, err)
		}
	}
}

func TestControlReaderProjectionAndRevokedWriterAtDispatch(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, controlState())
	reader := addMember(t, f, "member")
	admin := addMember(t, f, "admin")
	current, err := f.s.Current(ctx, reader, f.project, f.task)
	if err != nil {
		t.Fatal(err)
	}
	view := current["session"].(sp.Snapshot)
	if view.Controls.Settings[0].Mutable || view.Controls.Commands[0].Available {
		t.Fatal("reader got writable catalog")
	}
	initial, _, cursor, err := f.s.BrowserPoll(ctx, reader, f.project, f.task, v.SessionID, "")
	if err != nil {
		t.Fatal(err)
	}
	publishState(t, f, v, controlState())
	_, events, _, err := f.s.BrowserPoll(ctx, reader, f.project, f.task, v.SessionID, cursor)
	if err != nil || len(events) == 0 {
		t.Fatal("history snapshot unavailable", err)
	}
	for _, event := range events {
		if event["kind"] == "snapshot" {
			snapshot, err := sp.DecodeSnapshot(encode(event["payload"]))
			if err != nil || snapshot.Controls.Settings[0].Mutable || snapshot.Controls.Commands[0].Available {
				t.Fatal("historical snapshot leaked writable controls", err)
			}
		}
	}
	if initial.Controls.Settings[0].Mutable {
		t.Fatal("poll initial controls writable")
	}
	for _, kind := range []string{"update_setting", "execute_command", "refresh_controls"} {
		if _, err := f.s.Submit(ctx, reader, f.project, f.task, v.SessionID, controlCommand(v, kind)); err == nil {
			t.Fatal("reader submitted", kind)
		}
	}
	c := controlCommand(v, "execute_command")
	if _, err := f.s.Submit(ctx, admin, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE project_members SET role='member' WHERE project_id=$1 AND user_id=$2`, f.project, admin.UserID); err != nil {
		t.Fatal(err)
	}
	assertRejectedBegin(t, f, v, c.OperationID)
}

func TestControlCommandAcceptsAdvertisedArguments(t *testing.T) {
	f, v := connectFixture(t)
	state := controlState()
	hint := "instructions"
	state.Controls.Commands[0].ArgumentHint = &hint
	publishState(t, f, v, state)
	c := controlCommand(v, "execute_command")
	c.Payload = encode(sp.ExecuteCommand{CommandID: "compact", Arguments: "keep essential decisions", ExpectedControlsRevision: "1"})
	if _, err := f.s.Submit(context.Background(), f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal("advertised command arguments rejected", err)
	}
}

func TestControlsRejectUnavailableNativeActivities(t *testing.T) {
	for _, activity := range []string{"initializing", "stopped", "unknown"} {
		t.Run(activity, func(t *testing.T) {
			f, v := connectFixture(t)
			state := controlState()
			state.Activity = activity
			publishState(t, f, v, state)
			for _, kind := range []string{"update_setting", "execute_command", "refresh_controls"} {
				if _, err := f.s.Submit(context.Background(), f.p, f.project, f.task, v.SessionID, controlCommand(v, kind)); err == nil {
					t.Fatal("unavailable activity accepted control", activity, kind)
				}
			}
		})
	}
}

func TestControlActivityRecheckedAtDispatch(t *testing.T) {
	for _, kind := range []string{"update_setting", "execute_command", "refresh_controls"} {
		t.Run(kind, func(t *testing.T) {
			f, v := connectFixture(t)
			ctx := context.Background()
			state := controlState()
			publishState(t, f, v, state)
			c := controlCommand(v, kind)
			if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
				t.Fatal(err)
			}
			if offers, err := f.s.Poll(ctx, v.ControllerFence); err != nil || len(offers) != 1 {
				t.Fatal(offers, err)
			}
			state.Activity = "unknown"
			publishState(t, f, v, state)
			assertRejectedBegin(t, f, v, c.OperationID)
		})
	}
}

func assertRejectedBegin(t *testing.T, f fixture, v sp.Snapshot, id string) {
	t.Helper()
	reply, err := f.s.Handle(context.Background(), sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: id})
	if err != nil || reply["type"] != "receipt_ack" {
		t.Fatal("stale operation closed channel", reply, err)
	}
	operation, ok := reply["operation"].(sp.Operation)
	if !ok || operation.OperationID != id || operation.State != "rejected" {
		t.Fatal("stale operation was authorized", reply)
	}
	stored, err := f.s.Operation(context.Background(), f.p, f.project, f.task, v.SessionID, id)
	if err != nil || stored.State != "rejected" {
		t.Fatal("rejection not durable", stored, err)
	}
}
