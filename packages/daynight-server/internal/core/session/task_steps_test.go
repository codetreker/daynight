package session

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestTaskStepMutationsPreserveActiveSessionPublicationAndControl(t *testing.T) {
	f, snapshot := connectFixture(t)
	ctx := context.Background()
	var version int64
	var sessionBefore string
	if err := f.db.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, f.task).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM task_sessions s WHERE id=$1`, snapshot.SessionID).Scan(&sessionBefore); err != nil {
		t.Fatal(err)
	}
	result, err := taskservice.NewTaskSteps(f.db).Add(ctx, f.p, f.project, f.task, taskservice.AddTaskStep{Version: version, ID: "abcdef01", Title: "Work continues"})
	if err != nil || result.Resource.Version != version+1 {
		t.Fatalf("Step add: %+v %v", result.Resource, err)
	}
	title := "Changed while execution continues"
	result, err = taskservice.NewTaskSteps(f.db).Update(ctx, f.p, f.project, f.task, "ABCDEF01", taskservice.UpdateTaskStep{Version: version + 1, Title: &title})
	if err != nil || result.Resource.Version != version+2 || !result.Changed {
		t.Fatalf("Step content update: %+v %v", result.Resource, err)
	}
	result, err = taskservice.NewTaskSteps(f.db).SetStatus(ctx, f.p, f.project, f.task, "ABCDEF01", taskservice.SetTaskStepStatus{Version: version + 2, Status: model.TaskStepInProgress})
	if err != nil || result.Resource.Version != version+3 || !result.Changed {
		t.Fatalf("Step status update: %+v %v", result.Resource, err)
	}
	var sessionAfter string
	if err := f.db.Pool.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM task_sessions s WHERE id=$1`, snapshot.SessionID).Scan(&sessionAfter); err != nil || sessionBefore != sessionAfter {
		t.Fatalf("Step mutations changed Session ownership/lease: %v", err)
	}
	var epoch string
	if err := f.db.Pool.QueryRow(ctx, `SELECT source_epoch::text FROM task_sessions WHERE id=$1`, snapshot.SessionID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	native := "native-after-step"
	state := sp.State{NativeSessionID: &native, InitialInputState: "confirmed", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true, Cancel: true, Respond: true}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "events", ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: encode(state)}}}); err != nil {
		t.Fatal("existing Controller could not publish after Step mutations", err)
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "after-step", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"continue"}],"expectedTurnId":null}`)}
	receipt, err := f.s.Submit(ctx, f.p, f.project, f.task, snapshot.SessionID, command)
	if err != nil || receipt.State != "accepted" {
		t.Fatalf("Session no longer accepts control: %+v %v", receipt, err)
	}
	offers, err := f.s.Poll(ctx, snapshot.ControllerFence)
	if err != nil || len(offers) != 1 {
		t.Fatalf("Controller no longer receives offers: %+v %v", offers, err)
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
		t.Fatalf("post-Step mutation control receipt: %+v %v", actual, err)
	}
}
