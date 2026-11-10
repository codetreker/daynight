package session

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func terminalAutomationResult(t *testing.T, f fixture, allowed bool) {
	t.Helper()
	f.dao.TerminalAutomationAllowedFn = func(_ context.Context, id string) (bool, error) {
		if id != f.task {
			t.Errorf("automation permission queried task %q, want %q", id, f.task)
			return false, fmt.Errorf("unexpected automation task %q", id)
		}
		return allowed, nil
	}
}

func recoveryRefusalCounts(kind string) map[string]int {
	switch kind {
	case "offline":
		return map[string]int{}
	case "suspended":
		return map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1}
	default:
		return map[string]int{"TerminalAutomationAllowed": 1}
	}
}

func changedRecoveryRefusalCounts(kind string) map[string]int {
	switch kind {
	case "claim", "consumed-conflict":
		return map[string]int{}
	case "paused":
		return map[string]int{"TerminalAutomationAllowed": 1}
	default:
		return map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1}
	}
}

func terminalRecoveryRead(t *testing.T, f fixture, ctx context.Context, id, recoveryID string) (v2.Message, error) {
	t.Helper()
	return terminalRecordStep(t, f, func() (v2.Message, error) {
		ctx := f.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalAutomationRecovery(ctx, f.p, f.project, f.task, id, recoveryID)
	})
}

func TestTerminalRecoveryReadbackFiltersActionsWithoutChangingAdmissionEvidence(t *testing.T) {
	f, _ := recoveryFixture(t)
	ctx := context.Background()
	publication := v2.ControlState{ConnectionEpoch: "1", ControlEpoch: "1", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	ack := f.worker(t, "1", f.msg("control_state", publication))
	if !reflect.DeepEqual(ack.Payload, publication) {
		t.Fatal("publication acknowledgement changed the original control state", ack)
	}
	state, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, f.message.SessionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	projected := state["control"].(*v2.ControlState)
	expected := publication
	expected.AvailableActions = []string{}
	if !reflect.DeepEqual(*projected, expected) || state["capabilities"].(v2.Capabilities) != (v2.Capabilities{}) {
		t.Fatal("capability projection altered admission evidence", state)
	}
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(ctx)
		return f.s.terminalAccess(ctx, f.p, f.project, f.task, f.message.SessionID, true, func(_ *operationTx, r *terminalRecord, _ task, _ bool) error {
			if !reflect.DeepEqual(*r.Control, publication) {
				t.Fatal("state read rewrote durable control", r.Control)
			}
			return nil
		})
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalRecoveryRequiresAcknowledgedLateNativeIdentityEnrichment(t *testing.T) {
	f := terminalControlSetup(t)
	ctx := context.Background()
	terminalAutomationResult(t, f.fixture, true)
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
	}); err != nil {
		t.Fatal(err)
	}
	native := "late-original-conversation"
	binding := f.binding
	binding.NativeSessionID = &native
	prepare := f.msg("automation_recovery_prepare", v2.AutomationRecoveryPrepare{RecoveryID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: uuid.NewString(), Binding: binding, InitialAssignment: "transport_completed"})
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	}); err == nil {
		t.Fatal("unpublished native identity was accepted for shutdown recovery")
	}
	state, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	ledger := state["ledger"].(v2.GenerationLedger)
	ledger.Runs[0].Binding = binding
	message := f.msg("generation_ledger", ledger)
	ack, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, prepare.SessionID, "1", message)
	})
	if err != nil || !reflect.DeepEqual(ack, message) {
		t.Fatal("enrichment did not acknowledge the exact original ledger", ack, err)
	}
	state, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || !reflect.DeepEqual(state["binding"], binding) || !reflect.DeepEqual(state["ledger"], ledger) || state["connectionEpoch"] != "1" || state["executionGeneration"] != "1" {
		t.Fatal("same-generation enrichment changed the execution fence", state, err)
	}
	for _, kind := range []string{"different-native", "unknown-native", "different-terminal"} {
		t.Run(kind, func(t *testing.T) {
			changed := ledger
			changed.Runs = append([]v2.Run(nil), ledger.Runs...)
			switch kind {
			case "different-native":
				different := "replacement-conversation"
				changed.Runs[0].Binding.NativeSessionID = &different
			case "unknown-native":
				changed.Runs[0].Binding.NativeSessionID = nil
			case "different-terminal":
				changed.Runs[0].Binding.TerminalID = "replacement-terminal"
			}
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, prepare.SessionID, "1", f.msg("generation_ledger", changed))
			}); err == nil {
				t.Fatal("identity replacement was treated as enrichment")
			}
		})
	}
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	}); err != nil {
		t.Fatal("acknowledged original enrichment did not enable clean shutdown preparation", err)
	}
}

func recoveryFixture(t *testing.T) (*terminalControlFixture, v2.Message) {
	t.Helper()
	f := terminalControlSetup(t)
	terminalAutomationResult(t, f.fixture, true)
	native := "original-native-conversation"
	f.binding.NativeSessionID = &native
	err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(context.Background(), true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.terminalAccess(ctx, f.p, f.project, f.task, f.message.SessionID, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
			r.Binding = f.binding
			r.Runs[0].Binding = f.binding
			r.Registration.Capabilities = v2.Capabilities{}
			return saveTerminal(ctx, tx, r)
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(context.Background(), false, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
	}); err != nil {
		t.Fatal(err)
	}
	return f, f.msg("automation_recovery_prepare", v2.AutomationRecoveryPrepare{RecoveryID: uuid.NewString(), ConnectionEpoch: "1", ControlEpoch: "1", ClosingControlEpoch: "2", StopOperationID: uuid.NewString(), Binding: f.binding, InitialAssignment: "transport_completed"})
}

func advanceRecoveryGeneration(t *testing.T, f *terminalControlFixture, prepare v2.Message) v2.Message {
	t.Helper()
	ctx := context.Background()
	p := prepare.Payload.(v2.AutomationRecoveryPrepare)
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2})
		defer f.dao.FinishContext(ctx)
		return f.s.DisconnectTerminal(ctx, f.p, f.project, f.task, f.message.SessionID, f.message.Envelope, "1")
	}); err != nil {
		t.Fatal(err)
	}
	state, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, f.message.SessionID)
	})
	if err != nil {
		t.Fatal(err)
	}
	ledger := state["ledger"].(v2.GenerationLedger)
	stopped := terminalTime(f.now)
	ledger.Runs[0].StoppedAt = &stopped
	ledger.Runs[0].StopProof = &v2.StopProof{RecordID: p.StopOperationID, ExecutionGeneration: "1", Binding: f.binding, BootID: "boot-one", StoppedAt: stopped, Method: "instances_exited", TerminalStopped: true, Processes: []v2.ProcessProof{{Role: "shell", PID: 101, BirthToken: "shell-one", BootID: "boot-one"}, {Role: "agent", PID: 102, BirthToken: "agent-one", BootID: "boot-one"}}}
	binding := f.binding
	binding.InstanceID = "second-instance"
	binding.TerminalID = "second-terminal"
	ledger.Runs = append(ledger.Runs, v2.Run{ExecutionGeneration: "2", Owner: ledger.Runs[0].Owner, Binding: binding, StartedAt: stopped, SegmentIDs: []string{uuid.NewString()}})
	m := f.msg("generation_ledger", ledger)
	m.ExecutionGeneration = "2"
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1, "InvalidateTerminalOperations": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalLedger(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
	}); err != nil {
		t.Fatal(err)
	}
	reg := f.message.Payload.(v2.Registration)
	reg.Mode = "reconnect"
	epoch := "1"
	reg.ConnectionEpoch = &epoch
	reg.Binding = binding
	reg.Capabilities = v2.Capabilities{}
	m.Type = "registration"
	m.Payload = reg
	if _, err := terminalRegistrationStep(t, f.fixture, m.SessionID, func() (v2.Message, error) {
		ctx := f.fixture.TerminalRegistrationPhase(ctx, map[string]int{"LockTerminal": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.RegisterTerminal(ctx, f.p, f.project, f.task, m)
	}); err != nil {
		t.Fatal(err)
	}
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.BindTerminalConnection(ctx, f.p, f.project, f.task, m.SessionID, m.Envelope, "2")
	}); err != nil {
		t.Fatal(err)
	}
	m.Type = "automation_recovery"
	m.Payload = v2.AutomationRecovery{RecoveryID: p.RecoveryID, ConnectionEpoch: "2", ControlEpoch: "5", PreviousGeneration: "1", StopOperationID: p.StopOperationID, Binding: binding}
	return m
}

func TestTerminalRecoveryRequiresPreparedCleanShutdownAndOriginalStoppedConversation(t *testing.T) {
	f, prepare := recoveryFixture(t)
	ctx := context.Background()
	ack, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	})
	if err != nil {
		t.Fatal(err)
	}
	if ack.Payload.(v2.AutomationRecoveryState).Consumed != nil {
		t.Fatal("preparation consumed recovery")
	}
	state, err := terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || state["control"].(*v2.ControlState).State != "closing" {
		t.Fatal(state, err)
	}
	id := prepare.Payload.(v2.AutomationRecoveryPrepare).RecoveryID
	read, err := terminalRecoveryRead(t, f.fixture, ctx, prepare.SessionID, id)
	if err != nil || string(encode(read)) != string(encode(ack)) {
		t.Fatal(read, err)
	}
	consume := advanceRecoveryGeneration(t, f, prepare)
	state, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || state["control"].(*v2.ControlState).State != "suspended" {
		t.Fatal(state, err)
	}
	ordinary := consume
	ordinary.Type = "control_state"
	ordinary.Payload = v2.ControlState{ConnectionEpoch: "2", ControlEpoch: "5", State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
	if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.HandleTerminalControl(ctx, f.p, f.project, f.task, prepare.SessionID, "2", ordinary)
	}); err == nil {
		t.Fatal("ordinary publication bypassed prepared recovery")
	}
	ack, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "2", consume)
	})
	if err != nil {
		t.Fatal(err)
	}
	if ack.Payload.(v2.AutomationRecoveryState).Consumed == nil {
		t.Fatal("missing consumption")
	}
	state, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || state["control"].(*v2.ControlState).State != "automation" {
		t.Fatal(state, err)
	}
	if state["capabilities"].(v2.Capabilities) != (v2.Capabilities{}) {
		t.Fatal("recovery enabled product control")
	}
	if err = terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"InvalidateTerminalOperations": 1, "SaveTerminal": 2})
		defer f.dao.FinishContext(ctx)
		return f.s.DisconnectTerminal(ctx, f.p, f.project, f.task, consume.SessionID, consume.Envelope, "2")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err = terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "2", consume)
	}); err != nil {
		t.Fatal("exact historical receipt should remain observable", err)
	}
	state, err = terminalStateStep(t, f.fixture, func() (map[string]any, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"ExpireTerminalOperations": 1, "TerminalArchive": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.TerminalState(ctx, f.p, f.project, f.task, prepare.SessionID)
	})
	if err != nil || state["control"].(*v2.ControlState).State != "suspended" {
		t.Fatal("duplicate consume restored input", state, err)
	}
}

func TestTerminalRecoveryRejectsUnsafePreparation(t *testing.T) {
	for _, kind := range []string{"manual", "suspended", "unknown", "offline", "paused", "permission"} {
		t.Run(kind, func(t *testing.T) {
			f, m := recoveryFixture(t)
			ctx := context.Background()
			if kind == "paused" || kind == "permission" {
				terminalAutomationResult(t, f.fixture, false)
			}
			if err := terminalErrorStep(t, f.fixture, func() error {
				ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.terminalAccess(ctx, f.p, f.project, f.task, m.SessionID, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
					switch kind {
					case "manual":
						r.Control.State = "manual"
						r.Control.Lease = &v2.Lease{}
					case "suspended":
						r.Control.State = "suspended"
					case "unknown":
						r.Control.InitialAssignment = "unknown"
					case "offline":
						r.LastSeen = nil
					}
					return saveTerminal(ctx, tx, r)
				})
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				ctx := f.fixture.TerminalPhase(ctx, true, recoveryRefusalCounts(kind))
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, m.SessionID, "1", m)
			}); err == nil {
				t.Fatal("unsafe recovery prepared")
			}
		})
	}
}

func TestTerminalRecoveryRejectsChangedProofAuthorityAndTargets(t *testing.T) {
	for _, kind := range []string{"missing-permit", "stop-proof", "native", "binding", "control-epoch", "paused", "claim", "consumed-conflict"} {
		t.Run(kind, func(t *testing.T) {
			f, prepare := recoveryFixture(t)
			ctx := context.Background()
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
			}); err != nil {
				t.Fatal(err)
			}
			consume := advanceRecoveryGeneration(t, f, prepare)
			in := consume.Payload.(v2.AutomationRecovery)
			switch kind {
			case "missing-permit":
				in.RecoveryID = uuid.NewString()
			case "stop-proof":
				in.StopOperationID = uuid.NewString()
			case "native":
				different := "different-conversation"
				in.Binding.NativeSessionID = &different
			case "binding":
				in.Binding.TerminalID = "wrong-terminal"
			case "control-epoch":
				in.ControlEpoch = "1"
			case "paused":
				terminalAutomationResult(t, f.fixture, false)
			case "claim":
				f.data.Task.Status = "done"
			case "consumed-conflict":
				if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
					ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
					defer f.dao.FinishContext(ctx)
					return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, consume.SessionID, "2", consume)
				}); err != nil {
					t.Fatal(err)
				}
				in.ControlEpoch = "6"
			}
			consume.Payload = in
			if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
				ctx := f.fixture.TerminalPhase(ctx, true, changedRecoveryRefusalCounts(kind))
				defer f.dao.FinishContext(ctx)
				return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, consume.SessionID, "2", consume)
			}); err == nil {
				t.Fatal("changed recovery authority accepted")
			}
		})
	}
}

func TestTerminalRecoveryCannotSurviveAUserControlDecision(t *testing.T) {
	f, prepare := recoveryFixture(t)
	ctx := context.Background()
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	}); err != nil {
		t.Fatal(err)
	}
	consume := advanceRecoveryGeneration(t, f, prepare)
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.terminalAccess(ctx, f.p, f.project, f.task, consume.SessionID, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
			r.Registration.Capabilities = v2.Capabilities{Observe: true, Control: true, Archive: true}
			r.Control.AvailableActions = []string{"acquire_control"}
			r.Recording["2"] = terminalRecording{Responsibility: &v2.RecordingResponsibility{ResponsibilityID: uuid.NewString(), RecordingEnabled: true}}
			return saveTerminal(ctx, tx, r)
		})
	}); err != nil {
		t.Fatal(err)
	}
	request := consume
	request.Type = "control_request"
	request.Payload = v2.ControlRequest{OperationID: uuid.NewString(), ConnectionEpoch: "2", ControlEpoch: "3", Action: "acquire_control", BrowserClientID: f.browser}
	f.operations.expect(request.Payload.(v2.ControlRequest).OperationID)
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalOperation": 1, "ExpireTerminalOperations": 1, "TerminalInputPending": 1, "InsertTerminalOperation": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.SubmitTerminal(ctx, f.p, f.project, f.task, consume.SessionID, f.browser, request)
	}); err != nil {
		t.Fatal(err)
	}
	f.operations.insertedInput(request.Payload.(v2.ControlRequest).OperationID)
	f.operations.pending = true
	f.operations.viewerPending = true
	if err := terminalErrorStep(t, f.fixture, func() error {
		ctx := f.fixture.TerminalPhase(ctx, false, map[string]int{"TerminalViewerOperationPending": 1, "InvalidateTerminalOperations": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.DisconnectTerminalViewer(ctx, f.p, f.project, f.task, consume.SessionID, f.browser, consume.ClaimID, "2")
	}); err != nil {
		t.Fatal(err)
	}
	f.operations.pending = false
	f.operations.viewerPending = false
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, consume.SessionID, "2", consume)
	}); err == nil {
		t.Fatal("a user decision was bypassed using the old shutdown permit")
	}
}

func TestTerminalRecoveryPreparationIdentityAndReceiptAreImmutable(t *testing.T) {
	f, prepare := recoveryFixture(t)
	ctx := context.Background()
	first, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{"TerminalAutomationAllowed": 1, "TerminalInputPending": 1, "SaveTerminal": 1})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	})
	if err != nil || string(encode(first)) != string(encode(second)) {
		t.Fatal(second, err)
	}
	in := prepare.Payload.(v2.AutomationRecoveryPrepare)
	in.StopOperationID = uuid.NewString()
	prepare.Payload = in
	if _, err := terminalRecordStep(t, f.fixture, func() (v2.Message, error) {
		ctx := f.fixture.TerminalPhase(ctx, true, map[string]int{})
		defer f.dao.FinishContext(ctx)
		return f.s.UpdateTerminalRecovery(ctx, f.p, f.project, f.task, prepare.SessionID, "1", prepare)
	}); err == nil {
		t.Fatal("preparation identity reused")
	}
	if _, err := terminalRecoveryRead(t, f.fixture, ctx, prepare.SessionID, uuid.NewString()); err == nil {
		t.Fatal("unknown receipt created")
	}
}
