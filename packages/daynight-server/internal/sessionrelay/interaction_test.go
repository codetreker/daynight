package sessionrelay

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestInteractionAnswersRespectNativeCallbackChoices(t *testing.T) {
	question := map[string]any{"kind": "question", "canDismiss": false, "questions": []any{map[string]any{"questionId": "q", "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}}, "multiple": false, "allowCustom": false, "required": true}}}
	form := map[string]any{"kind": "form", "canDismiss": true, "fields": []any{map[string]any{"fieldId": "n", "type": "number", "required": true, "min": float64(1), "max": float64(3)}, map[string]any{"fieldId": "t", "type": "text", "required": false}}}
	for _, tc := range []struct {
		name                  string
		interaction, response any
		want                  bool
	}{
		{"approval", map[string]any{"kind": "approval", "actions": []any{"allow_once", "reject"}}, map[string]any{"kind": "approval", "action": "allow_once"}, true},
		{"unoffered approval", map[string]any{"kind": "approval", "actions": []any{"reject"}}, map[string]any{"kind": "approval", "action": "allow_session"}, false},
		{"dismiss forbidden", question, map[string]any{"kind": "dismiss"}, false},
		{"dismiss allowed", form, map[string]any{"kind": "dismiss"}, true},
		{"wrong variant", question, map[string]any{"kind": "approval", "action": "reject"}, false},
		{"answer", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{"a"}, "text": nil}}}, true},
		{"unknown option", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{"missing"}, "text": nil}}}, false},
		{"unknown question", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "missing", "optionIds": []any{}, "text": nil}}}, false},
		{"multiple forbidden", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{"a", "b"}, "text": nil}}}, false},
		{"custom forbidden", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{}, "text": "custom"}}}, false},
		{"required empty", question, map[string]any{"kind": "question", "answers": []any{map[string]any{"questionId": "q", "optionIds": []any{}, "text": nil}}}, false},
		{"missing required", question, map[string]any{"kind": "question", "answers": []any{}}, false},
		{"malformed answer", question, map[string]any{"kind": "question", "answers": []any{true}}, false},
		{"form", form, map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "n", "value": float64(2)}, map[string]any{"fieldId": "t", "value": "answer"}}}, true},
		{"unknown field", form, map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "x", "value": true}}}, false},
		{"invalid field value", form, map[string]any{"kind": "form", "values": []any{map[string]any{"fieldId": "n", "value": float64(4)}}}, false},
		{"missing field", form, map[string]any{"kind": "form", "values": []any{}}, false},
		{"unknown kind", map[string]any{"kind": "unknown"}, map[string]any{"kind": "unknown"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := responseMatches(encode(tc.interaction), encode(tc.response)); got != tc.want {
				t.Fatalf("answer accepted=%v expected=%v", got, tc.want)
			}
		})
	}
	if responseMatches([]byte("invalid"), []byte("invalid")) {
		t.Fatal("malformed callback accepted")
	}
	for _, tc := range []struct {
		kind     string
		value    any
		required bool
		want     bool
	}{{"text", "", true, false}, {"text", "yes", true, true}, {"text", true, false, false}, {"boolean", false, true, true}, {"boolean", "true", false, false}, {"number", "2", false, false}, {"number", float64(0), false, false}, {"select", "a", true, true}, {"select", "b", true, false}, {"multiselect", []any{"a"}, true, true}, {"multiselect", []any{}, true, false}, {"multiselect", "a", false, false}, {"unknown", "a", false, false}} {
		f := map[string]any{"type": tc.kind, "required": tc.required, "min": float64(1), "max": float64(3), "options": []any{map[string]any{"id": "a"}}}
		if formMatches(f, tc.value) != tc.want {
			t.Fatalf("wrong validation for %s %#v", tc.kind, tc.value)
		}
	}
}
func TestCommandChecksLiveTurnsInitializationAndInteractionRevision(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	c := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hi"}],"expectedTurnId":null}`)}
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("initial input gate bypassed")
	}
	state := idleState()
	state.InitialInputState = "dispatching"
	publishState(t, f, v, state)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("dispatching startup treated as accepted")
	}
	state = idleState()
	turn := "turn-1"
	state.Activity = "working"
	state.CurrentTurnID = &turn
	publishState(t, f, v, state)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("working input without expected turn")
	}
	c.Payload = json.RawMessage(`{"content":[{"type":"text","text":"steer"}],"expectedTurnId":"turn-1"}`)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal("native steer rejected", err)
	}
	c.OperationID = uuid.NewString()
	c.Kind = "cancel"
	c.Payload = json.RawMessage(`{"expectedTurnId":"stale"}`)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("stale cancel")
	}
	c.Payload = json.RawMessage(`{"expectedTurnId":"turn-1"}`)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal("cancel rejected", err)
	}
	interaction := uuid.NewString()
	entry := map[string]any{"entryId": uuid.NewString(), "revision": "1", "kind": "interaction", "interaction": map[string]any{"interactionId": interaction, "revision": "1", "state": "pending", "title": "Approve", "kind": "approval", "detail": "tool permission", "actions": []string{"allow_once", "reject"}}}
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}))
	c.OperationID = uuid.NewString()
	c.Kind = "interaction_response"
	payload := sp.InteractionResponse{InteractionID: interaction, InteractionRevision: "2", SubmissionID: uuid.NewString(), Response: json.RawMessage(`{"kind":"approval","action":"allow_once"}`)}
	c.Payload = encode(payload)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("stale interaction revision")
	}
	payload.InteractionRevision = "1"
	payload.Response = json.RawMessage(`{"kind":"approval","action":"allow_session"}`)
	c.Payload = encode(payload)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("unoffered response")
	}
	payload.Response = json.RawMessage(`{"kind":"approval","action":"allow_once"}`)
	c.Payload = encode(payload)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err != nil {
		t.Fatal(err)
	}
	c.OperationID = uuid.NewString()
	payload.SubmissionID = uuid.NewString()
	c.Payload = encode(payload)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("duplicate native callback answer")
	}
	c.Kind = "unknown"
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, c); err == nil {
		t.Fatal("unknown native command")
	}
}
func TestDispatchReceiptAndExpiryPreserveActualExecutionBoundary(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	first := submitText(t, f, v)
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: first.OperationID}); err == nil {
		t.Fatal("accepted command skipped offer")
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	begin := sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: first.OperationID}
	apply(t, f, begin)
	apply(t, f, begin)
	receipt := sp.Operation{Fence: v.Fence, Protocol: sp.Protocol, OperationID: first.OperationID, Kind: first.Kind, State: "provider_accepted"}
	apply(t, f, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt})
	receipt.State = "unknown"
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err == nil {
		t.Fatal("known provider acceptance downgraded")
	}
	apply(t, f, sp.ControllerMessage{Type: "reconcile", ControllerFence: v.ControllerFence, Final: true, Operations: []sp.Reconciliation{{OperationID: first.OperationID, State: "unknown"}}})
	known, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, first.OperationID)
	if err != nil || known.State != "provider_accepted" {
		t.Fatal("reconciliation erased known provider acceptance", err)
	}
	receipt.State = "confirmed"
	apply(t, f, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt})
	apply(t, f, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt})
	receipt.State = "failed"
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &receipt}); err == nil {
		t.Fatal("terminal receipt rewritten")
	}
	changed := first
	changed.Payload = json.RawMessage(`{"content":[{"type":"text","text":"different"}],"expectedTurnId":null}`)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, changed); err == nil {
		t.Fatal("operation collision")
	}
	second := submitText(t, f, v)
	if _, err := f.s.DB.Pool.Exec(ctx, `UPDATE session_operations SET deadline=now()-interval '1 second' WHERE operation_id=$1`, second.OperationID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	r, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, second.OperationID)
	if err != nil || r.State != "expired" {
		t.Fatal("unsubmitted deadline not expired", err)
	}
	third := submitText(t, f, v)
	state := idleState()
	state.Capabilities.Send = false
	publishState(t, f, v, state)
	if _, err = f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	r, err = f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, third.OperationID)
	if err != nil || r.State != "rejected" {
		t.Fatal("state changed before dispatch", err)
	}
	f.s.now = func() time.Time { return time.Now().Add(31 * time.Second) }
	if _, err = f.s.Poll(ctx, v.ControllerFence); err == nil {
		t.Fatal("dead controller accepted")
	}
}

func TestNativeRejectionIsAConfirmedNonAcceptanceReceipt(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, idleState())
	command := submitText(t, f, v)
	if _, err := f.s.Poll(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	apply(t, f, sp.ControllerMessage{Type: "operation_begin", ControllerFence: v.ControllerFence, OperationID: command.OperationID})
	operation := sp.Operation{Fence: v.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: command.Kind, State: "rejected", Error: &sp.OperationError{Code: "native_rejected", Message: "The native runtime rejected this input."}}
	apply(t, f, sp.ControllerMessage{Type: "operation_receipt", ControllerFence: v.ControllerFence, Operation: &operation})
	saved, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || saved.State != "rejected" {
		t.Fatal("native rejection became unknown", err)
	}
}
