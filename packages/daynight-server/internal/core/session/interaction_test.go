package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

type commandAdmissionDAO struct {
	store.SessionDAO
	interactionResponse func(context.Context, string, string, string) (bool, error)
	otherFirstInput     func(context.Context, string, string) (bool, error)
}

func (dao commandAdmissionDAO) HasInteractionResponse(ctx context.Context, sessionID, operationID, interactionID string) (bool, error) {
	if dao.interactionResponse == nil {
		panic("unexpected HasInteractionResponse call")
	}
	return dao.interactionResponse(ctx, sessionID, operationID, interactionID)
}

func (dao commandAdmissionDAO) HasOtherFirstInput(ctx context.Context, sessionID, operationID string) (bool, error) {
	if dao.otherFirstInput == nil {
		panic("unexpected HasOtherFirstInput call")
	}
	return dao.otherFirstInput(ctx, sessionID, operationID)
}

func commandWorkingState() sp.State {
	state := idleState()
	turn := "turn-1"
	state.Activity, state.CurrentTurnID = "working", &turn
	return state
}

func approvalInteractionEntry(entryID, interactionID string) sp.TimelineEntry {
	return sp.TimelineEntry{EntryID: entryID, Revision: "1", Kind: "interaction", Data: map[string]json.RawMessage{
		"interaction": encode(map[string]any{"interactionId": interactionID, "revision": "1", "state": "pending", "title": "Approve", "kind": "approval", "detail": "tool permission", "actions": []string{"allow_once", "reject"}}),
	}}
}

func assertCommandAuthorization(t *testing.T, err error, code string, cause error) {
	t.Helper()
	if cause != nil {
		var refusal *model.Fault
		if !errors.Is(err, cause) || errors.As(err, &refusal) {
			t.Fatalf("command lookup did not retain its operational cause: %v", err)
		}
		return
	}
	if code == "" {
		if err != nil {
			t.Fatalf("valid command rejected: %v", err)
		}
		return
	}
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func TestCommandChecksLiveTurnsInitializationAndInteractionRevision(t *testing.T) {
	const interactionID = "00000000-0000-4000-8000-000000000003"
	const operationID = "00000000-0000-4000-8000-000000000004"
	const submissionID = "00000000-0000-4000-8000-000000000005"
	const entryID = "00000000-0000-4000-8000-000000000006"
	response := func(revision, action string) sp.InteractionResponse {
		return sp.InteractionResponse{InteractionID: interactionID, InteractionRevision: revision, SubmissionID: submissionID, Response: encode(map[string]any{"kind": "approval", "action": action})}
	}
	send := func(text string, turn *string) sp.SendMessage {
		return sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: text}}, ExpectedTurnID: turn}
	}
	turn := "turn-1"
	dispatching := idleState()
	dispatching.InitialInputState = "dispatching"
	lookupFailure := errors.New("interaction lookup unavailable")
	type lookupResult struct {
		duplicate bool
		cause     error
	}
	for _, test := range []struct {
		name, kind  string
		state       sp.State
		payload     any
		pending     bool
		lookup      *lookupResult
		lookupCalls int
		code        string
		cause       error
	}{
		{name: "initial input gate", kind: "send_message", state: sp.State{InitialInputState: "not_submitted", Synchronized: true, Activity: "initializing"}, payload: send("hi", nil), code: "session_conflict"},
		{name: "dispatching initialization", kind: "send_message", state: dispatching, payload: send("hi", nil), code: "session_conflict"},
		{name: "idle input", kind: "send_message", state: idleState(), payload: send("hi", nil)},
		{name: "working input without expected turn", kind: "send_message", state: commandWorkingState(), payload: send("hi", nil), code: "session_conflict"},
		{name: "native steer", kind: "send_message", state: commandWorkingState(), payload: send("steer", &turn)},
		{name: "stale cancel", kind: "cancel", state: commandWorkingState(), payload: sp.Cancel{ExpectedTurnID: "stale"}, code: "session_conflict"},
		{name: "current cancel", kind: "cancel", state: commandWorkingState(), payload: sp.Cancel{ExpectedTurnID: "turn-1"}},
		{name: "stale interaction revision", kind: "interaction_response", state: commandWorkingState(), payload: response("2", "allow_once"), pending: true, code: "session_conflict"},
		{name: "unoffered response", kind: "interaction_response", state: commandWorkingState(), payload: response("1", "allow_session"), pending: true, code: "session_conflict"},
		{name: "offered response", kind: "interaction_response", state: commandWorkingState(), payload: response("1", "allow_once"), pending: true, lookup: &lookupResult{}, lookupCalls: 1},
		{name: "duplicate native callback", kind: "interaction_response", state: commandWorkingState(), payload: response("1", "allow_once"), pending: true, lookup: &lookupResult{duplicate: true}, lookupCalls: 1, code: "session_conflict"},
		{name: "interaction lookup failure", kind: "interaction_response", state: commandWorkingState(), payload: response("1", "allow_once"), pending: true, lookup: &lookupResult{cause: lookupFailure}, lookupCalls: 1, cause: lookupFailure},
		{name: "unknown native command", kind: "unknown", state: commandWorkingState(), payload: response("1", "allow_once"), pending: true, code: "invalid_input"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			execution, current, currentTask := taskControlAuthorizationFixture(test.state)
			current.Live = newLive(current.Snapshot)
			current.Live.Synced = true
			if test.pending {
				entry := approvalInteractionEntry(entryID, interactionID)
				entry.EntrySeq = "1"
				current.Live.PendingInteractions[entryID] = entry
			}
			command := sp.Command{Fence: current.Snapshot.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: operationID, Kind: test.kind, Payload: encode(test.payload)}
			calls := 0
			dao := commandAdmissionDAO{}
			if test.lookup != nil {
				dao.interactionResponse = func(actual context.Context, session, operation, interaction string) (bool, error) {
					calls++
					if actual != ctx || session != current.Snapshot.SessionID || operation != operationID || interaction != interactionID {
						t.Fatalf("interaction lookup changed context or identifiers: %q %q %q", session, operation, interaction)
					}
					return test.lookup.duplicate, test.lookup.cause
				}
			}
			err := execution.authorizeCommand(ctx, &operationTx{dao: dao}, current, currentTask, command)
			assertCommandAuthorization(t, err, test.code, test.cause)
			if calls != test.lookupCalls {
				t.Fatalf("interaction lookup calls=%d, expected %d", calls, test.lookupCalls)
			}
		})
	}
}

func TestCommandRechecksIndependentFirstInput(t *testing.T) {
	lookupFailure := errors.New("first input lookup unavailable")
	for _, test := range []struct {
		name  string
		other bool
		cause error
		code  string
	}{
		{name: "no other first input"},
		{name: "another first input", other: true, code: "session_conflict"},
		{name: "lookup failure", cause: lookupFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			state := idleState()
			state.NativeSessionID, state.InitialInputState = nil, "not_required"
			execution, current, _ := taskControlAuthorizationFixture(state)
			current.Snapshot.TestExecutionID = "00000000-0000-4000-8000-000000000007"
			current.Snapshot.ClaimID = ""
			current.FirstInputBlocked = true
			command := sp.Command{Fence: current.Snapshot.Fence, Protocol: sp.Protocol, RequestID: "first", OperationID: "00000000-0000-4000-8000-000000000004", Kind: "send_message", Payload: encode(sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "hi"}}})}
			calls := 0
			dao := commandAdmissionDAO{otherFirstInput: func(actual context.Context, session, operation string) (bool, error) {
				calls++
				if actual != ctx || session != current.Snapshot.SessionID || operation != command.OperationID {
					t.Fatalf("first input lookup changed context or identifiers: %q %q", session, operation)
				}
				return test.other, test.cause
			}}
			err := execution.authorizeCommand(ctx, &operationTx{dao: dao}, current, task{}, command)
			assertCommandAuthorization(t, err, test.code, test.cause)
			if calls != 1 {
				t.Fatalf("first input lookup calls=%d, expected 1", calls)
			}
		})
	}
}

func TestInteractionResponsePersistsAndRejectsDuplicateCallback(t *testing.T) {
	f, v := connectFixture(t)
	ctx := context.Background()
	publishState(t, f, v, commandWorkingState())
	interaction := uuid.NewString()
	entry := approvalInteractionEntry(uuid.NewString(), interaction)
	apply(t, f, source(t, f, v, sp.SourceEvent{Kind: "timeline_upsert", Payload: encode(entry)}))
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "test", OperationID: uuid.NewString(), Kind: "interaction_response"}
	payload := sp.InteractionResponse{InteractionID: interaction, InteractionRevision: "1", SubmissionID: uuid.NewString(), Response: json.RawMessage(`{"kind":"approval","action":"allow_once"}`)}
	command.Payload = encode(payload)
	accepted, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command)
	if err != nil || accepted.State != "accepted" {
		t.Fatal("offered interaction response rejected", accepted, err)
	}
	stored, err := f.s.Operation(ctx, f.p, f.project, f.task, v.SessionID, command.OperationID)
	if err != nil || stored.State != "accepted" || stored.Kind != "interaction_response" {
		t.Fatal("interaction response was not persisted", stored, err)
	}
	command.OperationID = uuid.NewString()
	payload.SubmissionID = uuid.NewString()
	command.Payload = encode(payload)
	if _, err := f.s.Submit(ctx, f.p, f.project, f.task, v.SessionID, command); err == nil {
		t.Fatal("duplicate native callback answer")
	} else {
		requireControlConflict(t, err)
	}
	var operations int
	if err := f.db.Pool.QueryRow(ctx, "SELECT count(*) FROM session_operations WHERE session_id=$1", v.SessionID).Scan(&operations); err != nil || operations != 1 {
		t.Fatalf("duplicate response changed the durable ledger: operations=%d error=%v", operations, err)
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
	if _, err := f.db.Pool.Exec(ctx, `UPDATE session_operations SET deadline=now()-interval '1 second' WHERE operation_id=$1`, second.OperationID); err != nil {
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
