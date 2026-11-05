package sessionrelay

import (
	"context"
	"encoding/json"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestTaskStepMovePreservesActiveSessionPublicationAndControl(t *testing.T) {
	f, snapshot := connectFixture(t)
	ctx := context.Background()
	var version int64
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, f.task).Scan(&version); err != nil {
		t.Fatal(err)
	}
	steps := taskservice.NewTaskSteps(f.s.DB)
	for _, id := range []string{"00000000", "abcdef01"} {
		result, err := steps.Add(ctx, f.p, f.project, f.task, taskservice.AddTaskStep{Version: version, ID: id, Title: "Session work"})
		if err != nil {
			t.Fatal(err)
		}
		version = result.Resource.Version
	}
	var before, after string
	query := `SELECT to_jsonb(s)::text FROM task_sessions s WHERE id=$1`
	if err := f.s.DB.Pool.QueryRow(ctx, query, snapshot.SessionID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	last := "last"
	result, err := steps.Move(ctx, f.p, f.project, f.task, "00000000", taskservice.MoveTaskStep{Version: version, Position: &last})
	if err != nil || !result.Changed || result.Resource.Version != version+1 || result.Resource.Steps[1].ID != "00000000" {
		t.Fatal("active Session move failed", err)
	}
	if err := f.s.DB.Pool.QueryRow(ctx, query, snapshot.SessionID).Scan(&after); err != nil || before != after {
		t.Fatal("move changed Session ownership/lease", err)
	}
	var epoch string
	if err := f.s.DB.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	native := "native-after-move"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal("Controller publication after move failed", err)
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "after-move", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"continue"}],"expectedTurnId":null}`)}
	receipt, err := f.s.Submit(ctx, f.p, f.project, f.task, snapshot.SessionID, command)
	if err != nil || receipt.State != "accepted" {
		t.Fatal("control after move failed", err)
	}
	offers, err := f.s.Poll(ctx, snapshot.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatal("Controller offer after move failed", err)
	}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID}); err != nil {
		t.Fatal(err)
	}
	receipt.State = "confirmed"
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: snapshot.ControllerFence, Operation: &receipt}); err != nil {
		t.Fatal(err)
	}
	actual, err := f.s.Operation(ctx, f.p, f.project, f.task, snapshot.SessionID, command.OperationID)
	if err != nil || actual.State != "confirmed" {
		t.Fatal("control receipt after move failed", err)
	}
}
