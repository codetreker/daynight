package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/taskwork"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type workOperation func(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error)

func (f workOperation) WorkList(ctx context.Context, p model.Principal, project string, in taskcore.WorkRequest) (taskwork.Page, error) {
	return f(ctx, p, project, in)
}

func workFixture() taskwork.Page {
	stamp := time.Date(2026, 11, 10, 1, 2, 3, 123456789, time.UTC)
	return taskwork.Page{Groups: []taskwork.Group{{GroupID: testTargetID, Kind: "chain", DisplayTaskID: testTargetID, TitlePreview: "Work", AssignedTo: testUserID, AggregationScope: "accessible_in_progress_members", MemberCount: 2, MatchedCount: 1, InProgressCount: 1, RootCount: 1, Roots: []taskwork.Root{{TaskID: testTargetID, TitlePreview: "Root"}}, Summary: taskwork.Aggregation{UnknownCount: 1, ObservedAt: stamp}, Targets: []taskwork.Target{{TaskID: testTargetID, Reason: "observation_failed", Send: observationFixture().Send}}, ObservedAt: stamp}}, ObservedAt: stamp, Partial: true}
}

func validateDiscoveredResult(t *testing.T, client *sdk.ClientSession, name string, result *sdk.CallToolResult) {
	t.Helper()
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if tool.Name != name {
			continue
		}
		schema, err := resolveSchema(tool.OutputSchema)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(structured(t, result))
		if err != nil {
			t.Fatal(err)
		}
		if err := validateJSON(schema, raw); err != nil {
			t.Fatalf("%s protocol result violates advertised schema: %v\n%s", name, err, raw)
		}
		return
	}
	t.Fatalf("tool %s was not discovered", name)
}

func TestTaskWorkToolPreservesUseCasePagingAndStrictProtocol(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	cursor, assigned, group := "target-cursor", testUserID, testTargetID
	err := RegisterTaskWorkTools(f.entry, workOperation(func(ctx context.Context, p model.Principal, project string, in taskcore.WorkRequest) (taskwork.Page, error) {
		calls++
		if ctx.Err() != nil || p.UserID == "" || project != testProjectID || in.AssignedTo == nil || *in.AssignedTo != assigned || in.GroupID == nil || *in.GroupID != group || in.TargetsCursor == nil || *in.TargetsCursor != cursor || in.Limit != 7 || in.Cursor != nil || in.ResponseOverhead <= 0 {
			t.Errorf("work input lost context or pagination: %+v %+v %s", p, in, project)
		}
		return workFixture(), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	args := map[string]any{"projectId": testProjectID, "assignedTo": assigned, "groupId": group, "targetsCursor": cursor, "limit": 7}
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_work_list", Arguments: args})
	if err != nil || result.IsError || calls != 1 {
		t.Fatalf("work=%+v %v calls=%d", result, err, calls)
	}
	validateDiscoveredResult(t, client, "task_work_list", result)
	env := structured(t, result)
	if object(t, env["meta"])["partial"] != true || len(object(t, env["data"])["groups"].([]any)) != 1 {
		t.Fatalf("partial work lost: %#v", env)
	}
	for _, invalid := range []map[string]any{{"groupId": group}, {"targetsCursor": cursor}, {"groupId": group, "targetsCursor": cursor, "cursor": "group-cursor"}, {"limit": 51}, {"responseOverhead": 0}, {"assignedTo": "unassigned"}} {
		invalid["projectId"] = testProjectID
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_work_list", Arguments: invalid})
		if err != nil || !result.IsError || calls != 1 {
			t.Fatalf("invalid input reached work use case: %+v %v calls=%d", result, err, calls)
		}
		validateDiscoveredResult(t, client, "task_work_list", result)
	}
}

func TestWorkResponseOverheadAccountsForActualRPCIdentity(t *testing.T) {
	for _, modern := range []bool{false, true} {
		for _, batch := range []bool{false, true} {
			actor := RequestActor{RequestID: "request", rpcModern: modern, rpcBatch: batch, rpcResponseID: strings.Repeat("<", 30000)}
			refs := map[string]any{"projectId": testProjectID, "groupId": testTargetID}
			large, err := workResponseOverhead(actor, refs)
			if err != nil {
				t.Fatal(err)
			}
			actor.rpcResponseID = "id"
			small, err := workResponseOverhead(actor, refs)
			if err != nil {
				t.Fatal(err)
			}
			if large-small != 180000-2 || small <= 100 || large >= taskwork.MaxResponseBytes {
				t.Fatalf("overhead large=%d small=%d", large, small)
			}
		}
	}
}

func TestSessionRegistrationOnlyPublishesImplementedModules(t *testing.T) {
	f := newEntryFixture(t)
	if err := RegisterSessionTools(f.entry); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range listed.Tools {
		if strings.HasPrefix(tool.Name, "task_session_") {
			t.Fatalf("unimplemented tool advertised: %s", tool.Name)
		}
	}
	sentinel := errors.New("module registration failed")
	calls := 0
	if err := RegisterSessionTools(f.entry, func(actual *Entry) error {
		calls++
		if actual != f.entry {
			t.Error("entry changed")
		}
		return sentinel
	}, func(*Entry) error { t.Error("registered after error"); return nil }); !errors.Is(err, sentinel) || calls != 1 {
		t.Fatalf("module error lost: %v calls=%d", err, calls)
	}
	if RegisterSessionTools(nil) == nil || RegisterSessionTools(f.entry, nil) == nil {
		t.Fatal("missing registration dependency accepted")
	}
}

func TestWorkDedicatedBudgetCoversActualSingleAndBatchResponses(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for _, batch := range []bool{false, true} {
			if batch && version == "2026-07-28" {
				continue
			}
			t.Run(version+map[bool]string{false: "/single", true: "/batch"}[batch], func(t *testing.T) {
				f := newEntryFixture(t)
				calls := 0
				var overhead int
				err := RegisterTaskWorkTools(f.entry, workOperation(func(_ context.Context, _ model.Principal, _ string, in taskcore.WorkRequest) (taskwork.Page, error) {
					calls++
					overhead = in.ResponseOverhead
					page := workFixture()
					raw, _ := json.Marshal(page)
					// The operation mock returns a page exactly at its delegated byte budget;
					// core tests separately exercise fitting real bounded previews and cursors.
					page.Groups[0].TitlePreview += strings.Repeat("x", taskwork.MaxResponseBytes-overhead-len(raw))
					return page, nil
				}))
				if err != nil {
					t.Fatal(err)
				}
				id := strings.Repeat("x", 30000)
				call := rpcTaskCall(id, version, "task_work_list", map[string]any{"projectId": testProjectID})
				var input any = call
				if batch {
					input = []any{call}
				}
				encoded, _ := json.Marshal(input)
				request, err := http.NewRequest("POST", f.server.URL, bytes.NewReader(encoded))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Authorization", "Bearer alice")
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Accept", "application/json, text/event-stream")
				request.Header.Set("X-Request-ID", "rpc-test")
				if !batch {
					request.Header.Set("MCP-Protocol-Version", version)
				}
				if version == "2026-07-28" {
					request.Header.Set("MCP-Method", "tools/call")
					request.Header.Set("MCP-Name", "task_work_list")
				}
				response, err := (&http.Client{Timeout: 5 * time.Second}).Do(request)
				if err != nil {
					t.Fatal(err)
				}
				defer response.Body.Close()
				raw, err := io.ReadAll(response.Body)
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != 200 || calls != 1 || overhead < 30000 || len(raw) > taskwork.MaxResponseBytes || len(raw) < taskwork.MaxResponseBytes-40 {
					t.Fatalf("complete wire status=%d calls=%d overhead=%d bytes=%d", response.StatusCode, calls, overhead, len(raw))
				}
				var replies []map[string]any
				if batch {
					err = json.Unmarshal(raw, &replies)
				} else {
					var reply map[string]any
					err = json.Unmarshal(raw, &reply)
					replies = []map[string]any{reply}
				}
				if err != nil || len(replies) != 1 || replies[0]["id"] != id || object(t, replies[0]["result"])["isError"] == true {
					t.Fatalf("work response lost identity or data: %v", err)
				}
			})
		}
	}
}

func TestWorkToolRefusesOversizedEnvelopeAndPreservesReadErrors(t *testing.T) {
	f := newEntryFixture(t)
	calls := 0
	failure := &model.Fault{Code: "reset_required", Message: "The Task graph changed; restart the overview."}
	if err := RegisterTaskWorkTools(f.entry, workOperation(func(context.Context, model.Principal, string, taskcore.WorkRequest) (taskwork.Page, error) {
		calls++
		return taskwork.Page{}, failure
	})); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id, code string
		calls    int
	}{{strings.Repeat("x", taskwork.MaxResponseBytes), "resource_limit_exceeded", 0}, {"small", "reset_required", 1}} {
		response, raw := rpcTaskRequest(t, f.server.URL, "2025-11-25", rpcTaskCall(test.id, "2025-11-25", "task_work_list", map[string]any{"projectId": testProjectID}))
		var result struct {
			Result struct {
				IsError           bool `json:"isError"`
				StructuredContent struct {
					Error map[string]any `json:"error"`
				} `json:"structuredContent"`
			} `json:"result"`
		}
		if response.StatusCode != 200 || json.Unmarshal(raw, &result) != nil || !result.Result.IsError || result.Result.StructuredContent.Error["code"] != test.code || calls != test.calls {
			t.Fatalf("refusal status=%d error=%+v calls=%d", response.StatusCode, result.Result.StructuredContent.Error, calls)
		}
		if _, present := result.Result.StructuredContent.Error["writeOutcome"]; present {
			t.Fatal("work read failure acquired write receipt")
		}
	}
}
