package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func rpcTaskRequest(t *testing.T, endpoint, version string, body any) (*http.Response, []byte) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return rpcTaskRawRequest(t, endpoint, version, encoded)
}

func rpcTaskRawRequest(t *testing.T, endpoint, version string, encoded []byte) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer alice")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("X-Request-ID", "rpc-test")
	if version != "" {
		req.Header.Set("MCP-Protocol-Version", version)
	}
	if version == "2026-07-28" {
		req.Header.Set("MCP-Method", "tools/call")
		req.Header.Set("MCP-Name", "task_update")
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, data
}

func taskRPCRefusal() error {
	return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: "resource_limit_exceeded", Message: "Task response exceeds the encoded resource limit."}}
}

func expectTaskRPCUpdate(t *testing.T, fixture *taskResourceFixture, expected taskcore.UpdateTask, response taskservice.MCPTaskResponse, result model.Task, failure error) {
	t.Helper()
	var calls atomic.Int32
	fixture.operations.UpdateFunc = func(ctx context.Context, _ model.Principal, _, id string, input taskcore.UpdateTask, ordinary, external *[]string) (model.Task, error) {
		metadata, present := taskservice.MCPTaskResponseFromContext(ctx)
		if !present || !reflect.DeepEqual(metadata, response) {
			t.Error("RPC update lost its response ID, request ID, protocol, batch or projection context")
			return model.Task{}, errors.New("unexpected RPC response context")
		}
		if calls.Add(1) != 1 || id != testTargetID || !reflect.DeepEqual(input, expected) || ordinary != nil || external != nil {
			t.Errorf("unexpected RPC update: id=%s input=%#v ordinary=%v external=%v", id, input, ordinary, external)
			return model.Task{}, errors.New("unexpected RPC update")
		}
		return result, failure
	}
	t.Cleanup(func() {
		if got := calls.Load(); got != 1 {
			t.Errorf("RPC update calls=%d, want 1", got)
		}
	})
}

func taskRPCResponse(rpcID any, modern, batch, full bool) taskservice.MCPTaskResponse {
	return taskservice.MCPTaskResponse{RequestID: "rpc-test", RPCID: rpcID, Modern: modern, Batch: batch, Full: full}
}

func taskRPCInput(task model.Task, title string) taskcore.UpdateTask {
	return taskcore.UpdateTask{Version: task.Version, Title: &title}
}

func TestTaskRPCResponseExactBoundary(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	task := taskFixtureTask()
	args := map[string]any{"projectId": fixture.project, "taskId": task.ID, "title": task.Title, "ifVersion": Decimal(task.Version), "returnView": "full"}
	fixture.operations.expectCalls(map[string]int{"Update": 6})
	for _, character := range []string{"x", "<"} {
		expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(character, false, false, true), task, nil)
		_, base := rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(character, "2025-11-25", "task_update", args))
		length := taskcore.MaxTaskResponseJSONBytes - len(base) + 1
		expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(strings.Repeat(character, length), false, false, true), task, nil)
		resp, exact := rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(strings.Repeat(character, length), "2025-11-25", "task_update", args))
		var result struct {
			Result struct {
				IsError           bool `json:"isError"`
				StructuredContent struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				} `json:"structuredContent"`
			} `json:"result"`
		}
		if resp.StatusCode != http.StatusOK || len(exact) != taskcore.MaxTaskResponseJSONBytes || json.Unmarshal(exact, &result) != nil || result.Result.IsError {
			t.Fatalf("exact response: status=%d length=%d result=%+v", resp.StatusCode, len(exact), result)
		}
		expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(strings.Repeat(character, length+1), false, false, true), model.Task{}, taskRPCRefusal())
		resp, excess := rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(strings.Repeat(character, length+1), "2025-11-25", "task_update", args))
		if resp.StatusCode != http.StatusOK || json.Unmarshal(excess, &result) != nil || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "resource_limit_exceeded" {
			t.Fatalf("excess response: status=%d result=%+v", resp.StatusCode, result)
		}
	}
}

func TestTaskRPCSummaryAndPropertyResponseAdmission(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	task := taskFixtureTask()
	task.Description = strings.Repeat("d", 65536)
	fixture.operations.expectCalls(map[string]int{"Update": 2, "SetProperty": 1})
	rpcID := strings.Repeat("x", 490000)
	args := map[string]any{"projectId": fixture.project, "taskId": task.ID, "title": task.Title, "ifVersion": Decimal(task.Version)}
	expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(rpcID, false, false, false), task, nil)
	resp, body := rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_update", args))
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					Projection string `json:"projection"`
					Version    string `json:"version"`
				} `json:"data"`
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &result) != nil || result.Result.IsError || result.Result.StructuredContent.Data.Projection != "summary" {
		t.Fatalf("summary result: status=%d result=%+v", resp.StatusCode, result)
	}
	n, err := taskprotocol.EncodeMCPResponse(io.Discard, task, "rpc-test", "unchanged", rpcID, false, false, math.MaxInt64)
	if err != nil || n != int64(len(body)) {
		t.Fatalf("summary measured=%d actual=%d err=%v", n, len(body), err)
	}
	args["returnView"] = "full"
	expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(rpcID, false, false, true), model.Task{}, taskRPCRefusal())
	_, body = rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_update", args))
	if json.Unmarshal(body, &result) != nil || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "resource_limit_exceeded" {
		t.Fatalf("full result: %+v", result)
	}
	after := task
	after.Version++
	after.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}
	fixture.operations.SetPropertyFunc = func(ctx context.Context, _ model.Principal, _, id, name, value string, version int64) (model.Task, error) {
		metadata, present := taskservice.MCPTaskResponseFromContext(ctx)
		if !present || !reflect.DeepEqual(metadata, taskRPCResponse(rpcID, false, false, false)) {
			t.Error("property write lost its RPC response context")
			return model.Task{}, errors.New("unexpected property response context")
		}
		if id != task.ID || name != "pullRequests" || value != "[]" || version != task.Version {
			t.Errorf("unexpected property request: id=%s name=%s value=%s version=%d", id, name, value, version)
			return model.Task{}, errors.New("unexpected property request")
		}
		return after, nil
	}
	propertyArgs := map[string]any{"projectId": fixture.project, "taskId": task.ID, "name": "pullRequests", "valueText": "[]", "ifVersion": Decimal(task.Version)}
	_, body = rpcTaskRequest(t, fixture.server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_set_property", propertyArgs))
	result.Result.IsError = false
	if json.Unmarshal(body, &result) != nil || result.Result.IsError || result.Result.StructuredContent.Data.Projection != "summary" || result.Result.StructuredContent.Data.Version != Decimal(after.Version) {
		t.Fatalf("property result: %+v", result)
	}
	n, err = taskprotocol.EncodeMCPResponse(io.Discard, after, "rpc-test", "changed", rpcID, false, false, math.MaxInt64)
	if err != nil || n != int64(len(body)) {
		t.Fatalf("property measured=%d actual=%d err=%v", n, len(body), err)
	}
}

func TestTaskRPCBatchUsesEachCallID(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	task := taskFixtureTask()
	fixture.operations.expectCalls(map[string]int{"Update": 3})
	args := map[string]any{"projectId": fixture.project, "taskId": task.ID, "title": task.Title, "ifVersion": Decimal(task.Version), "returnView": "full"}
	rpcID := strings.Repeat("<", 30000)
	batch := []any{rpcTaskCall(rpcID, "", "task_update", args), rpcTaskCall("small", "", "task_properties", map[string]any{"mode": "schema"})}
	expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(rpcID, false, true, true), task, nil)
	resp, body := rpcTaskRequest(t, fixture.server.URL, "", batch)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("batch status=%d body=%s", resp.StatusCode, body[:min(500, len(body))])
	}
	var messages []json.RawMessage
	if err := json.Unmarshal(body, &messages); err != nil {
		t.Fatalf("batch content-type=%s body=%s err=%v", resp.Header.Get("Content-Type"), body[:min(500, len(body))], err)
	}
	var actual []byte
	for _, raw := range messages {
		var msg struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(raw, &msg) == nil && msg.ID == rpcID {
			actual = raw
		}
	}
	if len(actual) == 0 {
		t.Fatal("missing update response")
	}
	var result struct {
		Result struct {
			IsError bool `json:"isError"`
		} `json:"result"`
	}
	if err := json.Unmarshal(actual, &result); err != nil || result.Result.IsError {
		t.Fatalf("batch update: isError=%v parse=%v", result.Result.IsError, err)
	}
	n, err := taskprotocol.EncodeMCPResponse(io.Discard, task, "rpc-test", "unchanged", rpcID, false, true, math.MaxInt64)
	if err != nil || n != int64(len(actual)) || !bytes.Contains(actual, []byte(`\u003c`)) {
		t.Fatalf("batch bound=%d actual=%d err=%v", n, len(actual), err)
	}
	after := task
	after.Title, after.Version = "Rejected", task.Version+1
	args["title"] = after.Title
	batch = []any{rpcTaskCall("small", "", "task_update", args), rpcTaskCall(strings.Repeat("<", 90000), "", "task_properties", map[string]any{"mode": "schema"})}
	expectTaskRPCUpdate(t, fixture, taskRPCInput(task, after.Title), taskRPCResponse("small", false, true, true), after, nil)
	resp, body = rpcTaskRequest(t, fixture.server.URL, "", batch)
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &messages) != nil {
		t.Fatalf("oversized batch: status=%d", resp.StatusCode)
	}
	var refusal struct {
		ID     any `json:"id"`
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					Title   string `json:"title"`
					Version string `json:"version"`
				} `json:"data"`
				Error struct {
					Code         string `json:"code"`
					WriteOutcome string `json:"writeOutcome"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	for _, raw := range messages {
		var candidate struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(raw, &candidate) == nil && candidate.ID == "small" {
			_ = json.Unmarshal(raw, &refusal)
		}
	}
	if refusal.ID != "small" || refusal.Result.IsError || refusal.Result.StructuredContent.Data.Title != after.Title || refusal.Result.StructuredContent.Data.Version != Decimal(after.Version) {
		t.Fatalf("small batch call: %+v", refusal)
	}
	args["title"], args["ifVersion"] = "Must roll back", Decimal(after.Version)
	large := strings.Repeat("<", 90000)
	batch = []any{rpcTaskCall(large, "", "task_update", args), rpcTaskCall("small", "", "task_properties", map[string]any{"mode": "schema"})}
	expectTaskRPCUpdate(t, fixture, taskRPCInput(after, "Must roll back"), taskRPCResponse(large, false, true, true), model.Task{}, taskRPCRefusal())
	resp, body = rpcTaskRequest(t, fixture.server.URL, "", batch)
	if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &messages) != nil {
		t.Fatalf("oversized call: status=%d", resp.StatusCode)
	}
	refusal.ID = nil
	for _, raw := range messages {
		var candidate struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(raw, &candidate) == nil && candidate.ID == large {
			_ = json.Unmarshal(raw, &refusal)
		}
	}
	if refusal.ID != large || !refusal.Result.IsError || refusal.Result.StructuredContent.Error.Code != "resource_limit_exceeded" || refusal.Result.StructuredContent.Error.WriteOutcome != "not_committed" {
		t.Fatalf("large batch call: %+v", refusal.Result)
	}
}

func TestTaskRPCBatchRetainsSDKParsingSemantics(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	task := taskFixtureTask()
	suffixes := []string{
		``, `,"_meta":null`, `,"_meta":{}`, `,"_meta":{"keep":{"nested":true}}`,
		`,"_meta":{"first":1},"_meta":{"second":2}`, `,"_meta":{"first":1},"_meta":null`,
		`,"_META":{"other":1},"NAME":"other"`, `,"_meta":{"keep":1},"_META":null,"Name":"other"`,
		`,"name":null`, `,"name":"task_update","name":null`,
	}
	fixture.operations.expectCalls(map[string]int{"Update": len(suffixes)})
	args := fmt.Sprintf(`"arguments":{"projectId":%q,"taskId":%q,"title":%q,"ifVersion":%q,"returnView":"full"}`, fixture.project, task.ID, task.Title, Decimal(task.Version))
	for _, suffix := range suffixes {
		expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse("write", false, true, true), task, nil)
		body := []byte(fmt.Sprintf(`[{"jsonrpc":"2.0","id":"write","method":"tools/call","params":{"name":"task_update",%s%s},"PARAMS":{"name":"other"}},{"jsonrpc":"2.0","id":"other","method":"tools/call","params":{"name":"task_show","arguments":{"projectId":%q,"taskId":%q,"extra":1e1000}}}]`, args, suffix, fixture.project, task.ID))
		resp, raw := rpcTaskRawRequest(t, fixture.server.URL, "", body)
		var messages []struct {
			ID     any `json:"id"`
			Result struct {
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &messages) != nil {
			t.Fatalf("suffix=%s status=%d body=%s", suffix, resp.StatusCode, raw[:min(500, len(raw))])
		}
		found := false
		for _, msg := range messages {
			if msg.ID == "write" {
				found = true
				if msg.Result.IsError {
					t.Fatalf("suffix=%s write refused: %s", suffix, raw[:min(500, len(raw))])
				}
			}
		}
		if !found {
			t.Fatalf("suffix=%s missing write", suffix)
		}
	}
	changedArgs := fmt.Sprintf(`"arguments":{"projectId":%q,"taskId":%q,"title":"Must not commit","ifVersion":%q}`, fixture.project, task.ID, Decimal(task.Version))
	valid := fmt.Sprintf(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update",%s}}]`, changedArgs)
	for _, invalid := range []string{"\u00a0" + valid, valid + "\u00a0", valid + " garbage"} {
		_, _ = rpcTaskRawRequest(t, fixture.server.URL, "", []byte(invalid))
	}
}

func TestTaskRPCBatchExactItemBoundary(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	task := taskFixtureTask()
	fixture.operations.expectCalls(map[string]int{"Update": 3})
	args := map[string]any{"projectId": fixture.project, "taskId": task.ID, "title": task.Title, "ifVersion": Decimal(task.Version), "returnView": "full"}
	call := func(rpcID string, failure error) (json.RawMessage, bool) {
		t.Helper()
		expectTaskRPCUpdate(t, fixture, taskRPCInput(task, task.Title), taskRPCResponse(rpcID, false, true, true), task, failure)
		batch := []any{rpcTaskCall(rpcID, "", "task_update", args), rpcTaskCall("other", "", "task_properties", map[string]any{"mode": "schema"})}
		resp, raw := rpcTaskRequest(t, fixture.server.URL, "", batch)
		var messages []json.RawMessage
		if resp.StatusCode != http.StatusOK || json.Unmarshal(raw, &messages) != nil {
			t.Fatalf("batch status=%d", resp.StatusCode)
		}
		for _, item := range messages {
			var msg struct {
				ID     any `json:"id"`
				Result struct {
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			if json.Unmarshal(item, &msg) == nil && msg.ID == rpcID {
				return item, msg.Result.IsError
			}
		}
		t.Fatal("missing result")
		return nil, false
	}
	base, failed := call("x", nil)
	if failed {
		t.Fatal("base batch failed")
	}
	length := taskcore.MaxTaskResponseJSONBytes - len(base) + 1
	exact, failed := call(strings.Repeat("x", length), nil)
	if failed || len(exact) != taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("exact batch item size=%d failed=%v", len(exact), failed)
	}
	_, failed = call(strings.Repeat("x", length+1), taskRPCRefusal())
	if !failed {
		t.Fatal("oversized batch item succeeded")
	}
}

func rpcTaskCall(id any, version, name string, args map[string]any) map[string]any {
	params := map[string]any{"name": name, "arguments": args}
	if version == "2026-07-28" {
		params["_meta"] = map[string]any{"io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": map[string]any{}}
	}
	return map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": params}
}

func TestTaskRPCResponseAdmissionUsesCompleteWire(t *testing.T) {
	fixture := newTaskResourceFixture(t)
	fixture.operations.expectCalls(map[string]int{"Update": 8})
	before := taskFixtureTask()
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for i, rpcID := range []any{int64(0), "<&世界", strings.Repeat("<", 100000)} {
			after := before
			after.Title = "Changed " + version
			if i == 0 {
				after.Version++
			}
			args := map[string]any{"projectId": fixture.project, "taskId": before.ID, "title": after.Title, "ifVersion": Decimal(before.Version), "returnView": "full"}
			expectTaskRPCUpdate(t, fixture, taskRPCInput(before, after.Title), taskRPCResponse(rpcID, version == "2026-07-28", false, true), after, nil)
			resp, body := rpcTaskRequest(t, fixture.server.URL, version, rpcTaskCall(rpcID, version, "task_update", args))
			var wire struct {
				Result struct {
					IsError           bool `json:"isError"`
					StructuredContent struct {
						Data struct {
							Title   string `json:"title"`
							Version string `json:"version"`
						} `json:"data"`
					} `json:"structuredContent"`
				} `json:"result"`
			}
			if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &wire) != nil || wire.Result.IsError || wire.Result.StructuredContent.Data.Title != after.Title || wire.Result.StructuredContent.Data.Version != Decimal(after.Version) {
				t.Fatalf("version=%s id type=%T status=%d body=%s", version, rpcID, resp.StatusCode, body[:min(len(body), 500)])
			}
			outcome := "unchanged"
			if after.Version != before.Version {
				outcome = "changed"
			}
			n, err := taskprotocol.EncodeMCPResponse(io.Discard, after, "rpc-test", outcome, rpcID, version == "2026-07-28", true, math.MaxInt64)
			if str, ok := rpcID.(string); ok {
				n -= int64(5 * (strings.Count(str, "<") + strings.Count(str, ">") + strings.Count(str, "&")))
			}
			if err != nil || n != int64(len(body)) {
				t.Fatalf("version=%s id type=%T measured=%d actual=%d err=%v", version, rpcID, n, len(body), err)
			}
			before = after
		}
		args := map[string]any{"projectId": fixture.project, "taskId": before.ID, "title": "Rejected", "ifVersion": Decimal(before.Version), "returnView": "full"}
		expectTaskRPCUpdate(t, fixture, taskRPCInput(before, "Rejected"), taskRPCResponse(strings.Repeat("x", 600*1024), version == "2026-07-28", false, true), model.Task{}, taskRPCRefusal())
		resp, body := rpcTaskRequest(t, fixture.server.URL, version, rpcTaskCall(strings.Repeat("x", 600*1024), version, "task_update", args))
		var wire struct {
			Result struct {
				IsError           bool `json:"isError"`
				StructuredContent struct {
					Error struct {
						Code         string `json:"code"`
						WriteOutcome string `json:"writeOutcome"`
					} `json:"error"`
				} `json:"structuredContent"`
			} `json:"result"`
		}
		if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &wire) != nil || !wire.Result.IsError || wire.Result.StructuredContent.Error.Code != "resource_limit_exceeded" || wire.Result.StructuredContent.Error.WriteOutcome != "not_committed" {
			t.Fatalf("oversized id version=%s status=%d error=%+v", version, resp.StatusCode, wire.Result)
		}
	}
}
