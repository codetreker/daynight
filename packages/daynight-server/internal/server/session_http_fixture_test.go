package server

import (
	"bytes"
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type sessionHTTPWrites struct {
	instance         string
	connectionExpiry *time.Time
	disconnected     int
}

type sessionHTTPHandle struct {
	expected sp.ControllerMessage
	response map[string]any
	after    func()
}

type sessionHTTPCommand struct {
	input  sp.Command
	result sp.Operation
	calls  int
}

func sessionHTTPOnce(t *testing.T) func() {
	t.Helper()
	calls := 0
	t.Cleanup(func() {
		if calls != 1 {
			t.Errorf("Session operation calls=%d, want1", calls)
		}
	})
	return func() {
		calls++
		if calls != 1 {
			unexpectedHTTPCall(t, "extra Session operation")
		}
	}
}

func sessionHTTPCopy[T any](v T) T {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (f *sessionHTTPFixture) requireBrowser(ctx context.Context, p model.Principal, project, task, id string) {
	f.t.Helper()
	requireOperationHTTPContext(f.t, ctx)
	if ctx.Err() != nil || p != f.handler.principal || project != f.task.ProjectID || task != f.task.ID || id != f.snapshot.SessionID {
		unexpectedHTTPCall(f.t, "Session browser context/principal/address")
	}
}
func (f *sessionHTTPFixture) requireController(ctx context.Context, fence sp.ControllerFence) {
	f.t.Helper()
	if f.connections[fence] != ctx {
		unexpectedHTTPCall(f.t, "Session controller context/fence")
	}
}
func (f *sessionHTTPFixture) configureOperations() {
	f.ops.AuthenticateController = func(ctx context.Context, token string) error {
		if ctx.Err() != nil || token != f.grant.Token {
			unexpectedHTTPCall(f.t, "Session AuthenticateController token/context")
		}
		return nil
	}
	f.ops.SourceSeq = func(ctx context.Context, fence sp.ControllerFence) (int64, error) {
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requireController(ctx, fence)
		return f.sourceSeq, nil
	}
	f.ops.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		if ctx.Err() != nil || f.connections[fence] == nil {
			unexpectedHTTPCall(f.t, "Session Disconnect context/fence")
		}

		delete(f.connections, fence)
		f.writes.disconnected++
		return nil
	}
	f.ops.Handle = func(ctx context.Context, input sp.ControllerMessage) (map[string]any, error) {
		f.mu.Lock()
		f.requireController(ctx, input.ControllerFence)
		if len(f.handles) == 0 {
			f.mu.Unlock()
			unexpectedHTTPCall(f.t, "Session Handle unplanned frame")
		}
		plan := f.handles[0]
		f.handles = f.handles[1:]
		if !reflect.DeepEqual(input, plan.expected) {
			f.mu.Unlock()
			f.t.Errorf("Session Handle changed complete parsed frame: got %#v want %#v", input, plan.expected)
			panic("Session Handle input mismatch")
		}
		f.mu.Unlock()
		if plan.after != nil {
			plan.after()
		}
		return copySessionHTTPResponse(plan.response), nil
	}
	f.ops.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requireController(ctx, fence)
		if len(f.pollFrames) == 0 {
			return []map[string]any{}, nil
		}
		result := f.pollFrames[0]
		f.pollFrames = f.pollFrames[1:]
		for _, frame := range result {
			if frame["type"] == "operation_offer" {
				command := frame["command"].(sp.Command)
				f.offered[command.OperationID]++
			}
		}
		return copySessionHTTPFrames(result), nil
	}
	f.ops.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, cursor string) (sp.Snapshot, []map[string]any, string, error) {
		if ctx.Err() != nil {
			return sp.Snapshot{}, nil, "", ctx.Err()
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requireBrowser(ctx, p, project, task, id)
		expectedCursor := ""
		if f.browserCalls != 0 {
			expectedCursor = f.browserCursor
		}
		if cursor != expectedCursor {
			unexpectedHTTPCall(f.t, "Session BrowserPoll opaque cursor")
		}
		f.browserCalls++
		events := []map[string]any{}
		if len(f.browserFrames) > 0 {
			events = f.browserFrames[0]
			f.browserFrames = f.browserFrames[1:]
		}
		return sessionHTTPCopy(f.browserSnapshot), copySessionHTTPFrames(events), f.browserCursor, nil
	}
	f.ops.Submit = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Command) (sp.Operation, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.requireBrowser(ctx, p, project, task, id)
		plan := f.commands[actual.OperationID]
		if plan == nil || plan.calls != 0 || !reflect.DeepEqual(actual, plan.input) {
			unexpectedHTTPCall(f.t, "Session Submit complete command/count")
		}
		plan.calls++
		return sessionHTTPCopy(plan.result), nil
	}
}
func copySessionHTTPCommand(command sp.Command) sp.Command {
	command.Payload = bytes.Clone(command.Payload)
	return command
}
func copySessionHTTPController(input sp.ControllerMessage) sp.ControllerMessage {
	result := input
	result.Raw = bytes.Clone(input.Raw)
	result.MediaBody = bytes.Clone(input.MediaBody)
	result.MediaResult = bytes.Clone(input.MediaResult)
	if input.State != nil {
		value := sessionHTTPCopy(*input.State)
		result.State = &value
	}
	if input.Operation != nil {
		value := sessionHTTPCopy(*input.Operation)
		result.Operation = &value
	}
	if input.ContentError != nil {
		value := *input.ContentError
		result.ContentError = &value
	}
	result.Events = append([]sp.SourceEvent(nil), input.Events...)
	if input.Events != nil && len(input.Events) == 0 {
		result.Events = []sp.SourceEvent{}
	}
	for i := range result.Events {
		result.Events[i].Payload = bytes.Clone(input.Events[i].Payload)
	}
	result.Operations = sessionHTTPCopy(input.Operations)
	result.PendingInteractions = copySessionHTTPTimeline(input.PendingInteractions)
	if input.ContentResult != nil {
		value := *input.ContentResult
		value.Items = copySessionHTTPTimeline(input.ContentResult.Items)
		value.Resources = sessionHTTPCopy(input.ContentResult.Resources)
		result.ContentResult = &value
	}
	return result
}
func copySessionHTTPTimeline(items []sp.TimelineEntry) []sp.TimelineEntry {
	if items == nil {
		return nil
	}
	result := make([]sp.TimelineEntry, len(items))
	for i, item := range items {
		result[i] = item
		result[i].Data = make(map[string]json.RawMessage, len(item.Data))
		for key, raw := range item.Data {
			result[i].Data[key] = bytes.Clone(raw)
		}
	}
	return result
}
func copySessionHTTPValue(value any) any {
	switch item := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(item))
		for key, v := range item {
			result[key] = copySessionHTTPValue(v)
		}
		return result
	case []any:
		result := make([]any, len(item))
		for i, v := range item {
			result[i] = copySessionHTTPValue(v)
		}
		return result
	case json.RawMessage:
		return bytes.Clone(item)
	case []byte:
		return bytes.Clone(item)
	case sp.Command:
		return copySessionHTTPCommand(item)
	case sp.Operation:
		return sessionHTTPCopy(item)
	case sp.Snapshot:
		return sessionHTTPCopy(item)
	default:
		return value
	}
}
func copySessionHTTPFrames(frames []map[string]any) []map[string]any {
	result := make([]map[string]any, len(frames))
	for i, frame := range frames {
		result[i] = copySessionHTTPValue(frame).(map[string]any)
	}
	return result
}
func sessionHTTPTimelineEntry(t *testing.T, fields map[string]any) sp.TimelineEntry {
	t.Helper()
	rawFields := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		rawFields[key] = bytes.Clone(sessionNativeJSON(t, value))
	}
	return sp.TimelineEntry{EntryID: fields["entryId"].(string), EntrySeq: fields["entrySeq"].(string), Revision: fields["revision"].(string), Kind: fields["kind"].(string), Data: rawFields}
}
func (f *sessionHTTPFixture) frame(snapshot sp.Snapshot, kind string) map[string]any {
	return map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": snapshot.SessionID, "claimId": snapshot.ClaimID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch}
}
func (f *sessionHTTPFixture) expectHandle(t *testing.T, input sp.ControllerMessage, result map[string]any) {
	t.Helper()
	f.expectRawHandle(t, input, []byte(jsonBody(t, input)), result, nil)
}
func (f *sessionHTTPFixture) expectRawHandle(t *testing.T, input sp.ControllerMessage, raw []byte, result map[string]any, after func()) {
	t.Helper()
	expected := copySessionHTTPController(input)
	expected.Raw = bytes.Clone(raw)
	f.mu.Lock()
	f.handles = append(f.handles, sessionHTTPHandle{expected: expected, response: copySessionHTTPResponse(result), after: after})
	f.mu.Unlock()
}
func (f *sessionHTTPFixture) supplyState(state sp.State) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.record.Snapshot.Identity.NativeSessionID = sessionHTTPCopy(state.NativeSessionID)
	f.record.Snapshot.InitialInputState = state.InitialInputState
}
func (f *sessionHTTPFixture) supplySource(seq int64) {
	f.mu.Lock()
	f.sourceSeq = seq
	f.record.SourceSeq = seq
	f.mu.Unlock()
}
func (f *sessionHTTPFixture) expectCommand(t *testing.T, c sp.Command) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commands[c.OperationID] != nil {
		t.Fatal("duplicate command test identity")
	}
	f.commands[c.OperationID] = &sessionHTTPCommand{input: copySessionHTTPCommand(c), result: sp.Operation{Fence: c.Fence, Protocol: sp.Protocol, OperationID: c.OperationID, Kind: c.Kind, State: "accepted"}}
}
func (f *sessionHTTPFixture) suppliedOperation(t *testing.T, c sp.Command, receipt sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	plan := f.commands[c.OperationID]
	if plan == nil || plan.calls != 1 || !reflect.DeepEqual(receipt, plan.result) || !reflect.DeepEqual(plan.input, c) {
		t.Fatal("command or HTTP receipt changed independently declared operation result")
	}
}
func (f *sessionHTTPFixture) selectOffers(t *testing.T, ids ...string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	frames := make([]map[string]any, 0, len(ids))
	for index, id := range ids {
		plan := f.commands[id]
		if plan == nil || plan.calls != 1 {
			t.Fatal("offer selected an unconfigured command")
		}
		frame := f.frame(f.connectedSnapshot, "operation_offer")
		frame["operationSeq"] = strconv.Itoa(index + 1)
		frame["command"] = copySessionHTTPCommand(plan.input)
		frames = append(frames, frame)
	}
	f.pollFrames = append(f.pollFrames, frames)
}
func (f *sessionHTTPFixture) suppliedOffer(t *testing.T, id, epoch string) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commands[id] == nil || f.offered[id] != 1 || epoch != f.connectedSnapshot.ConnectionEpoch {
		t.Fatal("offer changed declared intent, count or connection fence")
	}
}
func (f *sessionHTTPFixture) supplyReceipt(t *testing.T, operation sp.Operation) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commands[operation.OperationID] == nil || operation.Fence != f.connectedSnapshot.Fence {
		t.Fatal("receipt has no independently configured operation")
	}
}

func copySessionHTTPResponse(result map[string]any) map[string]any {
	if result == nil {
		return nil
	}
	return copySessionHTTPValue(result).(map[string]any)
}
