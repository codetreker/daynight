package sessionrelay

import (
	"context"
	"reflect"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/jackc/pgx/v5"
)

type terminalAutomationRecovery struct {
	State       v2.AutomationRecoveryState
	Invalidated bool
}

func invalidateAutomationRecoveries(r *terminalRecord) {
	for _, permit := range r.AutomationRecoveries {
		if permit.State.Consumed == nil {
			permit.Invalidated = true
		}
	}
}

func automationRecoveryMessage(r *terminalRecord, state v2.AutomationRecoveryState) v2.Message {
	m := terminalEnvelope(r, "automation_recovery_state", state)
	m.ExecutionGeneration = state.SourceGeneration
	if state.Consumed != nil {
		m.ExecutionGeneration = state.Consumed.ExecutionGeneration
	}
	return m
}

// TerminalAutomationRecovery observes the original receipt. A consumed receipt
// identifies its exact new fence; it does not grant rights on a later connection.
func (s *Service) TerminalAutomationRecovery(ctx context.Context, p model.Principal, project, taskID, id, recoveryID string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(_ pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		permit := r.AutomationRecoveries[recoveryID]
		if permit == nil {
			return fault("not_found", "The original automation recovery intent is not registered.")
		}
		out = automationRecoveryMessage(r, permit.State)
		return nil
	})
	return out, err
}

// UpdateTerminalRecovery prepares while the old writer is online and consumes
// only after its recorded stop and exact adjacent native-conversation recovery.
// It never relaxes the separate human handback or combined UI capability gate.
func (s *Service) UpdateTerminalRecovery(ctx context.Context, p model.Principal, project, taskID, id, epoch string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if m.Type != "automation_recovery_prepare" && m.Type != "automation_recovery" {
		return out, conflict()
	}
	if err := validTerminalMessage(m, m.Type); err != nil {
		return out, err
	}
	raw, err := v2.CanonicalJSON(m)
	if err != nil {
		return out, err
	}
	digest := v2.HashBytes(raw)
	err = s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, t task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if m.SessionID != r.Envelope.SessionID || m.ClaimID != r.Envelope.ClaimID {
			return conflict()
		}
		var recoveryID string
		switch payload := m.Payload.(type) {
		case v2.AutomationRecoveryPrepare:
			recoveryID = payload.RecoveryID
		case v2.AutomationRecovery:
			recoveryID = payload.RecoveryID
		}
		permit := r.AutomationRecoveries[recoveryID]
		if permit != nil {
			if m.Type == "automation_recovery_prepare" {
				if permit.State.PrepareDigest != digest {
					return fault("operation_conflict", "The recovery identity has a different preparation.")
				}
				out = automationRecoveryMessage(r, permit.State)
				return nil
			}
			if permit.State.Consumed != nil {
				if permit.State.Consumed.RequestDigest != digest {
					return fault("operation_conflict", "The recovery permission was consumed by another intent.")
				}
				out = automationRecoveryMessage(r, permit.State)
				return nil
			}
		}
		if !terminalActive(t, r) || !terminalFenceMatches(r, m.Envelope) || epoch != r.ConnectionEpoch || r.ChannelEpoch != epoch || !s.terminalOnline(r) {
			return fault("stale_fence", "Automation recovery requires the original active Worker channel.")
		}
		var permitted bool
		if err := tx.QueryRow(ctx, `SELECT allow_agents AND NOT EXISTS(SELECT 1 FROM task_properties WHERE task_id=tasks.id AND name='paused' AND value::jsonb='true'::jsonb) FROM tasks WHERE id=$1 AND deleted_at IS NULL`, taskID).Scan(&permitted); err != nil {
			return err
		}
		if !permitted {
			return denied()
		}
		if r.Control == nil || r.Control.Lease != nil || r.ControlActor != nil || r.Control.InitialAssignment != "transport_completed" || r.Control.UnavailableReason != nil {
			return fault("automation_suspended", "The original input state is not confirmed clean.")
		}
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching'))`, id).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return fault("input_busy", "An original terminal decision is still pending.")
		}
		switch in := m.Payload.(type) {
		case v2.AutomationRecoveryPrepare:
			if r.Control.State != "automation" || in.ConnectionEpoch != epoch || in.ControlEpoch != r.ControlEpoch || !reflect.DeepEqual(in.Binding, r.Binding) || len(r.Runs) == 0 || r.Runs[len(r.Runs)-1].StoppedAt != nil || len(r.Runs[len(r.Runs)-1].SegmentIDs) == 0 {
				return fault("automation_suspended", "Only the original clean automatic run may prepare shutdown recovery.")
			}
			if len(r.AutomationRecoveries) >= v2.MaxRuns {
				return fault("rate_limited", "The Session recovery ledger is full.")
			}
			for _, previous := range r.AutomationRecoveries {
				if previous.State.SourceGeneration == m.ExecutionGeneration {
					return conflict()
				}
			}
			state := v2.AutomationRecoveryState{RecoveryID: in.RecoveryID, PrepareDigest: digest, SourceGeneration: m.ExecutionGeneration, SourceConnectionEpoch: epoch, SourceControlEpoch: in.ControlEpoch, ClosingControlEpoch: in.ClosingControlEpoch, StopOperationID: in.StopOperationID, NativeSessionID: *in.Binding.NativeSessionID}
			if r.AutomationRecoveries == nil {
				r.AutomationRecoveries = map[string]*terminalAutomationRecovery{}
			}
			r.AutomationRecoveries[in.RecoveryID] = &terminalAutomationRecovery{State: state}
			r.ControlEpoch = in.ClosingControlEpoch
			r.Control = &v2.ControlState{ConnectionEpoch: epoch, ControlEpoch: in.ClosingControlEpoch, State: "closing", InitialAssignment: "transport_completed", AvailableActions: []string{}}
			r.LastLeaseSeq = "0"
			out = automationRecoveryMessage(r, state)
		case v2.AutomationRecovery:
			if permit == nil || permit.Invalidated {
				return fault("automation_suspended", "There is no original clean shutdown permission.")
			}
			state := permit.State
			if in.ConnectionEpoch != epoch || number(epoch) <= number(state.SourceConnectionEpoch) || in.PreviousGeneration != state.SourceGeneration || in.StopOperationID != state.StopOperationID || number(in.ControlEpoch) <= number(r.ControlEpoch) || number(in.ControlEpoch) <= number(state.ClosingControlEpoch) || r.Control.State != "suspended" || !reflect.DeepEqual(in.Binding, r.Binding) || *in.Binding.NativeSessionID != state.NativeSessionID || len(r.Runs) < 2 {
				return conflict()
			}
			previous := r.Runs[len(r.Runs)-2]
			current := r.Runs[len(r.Runs)-1]
			if previous.ExecutionGeneration != state.SourceGeneration || previous.StopProof == nil || previous.StopProof.NativeLaunch != "" || previous.StopProof.RecordID != state.StopOperationID || previous.StopProof.Binding.NativeSessionID == nil || *previous.StopProof.Binding.NativeSessionID != state.NativeSessionID || current.ExecutionGeneration != m.ExecutionGeneration || current.StoppedAt != nil || len(current.SegmentIDs) == 0 {
				return fault("stop_unknown", "The recovery does not prove the original run stopped and resumed.")
			}
			state.Consumed = &v2.AutomationRecoveryConsumption{ExecutionGeneration: m.ExecutionGeneration, ConnectionEpoch: epoch, ControlEpoch: in.ControlEpoch, RequestDigest: digest}
			permit.State = state
			r.ControlEpoch = in.ControlEpoch
			r.Control = &v2.ControlState{ConnectionEpoch: epoch, ControlEpoch: in.ControlEpoch, State: "automation", InitialAssignment: "transport_completed", AvailableActions: []string{"acquire_control"}}
			r.LastLeaseSeq = "0"
			out = automationRecoveryMessage(r, state)
		}
		return saveTerminal(ctx, tx, r)
	})
	return out, err
}
