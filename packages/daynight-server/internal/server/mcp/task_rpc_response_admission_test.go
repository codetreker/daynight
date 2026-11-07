package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
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

func TestTaskRPCResponseExactBoundary(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Boundary"})
	id := data["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": project, "taskId": id, "title": before.Title, "ifVersion": Decimal(before.Version), "returnView": "full"}
	for _, character := range []string{"x", "<"} {
		_, base := rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(character, "2025-11-25", "task_update", args))
		length := taskcore.MaxTaskResponseJSONBytes - len(base) + 1
		resp, exact := rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(strings.Repeat(character, length), "2025-11-25", "task_update", args))
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
		if resp.StatusCode != 200 || len(exact) != taskcore.MaxTaskResponseJSONBytes || json.Unmarshal(exact, &result) != nil || result.Result.IsError {
			t.Fatalf("exact response: status=%d length=%d result=%+v", resp.StatusCode, len(exact), result)
		}
		resp, excess := rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(strings.Repeat(character, length+1), "2025-11-25", "task_update", args))
		result = struct {
			Result struct {
				IsError           bool `json:"isError"`
				StructuredContent struct {
					Error struct {
						Code string `json:"code"`
					} `json:"error"`
				} `json:"structuredContent"`
			} `json:"result"`
		}{}
		if resp.StatusCode != 200 || json.Unmarshal(excess, &result) != nil || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "resource_limit_exceeded" {
			t.Fatalf("excess response: status=%d result=%+v", resp.StatusCode, result)
		}
	}
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("boundary changed Task: %v", err)
	}
}

func TestTaskRPCSummaryAndPropertyResponseAdmission(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Summary", "description": strings.Repeat("d", 65536)})
	id := data["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	rpcID := strings.Repeat("x", 490000)
	args := map[string]any{"projectId": project, "taskId": id, "title": before.Title, "ifVersion": Decimal(before.Version)}
	resp, body := rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_update", args))
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Data struct {
					Projection string `json:"projection"`
				} `json:"data"`
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(body, &result) != nil || result.Result.IsError || result.Result.StructuredContent.Data.Projection != "summary" {
		t.Fatalf("summary result: status=%d result=%+v", resp.StatusCode, result)
	}
	n, err := taskprotocol.EncodeMCPResponse(io.Discard, before, "rpc-test", "unchanged", rpcID, false, false, math.MaxInt64)
	if err != nil || n != int64(len(body)) {
		t.Fatalf("summary measured=%d actual=%d err=%v", n, len(body), err)
	}
	args["returnView"] = "full"
	_, body = rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_update", args))
	result.Result.IsError = false
	if json.Unmarshal(body, &result) != nil || !result.Result.IsError || result.Result.StructuredContent.Error.Code != "resource_limit_exceeded" {
		t.Fatalf("full result: %+v", result)
	}
	propertyArgs := map[string]any{"projectId": project, "taskId": id, "name": "pullRequests", "valueText": "[]", "ifVersion": Decimal(before.Version)}
	_, body = rpcTaskRequest(t, server.URL, "2025-11-25", rpcTaskCall(rpcID, "2025-11-25", "task_set_property", propertyArgs))
	result.Result.IsError = false
	if json.Unmarshal(body, &result) != nil || result.Result.IsError || result.Result.StructuredContent.Data.Projection != "summary" {
		t.Fatalf("property result: %+v", result)
	}
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || after.Version != before.Version+1 || string(after.Properties["pullRequests"]) != "[]" {
		t.Fatalf("property write: %+v %v", after, err)
	}
	n, err = taskprotocol.EncodeMCPResponse(io.Discard, after, "rpc-test", "changed", rpcID, false, false, math.MaxInt64)
	if err != nil || n != int64(len(body)) {
		t.Fatalf("property measured=%d actual=%d err=%v", n, len(body), err)
	}
}

func TestTaskRPCBatchUsesEachCallID(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Batch"})
	id := data["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": project, "taskId": id, "title": before.Title, "ifVersion": Decimal(before.Version), "returnView": "full"}
	rpcID := strings.Repeat("<", 30000)
	batch := []any{rpcTaskCall(rpcID, "", "task_update", args), rpcTaskCall("small", "", "task_show", map[string]any{"projectId": project, "taskId": id})}
	resp, body := rpcTaskRequest(t, server.URL, "", batch)
	if resp.StatusCode != 200 {
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
	if json.Unmarshal(actual, &result) != nil || result.Result.IsError {
		t.Fatalf("batch update: %s", actual)
	}
	n, err := taskprotocol.EncodeMCPResponse(io.Discard, before, "rpc-test", "unchanged", rpcID, false, true, math.MaxInt64)
	if err != nil || n != int64(len(actual)) || !bytes.Contains(actual, []byte(`\u003c`)) {
		t.Fatalf("batch bound=%d actual=%d err=%v", n, len(actual), err)
	}
	args["title"] = "Rejected"
	batch = []any{rpcTaskCall("small", "", "task_update", args), rpcTaskCall(strings.Repeat("<", 90000), "", "task_show", map[string]any{"projectId": project, "taskId": id})}
	resp, body = rpcTaskRequest(t, server.URL, "", batch)
	if resp.StatusCode != 200 || json.Unmarshal(body, &messages) != nil {
		t.Fatalf("oversized batch: status=%d", resp.StatusCode)
	}
	var refusal struct {
		ID     any `json:"id"`
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
	for _, raw := range messages {
		var candidate struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(raw, &candidate) == nil && candidate.ID == "small" {
			_ = json.Unmarshal(raw, &refusal)
		}
	}
	if refusal.ID != "small" || refusal.Result.IsError {
		t.Fatalf("small batch call: %+v", refusal)
	}
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || after.Title != "Rejected" || after.Version != before.Version+1 {
		t.Fatalf("small batch update not committed: %v", err)
	}
	args["title"], args["ifVersion"] = "Must roll back", Decimal(after.Version)
	large := strings.Repeat("<", 90000)
	batch = []any{rpcTaskCall(large, "", "task_update", args), rpcTaskCall("small", "", "task_show", map[string]any{"projectId": project, "taskId": id})}
	resp, body = rpcTaskRequest(t, server.URL, "", batch)
	if resp.StatusCode != 200 || json.Unmarshal(body, &messages) != nil {
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
	final, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || !reflect.DeepEqual(after, final) {
		t.Fatalf("large batch call changed task: %v", err)
	}
}

func TestTaskRPCBatchRetainsSDKParsingSemantics(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Parsing"})
	id := data["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	args := fmt.Sprintf(`"arguments":{"projectId":%q,"taskId":%q,"title":"Parsing","ifVersion":%q,"returnView":"full"}`, project, id, Decimal(before.Version))
	for _, suffix := range []string{
		``, `,"_meta":null`, `,"_meta":{}`, `,"_meta":{"keep":{"nested":true}}`,
		`,"_meta":{"first":1},"_meta":{"second":2}`, `,"_meta":{"first":1},"_meta":null`,
		`,"_META":{"other":1},"NAME":"other"`, `,"_meta":{"keep":1},"_META":null,"Name":"other"`,
		`,"name":null`, `,"name":"task_update","name":null`,
	} {
		body := []byte(fmt.Sprintf(`[{"jsonrpc":"2.0","id":"write","method":"tools/call","params":{"name":"task_update",%s%s},"PARAMS":{"name":"other"}},{"jsonrpc":"2.0","id":"other","method":"tools/call","params":{"name":"task_show","arguments":{"projectId":%q,"taskId":%q,"extra":1e1000}}}]`, args, suffix, project, id))
		resp, raw := rpcTaskRawRequest(t, server.URL, "", body)
		var messages []struct {
			ID     any `json:"id"`
			Result struct {
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if resp.StatusCode != 200 || json.Unmarshal(raw, &messages) != nil {
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
	changedArgs := fmt.Sprintf(`"arguments":{"projectId":%q,"taskId":%q,"title":"Must not commit","ifVersion":%q}`, project, id, Decimal(before.Version))
	valid := fmt.Sprintf(`[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_update",%s}}]`, changedArgs)
	for _, invalid := range []string{"\u00a0" + valid, valid + "\u00a0", valid + " garbage"} {
		_, _ = rpcTaskRawRequest(t, server.URL, "", []byte(invalid))
		after, err := tasks.Get(context.Background(), principal, project, id)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("invalid JSON changed Task: %v", err)
		}
	}
}

func TestTaskRPCBatchExactItemBoundary(t *testing.T) {
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	data := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Batch boundary"})
	id := data["id"].(string)
	before, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": project, "taskId": id, "title": before.Title, "ifVersion": Decimal(before.Version), "returnView": "full"}
	call := func(rpcID string) (json.RawMessage, bool) {
		t.Helper()
		batch := []any{rpcTaskCall(rpcID, "", "task_update", args), rpcTaskCall("other", "", "task_show", map[string]any{"projectId": project, "taskId": id})}
		resp, raw := rpcTaskRequest(t, server.URL, "", batch)
		var messages []json.RawMessage
		if resp.StatusCode != 200 || json.Unmarshal(raw, &messages) != nil {
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
	base, failed := call("x")
	if failed {
		t.Fatal("base batch failed")
	}
	length := taskcore.MaxTaskResponseJSONBytes - len(base) + 1
	exact, failed := call(strings.Repeat("x", length))
	if failed || len(exact) != taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("exact batch item size=%d failed=%v", len(exact), failed)
	}
	_, failed = call(strings.Repeat("x", length+1))
	if !failed {
		t.Fatal("oversized batch item succeeded")
	}
	after, err := tasks.Get(context.Background(), principal, project, id)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("boundary changed Task: %v", err)
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
	client, project, principal, tasks, _, _, server := taskResourceClient(t)
	initial := taskData(t, client, "task_create", map[string]any{"projectId": project, "title": "Original"})
	id := initial["id"].(string)
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for _, rpcID := range []any{int64(0), "<&世界", strings.Repeat("<", 100000)} {
			before, err := tasks.Get(context.Background(), principal, project, id)
			if err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"projectId": project, "taskId": id, "title": "Changed " + version, "ifVersion": Decimal(before.Version), "returnView": "full"}
			resp, body := rpcTaskRequest(t, server.URL, version, rpcTaskCall(rpcID, version, "task_update", args))
			var wire struct {
				Result struct {
					IsError bool `json:"isError"`
				} `json:"result"`
			}
			if resp.StatusCode != http.StatusOK || json.Unmarshal(body, &wire) != nil || wire.Result.IsError {
				t.Fatalf("version=%s id type=%T status=%d body=%s", version, rpcID, resp.StatusCode, body[:min(len(body), 500)])
			}
			after, err := tasks.Get(context.Background(), principal, project, id)
			if err != nil {
				t.Fatal(err)
			}
			outcome := "changed"
			if after.Version == before.Version {
				outcome = "unchanged"
			}
			var measured bytes.Buffer
			n, err := taskprotocol.EncodeMCPResponse(&measured, after, "rpc-test", outcome, rpcID, version == "2026-07-28", true, math.MaxInt64)
			if err != nil {
				t.Fatal(err)
			}
			if str, ok := rpcID.(string); ok {
				n -= int64(5 * (strings.Count(str, "<") + strings.Count(str, ">") + strings.Count(str, "&")))
			}
			if n != int64(len(body)) {
				t.Fatalf("version=%s id type=%T measured=%d actual=%d", version, rpcID, n, len(body))
			}
		}
		before, err := tasks.Get(context.Background(), principal, project, id)
		if err != nil {
			t.Fatal(err)
		}
		args := map[string]any{"projectId": project, "taskId": id, "title": "Rejected", "ifVersion": Decimal(before.Version), "returnView": "full"}
		resp, body := rpcTaskRequest(t, server.URL, version, rpcTaskCall(strings.Repeat("x", 600*1024), version, "task_update", args))
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
		after, err := tasks.Get(context.Background(), principal, project, id)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("oversized ID changed Task: %v", err)
		}
	}
}
