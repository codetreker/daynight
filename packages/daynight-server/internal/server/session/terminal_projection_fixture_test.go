package session_test

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type terminalProjection struct {
	Record      *terminalRouteRecord
	RuntimeSeen bool
	Evidence    *terminalRouteEvidence
	Result      *v2.OperationResult
	Submit      *terminalSubmitProjection
}

type terminalSubmitProjection struct {
	Message v2.Message
	Actor   model.Principal
	Seq     int64
}

func terminalProjectionInput(t *testing.T, input terminalRouteInput, message v2.Message) (terminalRouteRecord, v2.Message) {
	t.Helper()
	decoded, err := v2.DecodeMessage([]byte(jsonBody(t, message)))
	if err != nil {
		t.Fatal("terminal projection requires a valid protocol message", err)
	}
	record := terminalDecodeRecord(t, input.Raw)
	if record.Envelope.SessionID != input.Session || record.Owner.ProjectID != input.Project || record.Owner.TaskID != input.Task {
		t.Fatal("terminal projection input has a different Session or Task scope")
	}
	return record, decoded
}

func terminalMessageProjection(t *testing.T, input terminalRouteInput, message v2.Message) terminalProjection {
	t.Helper()
	record, decoded := terminalProjectionInput(t, input, message)
	message = decoded
	projection := terminalProjection{Record: &record}
	switch payload := message.Payload.(type) {
	case v2.Registration:
		if payload.Mode != "reconnect" || payload.ConnectionEpoch == nil || *payload.ConnectionEpoch != "1" || record.ConnectionEpoch != "1" {
			t.Fatal("reconnect projection requires the original connection epoch")
		}
		record.Binding = payload.Binding
		record.Registration = payload
		record.RegistrationDigest = v2.HashBytes([]byte(jsonBody(t, message)))
		record.ConnectionEpoch = "2"
		record.RegistrationEpoch = "2"
		terminalSuspend(&record)
		projection.RuntimeSeen = true
	case v2.GenerationLedger:
		if len(payload.Runs) == 0 {
			t.Fatal("ledger projection requires a supplied run")
		}
		if record.Envelope.ExecutionGeneration != message.ExecutionGeneration {
			terminalSuspend(&record)
			record.LastSeen = nil
		}
		record.Runs = payload.Runs
		record.Binding = payload.Runs[len(payload.Runs)-1].Binding
		record.Envelope.ExecutionGeneration = message.ExecutionGeneration
	case v2.RecordingResponsibility:
		if record.Recording == nil {
			t.Fatal("recording projection requires an explicit recording map")
		}
		recording := record.Recording[message.ExecutionGeneration]
		recording.Responsibility = &payload
		record.Recording[message.ExecutionGeneration] = recording
	case v2.RecordingEvidence:
		if record.Recording == nil {
			t.Fatal("evidence projection requires an explicit recording map")
		}
		recording, exists := record.Recording[message.ExecutionGeneration]
		if !exists || recording.Responsibility == nil {
			t.Fatal("evidence projection requires a supplied recording responsibility")
		}
		recording.Evidence = &payload
		record.Recording[message.ExecutionGeneration] = recording
		canonical, err := v2.CanonicalJSON(message)
		if err != nil {
			t.Fatal(err)
		}
		projection.Evidence = &terminalRouteEvidence{Generation: mustTerminalNumber(t, message.ExecutionGeneration), ID: payload.EvidenceID, Hash: v2.HashBytes(canonical), Revision: payload.Revision}
	case v2.Finalization:
		record.FinalizationID = &payload.FinalizationID
		terminalSuspend(&record)
		record.LastSeen = nil
	case v2.ControlState:
		if payload.Lease != nil && record.ControlActor == nil {
			t.Fatal("a leased control projection requires the supplied lease actor")
		}
		record.Control = &payload
		record.ControlEpoch = payload.ControlEpoch
		if payload.Lease == nil {
			record.ControlActor = nil
			record.LastLeaseSeq = "0"
		}
		projection.RuntimeSeen = true
	case v2.Snapshot:
		if len(record.Runs) == 0 || record.Recording == nil {
			t.Fatal("snapshot projection requires a supplied run and recording map")
		}
		record.LastFrame = json.RawMessage(jsonBody(t, struct{ ExecutionGeneration, SegmentID, FrameSeq, SHA256 string }{message.ExecutionGeneration, payload.SegmentID, payload.Frame.FrameSeq, v2.HashBytes([]byte(jsonBody(t, payload.Frame)))}))
		record.Binding.NativeSessionID = payload.Binding.NativeSessionID
		record.Runs[len(record.Runs)-1].Binding.NativeSessionID = payload.Binding.NativeSessionID
		recording := record.Recording[message.ExecutionGeneration]
		if recording.Responsibility != nil && recording.Responsibility.RecordingEnabled {
			recording.ObservedContent = true
			record.Recording[message.ExecutionGeneration] = recording
		}
		projection.RuntimeSeen = true
	case v2.ControlAck:
		if input.Operation == nil || record.Control == nil {
			t.Fatal("control ACK projection requires a supplied operation and control state")
		}
		actor := input.Operation.Actor
		previous := record.Control.Lease
		record.Control = &payload.ControlState
		record.ControlEpoch = payload.ControlState.ControlEpoch
		if payload.ControlState.Lease != nil {
			record.ControlActor = &actor
		} else {
			record.ControlActor = nil
		}
		if previous == nil || payload.ControlState.Lease == nil || previous.LeaseID != payload.ControlState.Lease.LeaseID {
			record.LastLeaseSeq = "0"
		}
		projection.Result = &payload.Result
	default:
		t.Fatalf("terminal message projection has no declared expectation for %T", payload)
	}
	return projection
}

func terminalControlProjection(t *testing.T, input terminalRouteInput, actor model.Principal, message v2.Message) terminalProjection {
	t.Helper()
	record, decoded := terminalProjectionInput(t, input, message)
	if _, ok := decoded.Payload.(v2.ControlRequest); !ok {
		t.Fatalf("terminal control projection requires a ControlRequest, got %T", decoded.Payload)
	}
	if actor.UserID == "" || actor.CredentialID == "" {
		t.Fatal("terminal control projection requires an explicit actor credential")
	}
	record.OperationSeq++
	return terminalProjection{Record: &record, Submit: &terminalSubmitProjection{Message: decoded, Actor: actor, Seq: record.OperationSeq}}
}
