package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcodec "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/codec"
	tasksteps "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/steps"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPStepsProductionLifecycle(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			principal := defaultHTTPPrincipal()
			outsider := principal
			outsider.UserID, outsider.CredentialID = "e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"
			token, otherToken := defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
			production, ops := newMCPStepOperationServer(t, attachmentTestFiles(t), map[string]model.Principal{token: principal, otherToken: outsider})
			connect := func(token string) *sdk.ClientSession {
				t.Helper()
				client := sdk.NewClient(&sdk.Implementation{Name: "mcp-steps-integration", Version: "1"}, nil)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: production.URL + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := session.Close(); err != nil {
						t.Errorf("close session: %v", err)
					}
				})
				return session
			}
			alice, bob := connect(token), connect(otherToken)
			obj := func(value any) map[string]any {
				t.Helper()
				out, ok := value.(map[string]any)
				if !ok {
					t.Fatalf("expected object: %#v", value)
				}
				return out
			}
			call := func(client *sdk.ClientSession, name, taskID string, extra map[string]any) (map[string]any, bool) {
				t.Helper()
				args := map[string]any{"projectId": mcpStepsProjectID, "taskId": taskID}
				for k, v := range extra {
					args[k] = v
				}
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				result, err := client.CallTool(ctx, &sdk.CallToolParams{Name: name, Arguments: args})
				if err != nil {
					t.Fatal(err)
				}
				encoded, err := json.Marshal(result.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				var out map[string]any
				if err = json.Unmarshal(encoded, &out); err != nil {
					t.Fatal(err)
				}
				return out, result.IsError
			}
			equal := func(label string, got, want any) {
				t.Helper()
				if !reflect.DeepEqual(got, want) {
					t.Errorf("%s: got %#v, want %#v", label, got, want)
				}
			}
			header := func(taskID string, version int64) model.TaskHeader {
				return model.TaskHeader{ProjectID: mcpStepsProjectID, ID: taskID, Version: version}
			}
			now := time.Date(2026, 11, 8, 12, 0, 0, 123456000, time.UTC)
			row := func(id, title, description string, status model.TaskStepStatus, position int64) model.TaskStep {
				return model.TaskStep{ID: id, Title: title, Description: description, Status: status, Position: position, CreatedAt: now, UpdatedAt: now}
			}
			resource := func(taskID string, version int64, rows ...model.TaskStep) taskservice.StepsWriteResult {
				steps := make([]taskcodec.Step, len(rows))
				for i, r := range rows {
					steps[i] = taskcodec.Step{ID: r.ID, Title: r.Title, Description: r.Description, Status: r.Status, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
				}
				return taskservice.StepsWriteResult{StepsDocument: taskservice.StepsDocument{Resource: taskcodec.StepsResource{ProjectID: mcpStepsProjectID, TaskID: taskID, Version: version, Steps: steps}}, Phase: "commit", TransactionOutcome: store.TransactionCommitted}
			}
			projections := func(rows ...model.TaskStep) []store.TaskStepProjection {
				out := make([]store.TaskStepProjection, len(rows))
				for i, r := range rows {
					out[i] = store.TaskStepProjection{Step: r}
				}
				return out
			}
			str := func(s string) *string { return &s }
			versionPtr := func(v int64) *int64 { return &v }
			type pageWant struct {
				after   int64
				limit   int
				version *int64
				summary bool
				page    taskservice.StepsPage
				err     error
			}
			type request struct {
				actor                        model.Principal
				client                       *sdk.ClientSession
				name, taskID, method, stepID string
				args                         map[string]any
				pre                          *pageWant
				page                         *pageWant
				input                        any
				write                        taskservice.StepsWriteResult
				doc                          taskservice.StepDocument
				summary                      taskservice.StepSummary
				err                          error
			}
			dispatch := func(r request) (map[string]any, bool) {
				t.Helper()
				methods := []string{}
				if r.pre != nil {
					methods = append(methods, "ListPage")
				}
				if r.method != "" {
					methods = append(methods, r.method)
				}
				plan := ops.plan(r.actor, methods...)
				verifyScope := func(projectID, taskID string) {
					equal("project", projectID, mcpStepsProjectID)
					equal("task", taskID, r.taskID)
				}
				if r.pre != nil || r.page != nil {
					want := r.page
					if r.pre != nil {
						want = r.pre
					}
					plan.onListPage = func(_ context.Context, _ model.Principal, projectID, taskID string, after int64, limit int, version *int64, summary bool) (taskservice.StepsPage, error) {
						verifyScope(projectID, taskID)
						equal("after", after, want.after)
						equal("limit", limit, want.limit)
						equal("version", version, want.version)
						equal("summary", summary, want.summary)
						return want.page, want.err
					}
				}
				switch r.method {
				case "Add":
					plan.onAdd = func(_ context.Context, _ model.Principal, projectID, taskID string, in taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
						verifyScope(projectID, taskID)
						equal("Add input", in, r.input)
						return r.write, r.err
					}
				case "Update":
					plan.onUpdate = func(_ context.Context, _ model.Principal, projectID, taskID, id string, in taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
						verifyScope(projectID, taskID)
						equal("Update ID", id, r.stepID)
						equal("Update input", in, r.input)
						return r.write, r.err
					}
				case "SetStatus":
					plan.onSetStatus = func(_ context.Context, _ model.Principal, projectID, taskID, id string, in taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
						verifyScope(projectID, taskID)
						equal("Status ID", id, r.stepID)
						equal("Status input", in, r.input)
						return r.write, r.err
					}
				case "Move":
					plan.onMove = func(_ context.Context, _ model.Principal, projectID, taskID, id string, in taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
						verifyScope(projectID, taskID)
						equal("Move ID", id, r.stepID)
						equal("Move input", in, r.input)
						return r.write, r.err
					}
				case "Delete":
					plan.onDelete = func(_ context.Context, _ model.Principal, projectID, taskID, id string, in taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
						verifyScope(projectID, taskID)
						equal("Delete ID", id, r.stepID)
						equal("Delete input", in, r.input)
						return r.write, r.err
					}
				case "Get":
					plan.onGet = func(_ context.Context, _ model.Principal, projectID, taskID, id string) (taskservice.StepDocument, error) {
						verifyScope(projectID, taskID)
						equal("Get ID", id, r.stepID)
						return r.doc, r.err
					}
				case "GetSummary":
					plan.onGetSummary = func(_ context.Context, _ model.Principal, projectID, taskID, id string) (taskservice.StepSummary, error) {
						verifyScope(projectID, taskID)
						equal("GetSummary ID", id, r.stepID)
						return r.summary, r.err
					}
				}
				out, failed := call(r.client, r.name, r.taskID, r.args)
				plan.verify()
				return out, failed
			}
			success := func(r request) map[string]any {
				t.Helper()
				out, failed := dispatch(r)
				if failed {
					t.Fatalf("%s: %+v", r.name, out)
				}
				return obj(out["data"])
			}
			checkReceipt := func(data map[string]any, version, id string, count int, changed bool, position *int, status model.TaskStepStatus, title string) {
				t.Helper()
				if data["projection"] != "summary" || data["projectId"] != mcpStepsProjectID || data["taskId"] != mcpStepsTaskID || data["version"] != version || data["stepId"] != id || data["stepCount"] != float64(count) || data["changed"] != changed {
					t.Fatalf("receipt: %+v", data)
				}
				if position != nil {
					step := obj(data["step"])
					if step["id"] != id || step["position"] != float64(*position) || step["status"] != string(status) || step["titlePreview"] != title || step["titleTruncated"] != false {
						t.Fatalf("receipt step: %+v", data)
					}
				} else if _, ok := data["step"]; ok {
					t.Fatalf("deleted step in receipt: %+v", data)
				}
			}
			position := func(value int) *int { return &value }
			failure := func(r request, code string) map[string]any {
				t.Helper()
				out, failed := dispatch(r)
				if !failed || obj(out["error"])["code"] != code {
					t.Fatalf("%s wanted %s: %+v", r.name, code, out)
				}
				return obj(out["error"])
			}
			peek := func(taskID string, v int64) *pageWant {
				return &pageWant{after: -1, limit: 1, summary: true, page: taskservice.StepsPage{Header: header(taskID, v), Items: []store.TaskStepProjection{}}}
			}
			fault := func(code, message string) error { return &model.Fault{Code: code, Message: message} }
			refusal := taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}
			const limitID = "a7777777-7777-4777-8777-777777777777"
			version := int64(1)
			limitRows := []model.TaskStep{}
			for i, tc := range []struct{ field, valid, excess string }{{"title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"}, {"description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"}} {
				id := fmt.Sprintf("%08x", i+1)
				base := request{actor: principal, client: alice, taskID: limitID}
				title, description := "x", ""
				if tc.field == "title" {
					title = tc.excess
				} else {
					description = tc.excess
				}
				r := base
				r.name = "task_step_add"
				r.method = "Add"
				r.args = map[string]any{"id": id, "title": "x", tc.field: tc.excess, "ifVersion": strconv.FormatInt(version, 10)}
				r.input = taskservice.AddTaskStep{Version: version, ID: id, Title: title, Description: description}
				r.write = refusal
				r.err = fault("invalid_input", tc.field+" exceeds limit")
				err := failure(r, "invalid_input")
				if err["writeOutcome"] != "not_committed" || !strings.Contains(err["message"].(string), tc.field) {
					t.Fatalf("field refusal: %+v", err)
				}
				title, description = "x", ""
				if tc.field == "title" {
					title = tc.valid
				} else {
					description = tc.valid
				}
				valid := row(id, title, description, model.TaskStepTodo, int64(i))
				nextRows := append(append([]model.TaskStep{}, limitRows...), valid)
				r = base
				r.name = "task_step_add"
				r.method = "Add"
				r.args = map[string]any{"id": id, "title": "x", tc.field: tc.valid, "ifVersion": strconv.FormatInt(version, 10)}
				r.input = taskservice.AddTaskStep{Version: version, ID: id, Title: title, Description: description}
				r.write = resource(limitID, version+1, nextRows...)
				r.write.Changed = true
				data := success(r)
				version++
				if data["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("add version: %+v", data)
				}
				limitRows = nextRows
				r = base
				r.name = "task_step_update"
				r.method = "Update"
				r.stepID = id
				r.args = map[string]any{"stepId": id, tc.field: tc.excess, "ifVersion": strconv.FormatInt(version, 10)}
				input := taskservice.UpdateTaskStep{Version: version}
				if tc.field == "title" {
					input.Title = str(tc.excess)
				} else {
					input.Description = str(tc.excess)
				}
				r.input = input
				r.write = refusal
				r.err = fault("invalid_input", tc.field+" exceeds limit")
				err = failure(r, "invalid_input")
				if err["writeOutcome"] != "not_committed" || !strings.Contains(err["message"].(string), tc.field) {
					t.Fatalf("field refusal: %+v", err)
				}
				short := valid
				if tc.field == "title" {
					short.Title = "short"
				} else {
					short.Description = "short"
				}
				shortRows := append([]model.TaskStep{}, limitRows...)
				shortRows[i] = short
				r = base
				r.name = "task_step_update"
				r.method = "Update"
				r.stepID = id
				r.args = map[string]any{"stepId": id, tc.field: "short", "ifVersion": strconv.FormatInt(version, 10)}
				input = taskservice.UpdateTaskStep{Version: version}
				if tc.field == "title" {
					input.Title = str("short")
				} else {
					input.Description = str("short")
				}
				r.input = input
				r.write = resource(limitID, version+1, shortRows...)
				r.write.Changed = true
				data = success(r)
				version++
				if data["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("update version: %+v", data)
				}
				r = base
				r.name = "task_step_update"
				r.method = "Update"
				r.stepID = id
				r.args = map[string]any{"stepId": id, tc.field: tc.valid, "ifVersion": strconv.FormatInt(version, 10)}
				input = taskservice.UpdateTaskStep{Version: version}
				if tc.field == "title" {
					input.Title = str(tc.valid)
				} else {
					input.Description = str(tc.valid)
				}
				r.input = input
				r.write = resource(limitID, version+1, limitRows...)
				r.write.Changed = true
				data = success(r)
				version++
				if data["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("restore version: %+v", data)
				}
			}
			base := request{actor: principal, client: alice, taskID: mcpStepsTaskID}
			denied := request{actor: outsider, client: bob, taskID: mcpStepsTaskID, name: "task_step_list", method: "ListPage", page: &pageWant{after: -1, limit: 50, summary: true, err: fault("not_found", "not found")}}
			err := failure(denied, "not_found")
			if _, ok := err["refs"]; ok {
				t.Fatalf("unauthorized list leaks refs: %+v", err)
			}
			denied = request{actor: outsider, client: bob, taskID: mcpStepsTaskID, name: "task_step_add", args: map[string]any{"id": "00000001", "title": "blocked"}, pre: &pageWant{after: -1, limit: 1, summary: true, err: fault("not_found", "not found")}}
			failure(denied, "not_found")
			first0 := row("abcdef01", "First", "first body", model.TaskStepTodo, 0)
			first1 := row("abcdef01", "First", "first body", model.TaskStepTodo, 1)
			second0 := row("abcdef02", "Second", "", model.TaskStepTodo, 0)
			third2 := row("abcdef03", "Third", "", model.TaskStepTodo, 2)
			r := base
			r.name = "task_step_add"
			r.method = "Add"
			r.args = map[string]any{"id": "ABCDEF01", "title": "First", "description": "first body"}
			r.pre = peek(mcpStepsTaskID, 1)
			r.input = taskservice.AddTaskStep{Version: 1, ID: "abcdef01", Title: "First", Description: "first body"}
			r.write = resource(mcpStepsTaskID, 2, first0)
			r.write.Changed = true
			receipt := success(r)
			if receipt["stepId"] != "abcdef01" || receipt["version"] != "2" || receipt["changed"] != true || obj(receipt["step"])["status"] != "todo" {
				t.Fatalf("first receipt: %+v", receipt)
			}
			r = base
			r.name = "task_step_add"
			r.method = "Add"
			r.args = map[string]any{"id": "abcdef02", "title": "Second", "before": "abcdef01"}
			r.pre = peek(mcpStepsTaskID, 2)
			r.input = taskservice.AddTaskStep{Version: 2, ID: "abcdef02", Title: "Second", Before: str("abcdef01")}
			r.write = resource(mcpStepsTaskID, 3, second0, first1)
			r.write.Changed = true
			receipt = success(r)
			checkReceipt(receipt, "3", "abcdef02", 2, true, position(0), model.TaskStepTodo, "Second")
			r = base
			r.name = "task_step_add"
			r.method = "Add"
			r.args = map[string]any{"id": "abcdef03", "title": "Third", "after": "abcdef01"}
			r.pre = peek(mcpStepsTaskID, 3)
			r.input = taskservice.AddTaskStep{Version: 3, ID: "abcdef03", Title: "Third", After: str("abcdef01")}
			r.write = resource(mcpStepsTaskID, 4, second0, first1, third2)
			r.write.Changed = true
			receipt = success(r)
			checkReceipt(receipt, "4", "abcdef03", 3, true, position(2), model.TaskStepTodo, "Third")
			r = base
			r.name = "task_step_list"
			r.method = "ListPage"
			r.args = map[string]any{"limit": 2}
			r.page = &pageWant{after: -1, limit: 2, summary: true, page: taskservice.StepsPage{Header: header(mcpStepsTaskID, 4), Items: projections(second0, first1), HasMore: true}}
			page := success(r)
			items := page["items"].([]any)
			if page["version"] != "4" || page["projection"] != "summary" || len(items) != 2 || obj(items[0])["id"] != "abcdef02" || obj(items[1])["id"] != "abcdef01" || obj(items[1])["position"] != float64(1) {
				t.Fatalf("first page: %+v", page)
			}
			cursor, ok := page["nextCursor"].(string)
			if !ok || cursor == "" {
				t.Fatalf("missing cursor: %+v", page)
			}
			r = base
			r.name = "task_step_list"
			r.method = "ListPage"
			r.args = map[string]any{"limit": 2, "cursor": cursor}
			r.page = &pageWant{after: 1, limit: 2, version: versionPtr(4), summary: true, page: taskservice.StepsPage{Header: header(mcpStepsTaskID, 4), Items: projections(third2)}}
			tail := success(r)
			if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["id"] != "abcdef03" || tail["nextCursor"] != nil {
				t.Fatalf("tail: %+v", tail)
			}
			r = base
			r.name = "task_step_show"
			r.method = "Get"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01", "view": "full"}
			r.doc = taskservice.StepDocument{Resource: taskcodec.StepResource{ProjectID: mcpStepsProjectID, TaskID: mcpStepsTaskID, Version: 4, Step: taskcodec.Step{ID: "abcdef01", Title: "First", Description: "first body", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}}}
			full := success(r)
			if full["version"] != "4" || obj(full["step"])["description"] != "first body" {
				t.Fatalf("full show: %+v", full)
			}
			revised1 := row("abcdef01", "First", "revised", model.TaskStepTodo, 1)
			r = base
			r.name = "task_step_update"
			r.method = "Update"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4", "returnView": "full"}
			r.input = taskservice.UpdateTaskStep{Version: 4, Description: str("revised")}
			r.write = resource(mcpStepsTaskID, 5, second0, revised1, third2)
			r.write.Changed = true
			updated := success(r)
			if updated["version"] != "5" || len(updated["steps"].([]any)) != 3 || obj(updated["steps"].([]any)[1])["description"] != "revised" {
				t.Fatalf("full update: %+v", updated)
			}
			r = base
			r.name = "task_step_list"
			r.method = "ListPage"
			r.args = map[string]any{"limit": 2, "cursor": cursor}
			r.page = &pageWant{after: 1, limit: 2, version: versionPtr(4), summary: true, err: fault("version_conflict", "version conflict")}
			conflict := failure(r, "version_conflict")
			if _, ok := conflict["writeOutcome"]; ok {
				t.Fatalf("read conflict claimed a write outcome: %+v", conflict)
			}
			r = base
			r.name = "task_step_update"
			r.method = "Update"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4"}
			r.input = taskservice.UpdateTaskStep{Version: 4, Description: str("revised")}
			r.write = refusal
			r.err = fault("version_conflict", "version conflict")
			writeConflict := failure(r, "version_conflict")
			if writeConflict["writeOutcome"] != "not_committed" {
				t.Fatalf("write conflict outcome: %+v", writeConflict)
			}
			r = base
			r.name = "task_step_update"
			r.method = "Update"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "5"}
			r.input = taskservice.UpdateTaskStep{Version: 5, Description: str("revised")}
			r.write = resource(mcpStepsTaskID, 5, second0, revised1, third2)
			noop := success(r)
			if noop["changed"] != false || noop["version"] != "5" {
				t.Fatalf("noop: %+v", noop)
			}
			r = base
			r.name = "task_step_move"
			r.method = "Move"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01", "before": "ABCDEF01", "ifVersion": "5"}
			r.input = taskservice.MoveTaskStep{Version: 5, Before: str("ABCDEF01")}
			r.write = refusal
			r.err = fault("invalid_input", "self move")
			failure(r, "invalid_input")
			for _, tc := range []struct {
				status        model.TaskStepStatus
				before, after int64
				changed       bool
			}{{model.TaskStepTodo, 5, 5, false}, {model.TaskStepInProgress, 5, 6, true}, {model.TaskStepDone, 6, 7, true}, {model.TaskStepSkipped, 7, 8, true}} {
				current := row("abcdef02", "Second", "", tc.status, 0)
				r = base
				r.name = "task_step_set_status"
				r.method = "SetStatus"
				r.stepID = "abcdef02"
				r.args = map[string]any{"stepId": "abcdef02", "status": string(tc.status)}
				r.pre = peek(mcpStepsTaskID, tc.before)
				r.input = taskservice.SetTaskStepStatus{Version: tc.before, Status: tc.status}
				r.write = resource(mcpStepsTaskID, tc.after, current, revised1, third2)
				r.write.Changed = tc.changed
				out := success(r)
				checkReceipt(out, strconv.FormatInt(tc.after, 10), "abcdef02", 3, tc.changed, position(0), tc.status, "Second")
				if obj(out["step"])["status"] != string(tc.status) {
					t.Fatalf("status %s: %+v", tc.status, out)
				}
			}
			third0 := row("abcdef03", "Third", "", model.TaskStepTodo, 0)
			second1 := row("abcdef02", "Second", "", model.TaskStepSkipped, 1)
			revised2 := row("abcdef01", "First", "revised", model.TaskStepTodo, 2)
			r = base
			r.name = "task_step_move"
			r.method = "Move"
			r.stepID = "abcdef03"
			r.args = map[string]any{"stepId": "abcdef03", "position": "first"}
			r.pre = peek(mcpStepsTaskID, 8)
			r.input = taskservice.MoveTaskStep{Version: 8, Position: str("first")}
			r.write = resource(mcpStepsTaskID, 9, third0, second1, revised2)
			r.write.Changed = true
			receipt = success(r)
			checkReceipt(receipt, "9", "abcdef03", 3, true, position(0), model.TaskStepTodo, "Third")
			r = base
			r.name = "task_step_list"
			r.method = "ListPage"
			r.args = map[string]any{"view": "full"}
			r.page = &pageWant{after: -1, limit: 50, summary: false, page: taskservice.StepsPage{Header: header(mcpStepsTaskID, 9), Items: projections(third0, second1, revised2)}}
			ordered := success(r)
			values := ordered["items"].([]any)
			if len(values) != 3 || obj(values[0])["id"] != "abcdef03" || obj(values[1])["id"] != "abcdef02" || obj(values[2])["id"] != "abcdef01" {
				t.Fatalf("order: %+v", ordered)
			}
			secondAfterDelete := row("abcdef02", "Second", "", model.TaskStepSkipped, 0)
			firstAfterDelete := row("abcdef01", "First", "revised", model.TaskStepTodo, 1)
			firstOnly := row("abcdef01", "First", "revised", model.TaskStepTodo, 0)
			for _, tc := range []struct {
				id      string
				version int64
				rows    []model.TaskStep
			}{{"abcdef03", 9, []model.TaskStep{secondAfterDelete, firstAfterDelete}}, {"abcdef02", 10, []model.TaskStep{firstOnly}}, {"abcdef01", 11, []model.TaskStep{}}} {
				r = base
				r.name = "task_step_delete"
				r.method = "Delete"
				r.stepID = tc.id
				r.args = map[string]any{"stepId": tc.id}
				r.pre = peek(mcpStepsTaskID, tc.version)
				r.input = taskservice.DeleteTaskStep{Version: tc.version}
				r.write = resource(mcpStepsTaskID, tc.version+1, tc.rows...)
				r.write.Changed = true
				deleted := success(r)
				checkReceipt(deleted, strconv.FormatInt(tc.version+1, 10), tc.id, len(tc.rows), true, nil, "", "")
				if tc.id == "abcdef01" {
					steps, ok := deleted["steps"].([]any)
					if !ok || len(steps) != 0 {
						t.Fatalf("last delete receipt: %+v", deleted)
					}
				}
			}
			r = base
			r.name = "task_step_list"
			r.method = "ListPage"
			r.page = &pageWant{after: -1, limit: 50, summary: true, page: taskservice.StepsPage{Header: header(mcpStepsTaskID, 12), Items: []store.TaskStepProjection{}}}
			empty := success(r)
			if items, ok := empty["items"].([]any); !ok || len(items) != 0 || empty["nextCursor"] != nil {
				t.Fatalf("empty: %+v", empty)
			}
			r = base
			r.name = "task_step_show"
			r.method = "GetSummary"
			r.stepID = "abcdef01"
			r.args = map[string]any{"stepId": "abcdef01"}
			r.err = tasksteps.NotFound(12, model.ErrNotFound)
			absence := failure(r, "not_found")
			if obj(absence["refs"])["version"] != empty["version"] {
				t.Fatalf("absence version: %+v, empty: %+v", absence, empty)
			}
			equal("operation counts", ops.counts(), map[string]int{"ListPage": 18, "Get": 1, "GetSummary": 1, "Add": 7, "Update": 9, "SetStatus": 4, "Move": 2, "Delete": 3})
		})
	}
}
