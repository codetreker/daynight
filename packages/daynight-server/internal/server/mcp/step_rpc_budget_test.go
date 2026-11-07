package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func stepRPCRequest(t *testing.T, endpoint, version, name string, value any) []byte {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer alice")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	request.Header.Set("X-Request-ID", "rpc-test")
	if version != "" {
		request.Header.Set("MCP-Protocol-Version", version)
	}
	if version == "2026-07-28" {
		request.Header.Set("MCP-Method", "tools/call")
		request.Header.Set("MCP-Name", name)
	}
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	result, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("status=%d body=%s err=%v", response.StatusCode, result[:min(500, len(result))], err)
	}
	return result
}

func stepWireResult(t *testing.T, body []byte) (bool, map[string]any) {
	t.Helper()
	var response struct {
		Result struct {
			IsError           bool           `json:"isError"`
			StructuredContent map[string]any `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("decode wire: %v", err)
	}
	return response.Result.IsError, response.Result.StructuredContent
}

func TestStepRPCFullShowWireBudget(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			ops := sampleStepReads(1, "step")
			if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "00000000", "view": "full"}
			for _, character := range []string{"x", "<"} {
				base := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(character, version, "task_step_show", args))
				if bad, _ := stepWireResult(t, base); bad {
					t.Fatal("base show failed")
				}
				idLength := (512 << 10) - len(base) + 1
				exact := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(strings.Repeat(character, idLength), version, "task_step_show", args))
				if bad, _ := stepWireResult(t, exact); bad || len(exact) != 512<<10 {
					t.Fatalf("exact wire size=%d error=%v", len(exact), bad)
				}
				excess := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(strings.Repeat(character, idLength+1), version, "task_step_show", args))
				bad, content := stepWireResult(t, excess)
				if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
					t.Fatalf("oversized ID: %+v", content)
				}
			}
			ops.items[0].Step.Description = "x"
			base := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(int64(0), version, "task_step_show", args))
			length := (512 << 10) - len(base) + 1
			ops.items[0].Step.Description = strings.Repeat("x", length)
			exact := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(int64(0), version, "task_step_show", args))
			if bad, _ := stepWireResult(t, exact); bad || len(exact) != 512<<10 {
				t.Fatalf("exact historical item size=%d error=%v", len(exact), bad)
			}
			ops.items[0].Step.Description += "x"
			excess := stepRPCRequest(t, fixture.server.URL, version, "task_step_show", rpcTaskCall(int64(0), version, "task_step_show", args))
			bad, content := stepWireResult(t, excess)
			if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
				t.Fatalf("oversized item: %+v", content)
			}
		})
	}
}

func TestStepRPCListWireBudgetAndCursor(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(version, func(t *testing.T) {
			fixture := newEntryFixture(t)
			ops := sampleStepReads(2, "step")
			if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
				t.Fatal(err)
			}
			args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "view": "full", "limit": 1}
			ops.items[0].Step.Description = "x"
			base := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content := stepWireResult(t, base)
			if bad || object(t, content["data"])["nextCursor"] == nil {
				t.Fatalf("base list: %+v", content)
			}
			length := (4 << 20) - len(base) + 1
			ops.items[0].Step.Description = strings.Repeat("x", length)
			exact := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content = stepWireResult(t, exact)
			if bad || len(exact) != 4<<20 {
				t.Fatalf("exact page size=%d error=%v", len(exact), bad)
			}
			cursor := object(t, content["data"])["nextCursor"]
			args["cursor"] = cursor
			next := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content = stepWireResult(t, next)
			items := object(t, content["data"])["items"].([]any)
			if bad || len(items) != 1 || object(t, items[0])["id"] != "00000001" {
				t.Fatalf("continuation: %+v", content)
			}
			delete(args, "cursor")
			ops.items[0].Step.Description += "x"
			excess := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content = stepWireResult(t, excess)
			if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
				t.Fatalf("oversized page item: %+v", content)
			}
			ops.items = sampleStepReads(12, strings.Repeat("\x01", 512)).items
			args["view"], args["limit"] = "summary", 100
			summary := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content = stepWireResult(t, summary)
			if bad || len(summary) > 16<<10 {
				t.Fatalf("summary wire size=%d error=%v", len(summary), bad)
			}
			summaryData := object(t, content["data"])
			summaryItems := summaryData["items"].([]any)
			if len(summaryItems) == 0 || len(summaryItems) >= len(ops.items) || summaryData["nextCursor"] == nil {
				t.Fatalf("summary did not return a bounded prefix: %+v", summaryData)
			}
			args["cursor"] = summaryData["nextCursor"]
			summaryNext := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(int64(0), version, "task_step_list", args))
			bad, content = stepWireResult(t, summaryNext)
			nextItems := object(t, content["data"])["items"].([]any)
			if bad || len(summaryNext) > 16<<10 || len(nextItems) == 0 || object(t, nextItems[0])["id"] != fmt.Sprintf("%08x", len(summaryItems)) {
				t.Fatalf("summary continuation: %+v", content)
			}
			delete(args, "cursor")
			ops.items = nil
			for _, character := range []string{"x", "<"} {
				base := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(character, version, "task_step_list", args))
				if bad, _ := stepWireResult(t, base); bad {
					t.Fatal("empty base failed")
				}
				idLength := (16 << 10) - len(base) + 1
				exact := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(strings.Repeat(character, idLength), version, "task_step_list", args))
				if bad, _ := stepWireResult(t, exact); bad || len(exact) != 16<<10 {
					t.Fatalf("empty exact size=%d error=%v", len(exact), bad)
				}
				empty := stepRPCRequest(t, fixture.server.URL, version, "task_step_list", rpcTaskCall(strings.Repeat(character, idLength+1), version, "task_step_list", args))
				bad, content = stepWireResult(t, empty)
				if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
					t.Fatalf("oversized empty response: %+v", content)
				}
			}
		})
	}
}

func TestStepRPCBatchUsesEachIDForBudget(t *testing.T) {
	fixture := newEntryFixture(t)
	ops := sampleStepReads(1, "step")
	if err := RegisterStepReadTools(fixture.entry, ops); err != nil {
		t.Fatal(err)
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "00000000", "view": "full"}
	call := func(id string) []json.RawMessage {
		smallArgs := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "00000000", "view": "summary"}
		batch := []any{rpcTaskCall(id, "", "task_step_show", args), rpcTaskCall("small", "", "task_step_show", smallArgs)}
		body := stepRPCRequest(t, fixture.server.URL, "", "task_step_show", batch)
		var result []json.RawMessage
		if err := json.Unmarshal(body, &result); err != nil || len(result) != 2 {
			t.Fatalf("batch decode %v", err)
		}
		var first struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(result[0], &first); err != nil {
			t.Fatal(err)
		}
		if first.ID == "small" {
			result[0], result[1] = result[1], result[0]
		} else if first.ID != id {
			t.Fatal("unexpected batch response ID")
		}
		return result
	}
	base := call("x")
	length := (512 << 10) - len(base[0]) + 1
	exact := call(strings.Repeat("x", length))
	if bad, content := stepWireResult(t, exact[0]); bad || len(exact[0]) != 512<<10 {
		t.Fatalf("batch exact=%d error=%v content=%+v", len(exact[0]), bad, content)
	}
	excess := call(strings.Repeat("x", length+1))
	bad, content := stepWireResult(t, excess[0])
	if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
		t.Fatalf("batch excess: %+v", content)
	}
	if bad, content := stepWireResult(t, excess[1]); bad {
		t.Fatalf("other batch item: %+v", content)
	}
	escapedBase := call("<")
	difference := (512 << 10) - len(escapedBase[0])
	ops.items[0].Step.Description += strings.Repeat("x", difference%6)
	escapedLength := 1 + difference/6
	escapedExact := call(strings.Repeat("<", escapedLength))
	if bad, content := stepWireResult(t, escapedExact[0]); bad || len(escapedExact[0]) != 512<<10 {
		t.Fatalf("batch escaped exact=%d error=%v content=%+v", len(escapedExact[0]), bad, content)
	}
	escaped := call(strings.Repeat("<", escapedLength+1))
	bad, content = stepWireResult(t, escaped[0])
	if !bad || object(t, content["error"])["code"] != "resource_limit_exceeded" {
		t.Fatalf("batch escaped ID: %+v", content)
	}
}
