package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPStepsProductionLifecycle(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(protocol, func(t *testing.T) {
			principal := defaultHTTPPrincipal()
			outsider := principal
			outsider.UserID, outsider.CredentialID = "e5555555-5555-4555-8555-555555555555", "f6666666-6666-4666-8666-666666666666"
			token, otherToken := defaultHTTPToken(), "dnpat_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
			tx := newHTTPTestStoreForPrincipal(t, principal)
			configureMCPPrincipals(t, tx, map[string]model.Principal{token: principal, otherToken: outsider})
			production, _ := newMCPHTTPServer(t, tx, attachmentTestFiles(t))
			connect := func(token string) *sdk.ClientSession {
				t.Helper()
				client := sdk.NewClient(&sdk.Implementation{Name: "mcp-steps-integration", Version: "1"}, nil)
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: production.URL + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: protocol})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = session.Close() })
				return session
			}
			alice, bob := connect(token), connect(otherToken)
			call := func(client *sdk.ClientSession, name string, args map[string]any) (map[string]any, bool) {
				t.Helper()
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
			obj := func(value any) map[string]any {
				t.Helper()
				out, ok := value.(map[string]any)
				if !ok {
					t.Fatalf("expected object: %#v", value)
				}
				return out
			}
			header := func(id string, version int64) model.TaskHeader {
				return model.TaskHeader{ProjectID: mcpStepsProjectID, ID: id, Version: version}
			}
			now := time.Date(2026, 11, 8, 12, 0, 0, 123456000, time.UTC)
			args := func(taskID string, extra map[string]any) map[string]any {
				out := map[string]any{"projectId": mcpStepsProjectID, "taskId": taskID}
				for k, v := range extra {
					out[k] = v
				}
				return out
			}
			readPlan := func(actor model.Principal, h model.TaskHeader, pages []mcpStepsPageExpectation, summaryID string, summary store.TaskStepProjection, summaryError, accessError error) *mcpStepsReadPlan {
				t.Helper()
				want := map[string]int{"snapshot": 1, "access": 1}
				if accessError == nil {
					want["header"] = 1
				}
				if len(pages) > 0 {
					want["page"] = len(pages)
				}
				if summaryID != "" {
					want["summary"] = 1
				}
				p := &mcpStepsReadPlan{t: t, plan: newHTTPCallPlan(t, want), Header: h, Principal: actor, Pages: pages, SummaryID: summaryID, Summary: summary, SummaryError: summaryError, AccessError: accessError}
				p.snapshot(tx)
				return p
			}
			writePlan := func(h model.TaskHeader, rows []model.TaskStep, kind string, step model.TaskStep, from, to int64, counts map[string]int, outcome store.TransactionOutcome) *mcpStepsWritePlan {
				t.Helper()
				post := h
				if kind != "" {
					post.Version++
				}
				p := &mcpStepsWritePlan{t: t, plan: newHTTPCallPlan(t, counts), Header: h, PostHeader: post, Principal: principal, Rows: slices.Clone(rows), Observed: now, Mutation: kind, Step: step, From: from, To: to, Completion: store.Completion{Outcome: outcome}}
				p.write(tx)
				return p
			}
			peek := func(h model.TaskHeader, rows []model.TaskStep) *mcpStepsReadPlan {
				t.Helper()
				n := min(2, len(rows))
				return readPlan(principal, h, []mcpStepsPageExpectation{{-1, 2, true, mcpStepProjection(rows[:n]...)}}, "", store.TaskStepProjection{}, nil, nil)
			}
			success := func(name, taskID string, extra map[string]any, h model.TaskHeader, rows []model.TaskStep, kind string, step model.TaskStep, from, to int64) map[string]any {
				t.Helper()
				var read *mcpStepsReadPlan
				if _, exists := extra["ifVersion"]; !exists {
					read = peek(h, rows)
				} else {
					tx.ReadSnapshotCall = nil
				}
				want := map[string]int{"write": 1, "access": 1, "header": 1, "rows": 1}
				if kind != "" {
					want["header"] = 2
					want["clock"] = 1
					want[kind] = 1
					want["touch"] = 1
					want["capture"] = 1
				}
				p := writePlan(h, rows, kind, step, from, to, want, store.TransactionCommitted)
				out, failed := call(alice, name, args(taskID, extra))
				if failed {
					t.Fatalf("%s: %+v", name, out)
				}
				p.plan.Verify()
				if read != nil {
					read.plan.Verify()
				}
				order := []string{"access", "header", "rows"}
				if kind != "" {
					order = append(order, "clock", kind, "touch", "header", "capture")
				}
				if !reflect.DeepEqual(p.order, order) {
					t.Fatalf("%s DAO ordering: %v want %v", name, p.order, order)
				}
				return obj(out["data"])
			}
			failure := func(client *sdk.ClientSession, name string, extra map[string]any, code string) map[string]any {
				t.Helper()
				out, failed := call(client, name, args(mcpStepsTaskID, extra))
				if !failed || obj(out["error"])["code"] != code {
					t.Fatalf("%s wanted %s: %+v", name, code, out)
				}
				return obj(out["error"])
			}

			// Field admission must precede persistence; the DAO boundary witnesses
			// independently retain complete physical row preservation.
			limitID := "a7777777-7777-4777-8777-777777777777"
			limitRows := []model.TaskStep{}
			version := int64(1)
			for i, tc := range []struct{ field, valid, excess string }{{"title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"}, {"description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"}} {
				id := fmt.Sprintf("%08x", i+1)
				rejected := func(name string, fields map[string]any) {
					t.Helper()
					tx.ReadSnapshotCall = nil
					refusal := writePlan(header(limitID, version), limitRows, "", model.TaskStep{}, 0, 0, map[string]int{"write": 1, "access": 1, "header": 1, "rows": 1}, store.TransactionNotCommitted)
					fields["ifVersion"] = strconv.FormatInt(version, 10)
					out, failed := call(alice, name, args(limitID, fields))
					if !failed {
						t.Fatalf("%s %s: %+v", name, tc.field, out)
					}
					refusal.plan.Verify()
					err := obj(out["error"])
					if err["code"] != "invalid_input" || err["writeOutcome"] != "not_committed" || !strings.Contains(err["message"].(string), tc.field) {
						t.Fatalf("field refusal: %+v", err)
					}
				}
				rejected("task_step_add", map[string]any{"id": id, "title": "x", tc.field: tc.excess})
				expected := model.TaskStep{ID: id, Position: int64(i), Title: "x", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
				if tc.field == "title" {
					expected.Title = tc.valid
				} else {
					expected.Description = tc.valid
				}
				added := success("task_step_add", limitID, map[string]any{"id": id, "title": "x", tc.field: tc.valid, "ifVersion": strconv.FormatInt(version, 10)}, header(limitID, version), limitRows, "insert", expected, 0, 0)
				version++
				if added["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("version receipt: %+v", added)
				}
				limitRows = append(limitRows, expected)
				rejected("task_step_update", map[string]any{"stepId": id, tc.field: tc.excess})
				short := expected
				if tc.field == "title" {
					short.Title = "short"
				} else {
					short.Description = "short"
				}
				updated := success("task_step_update", limitID, map[string]any{"stepId": id, tc.field: "short", "ifVersion": strconv.FormatInt(version, 10)}, header(limitID, version), limitRows, "update", short, 0, 0)
				version++
				if updated["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("version receipt: %+v", updated)
				}
				limitRows[i] = short
				restored := success("task_step_update", limitID, map[string]any{"stepId": id, tc.field: tc.valid, "ifVersion": strconv.FormatInt(version, 10)}, header(limitID, version), limitRows, "update", expected, 0, 0)
				version++
				if restored["version"] != strconv.FormatInt(version, 10) {
					t.Fatalf("version receipt: %+v", restored)
				}
				limitRows[i] = expected
			}

			tx.WriteProjectCall = nil
			deniedRead := readPlan(outsider, header(mcpStepsTaskID, 1), nil, "", store.TaskStepProjection{}, nil, model.ErrNotFound)
			denied := failure(bob, "task_step_list", nil, "not_found")
			deniedRead.plan.Verify()
			if _, exists := denied["refs"]; exists {
				t.Fatalf("unauthorized list leaks refs: %+v", denied)
			}
			deniedAdd := readPlan(outsider, header(mcpStepsTaskID, 1), nil, "", store.TaskStepProjection{}, nil, model.ErrNotFound)
			failure(bob, "task_step_add", map[string]any{"id": "00000001", "title": "blocked"}, "not_found")
			deniedAdd.plan.Verify()
			first := model.TaskStep{ID: "abcdef01", Position: 0, Title: "First", Description: "first body", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
			receipt := success("task_step_add", mcpStepsTaskID, map[string]any{"id": "ABCDEF01", "title": "First", "description": "first body"}, header(mcpStepsTaskID, 1), []model.TaskStep{}, "insert", first, 0, 0)
			if receipt["stepId"] != "abcdef01" || receipt["version"] != "2" || receipt["changed"] != true || obj(receipt["step"])["status"] != "todo" {
				t.Fatalf("first receipt: %+v", receipt)
			}
			second := model.TaskStep{ID: "abcdef02", Position: 0, Title: "Second", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
			success("task_step_add", mcpStepsTaskID, map[string]any{"id": "abcdef02", "title": "Second", "before": "abcdef01"}, header(mcpStepsTaskID, 2), []model.TaskStep{first}, "insert", second, 0, 0)
			first.Position = 1
			third := model.TaskStep{ID: "abcdef03", Position: 2, Title: "Third", Status: model.TaskStepTodo, CreatedAt: now, UpdatedAt: now}
			success("task_step_add", mcpStepsTaskID, map[string]any{"id": "abcdef03", "title": "Third", "after": "abcdef01"}, header(mcpStepsTaskID, 3), []model.TaskStep{second, first}, "insert", third, 0, 0)
			rows := []model.TaskStep{second, first, third}
			tx.WriteProjectCall = nil
			pagePlan := readPlan(principal, header(mcpStepsTaskID, 4), []mcpStepsPageExpectation{{-1, 2, true, mcpStepProjection(second, first)}, {0, 2, true, mcpStepProjection(first, third)}}, "", store.TaskStepProjection{}, nil, nil)
			out, failed := call(alice, "task_step_list", args(mcpStepsTaskID, map[string]any{"limit": 2}))
			if failed {
				t.Fatalf("first page: %+v", out)
			}
			pagePlan.plan.Verify()
			page := obj(out["data"])
			items := page["items"].([]any)
			if page["version"] != "4" || page["projection"] != "summary" || len(items) != 2 || obj(items[0])["id"] != "abcdef02" || obj(items[1])["id"] != "abcdef01" || obj(items[1])["position"] != float64(1) {
				t.Fatalf("first page: %+v", page)
			}
			cursor, ok := page["nextCursor"].(string)
			if !ok || cursor == "" {
				t.Fatalf("missing cursor: %+v", page)
			}
			tailPlan := readPlan(principal, header(mcpStepsTaskID, 4), []mcpStepsPageExpectation{{1, 2, true, mcpStepProjection(third)}}, "", store.TaskStepProjection{}, nil, nil)
			out, failed = call(alice, "task_step_list", args(mcpStepsTaskID, map[string]any{"limit": 2, "cursor": cursor}))
			if failed {
				t.Fatalf("tail: %+v", out)
			}
			tailPlan.plan.Verify()
			tail := obj(out["data"])
			if len(tail["items"].([]any)) != 1 || obj(tail["items"].([]any)[0])["id"] != "abcdef03" || tail["nextCursor"] != nil {
				t.Fatalf("tail: %+v", tail)
			}
			fullPlan := readPlan(principal, header(mcpStepsTaskID, 4), []mcpStepsPageExpectation{{0, 1, false, mcpStepProjection(first)}}, first.ID, store.TaskStepProjection{Step: first}, nil, nil)
			out, failed = call(alice, "task_step_show", args(mcpStepsTaskID, map[string]any{"stepId": "abcdef01", "view": "full"}))
			if failed {
				t.Fatalf("full show: %+v", out)
			}
			fullPlan.plan.Verify()
			full := obj(out["data"])
			if full["version"] != "4" || obj(full["step"])["description"] != "first body" {
				t.Fatalf("full show: %+v", full)
			}
			revised := first
			revised.Description = "revised"
			updated := success("task_step_update", mcpStepsTaskID, map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4", "returnView": "full"}, header(mcpStepsTaskID, 4), rows, "update", revised, 0, 0)
			if updated["version"] != "5" || len(updated["steps"].([]any)) != 3 || obj(updated["steps"].([]any)[1])["description"] != "revised" {
				t.Fatalf("full update: %+v", updated)
			}
			first = revised
			rows[1] = revised
			tx.WriteProjectCall = nil
			staleRead := readPlan(principal, header(mcpStepsTaskID, 5), nil, "", store.TaskStepProjection{}, nil, nil)
			conflict := failure(alice, "task_step_list", map[string]any{"limit": 2, "cursor": cursor}, "version_conflict")
			staleRead.plan.Verify()
			if _, exists := conflict["writeOutcome"]; exists {
				t.Fatalf("read conflict claimed a write outcome: %+v", conflict)
			}
			tx.ReadSnapshotCall = nil
			staleWrite := writePlan(header(mcpStepsTaskID, 5), rows, "", model.TaskStep{}, 0, 0, map[string]int{"write": 1, "access": 1, "header": 1}, store.TransactionNotCommitted)
			failure(alice, "task_step_update", map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "4"}, "version_conflict")
			staleWrite.plan.Verify()
			noop := success("task_step_update", mcpStepsTaskID, map[string]any{"stepId": "abcdef01", "description": "revised", "ifVersion": "5"}, header(mcpStepsTaskID, 5), rows, "", model.TaskStep{}, 0, 0)
			if noop["changed"] != false || noop["version"] != "5" {
				t.Fatalf("noop: %+v", noop)
			}
			self := writePlan(header(mcpStepsTaskID, 5), rows, "", model.TaskStep{}, 0, 0, map[string]int{"write": 1, "access": 1, "header": 1, "rows": 1}, store.TransactionNotCommitted)
			failure(alice, "task_step_move", map[string]any{"stepId": "abcdef01", "before": "ABCDEF01", "ifVersion": "5"}, "invalid_input")
			self.plan.Verify()
			version = 5
			for _, status := range []model.TaskStepStatus{model.TaskStepTodo, model.TaskStepInProgress, model.TaskStepDone, model.TaskStepSkipped} {
				expected := second
				expected.Status = status
				kind := "update"
				if status == second.Status {
					kind = ""
				}
				out := success("task_step_set_status", mcpStepsTaskID, map[string]any{"stepId": "abcdef02", "status": string(status)}, header(mcpStepsTaskID, version), rows, kind, expected, 0, 0)
				if obj(out["step"])["status"] != string(status) {
					t.Fatalf("status %s: %+v", status, out)
				}
				if kind != "" {
					version++
				}
				second = expected
				rows[0] = expected
			}
			success("task_step_move", mcpStepsTaskID, map[string]any{"stepId": "abcdef03", "position": "first"}, header(mcpStepsTaskID, version), rows, "move", third, 2, 0)
			version++
			third.Position, second.Position, first.Position = 0, 1, 2
			rows = []model.TaskStep{third, second, first}
			tx.WriteProjectCall = nil
			orderedPlan := readPlan(principal, header(mcpStepsTaskID, version), []mcpStepsPageExpectation{{-1, 2, false, mcpStepProjection(third, second)}, {0, 2, false, mcpStepProjection(second, first)}, {1, 2, false, mcpStepProjection(first)}}, "", store.TaskStepProjection{}, nil, nil)
			out, failed = call(alice, "task_step_list", args(mcpStepsTaskID, map[string]any{"view": "full"}))
			if failed {
				t.Fatalf("order: %+v", out)
			}
			orderedPlan.plan.Verify()
			ordered := obj(out["data"])
			values := ordered["items"].([]any)
			if len(values) != 3 || obj(values[0])["id"] != "abcdef03" || obj(values[1])["id"] != "abcdef02" || obj(values[2])["id"] != "abcdef01" {
				t.Fatalf("order: %+v", ordered)
			}
			for _, id := range []string{"abcdef03", "abcdef02", "abcdef01"} {
				expected := rows[0]
				deleted := success("task_step_delete", mcpStepsTaskID, map[string]any{"stepId": id}, header(mcpStepsTaskID, version), rows, "delete", expected, 0, int64(len(rows)-1))
				version++
				rows = slices.Clone(rows[1:])
				for i := range rows {
					rows[i].Position = int64(i)
				}
				if id == "abcdef01" {
					steps, ok := deleted["steps"].([]any)
					if !ok || len(steps) != 0 {
						t.Fatalf("last delete receipt: %+v", deleted)
					}
				}
			}
			tx.WriteProjectCall = nil
			emptyPlan := readPlan(principal, header(mcpStepsTaskID, version), []mcpStepsPageExpectation{{-1, 2, true, []store.TaskStepProjection{}}}, "", store.TaskStepProjection{}, nil, nil)
			out, failed = call(alice, "task_step_list", args(mcpStepsTaskID, nil))
			if failed {
				t.Fatalf("empty: %+v", out)
			}
			emptyPlan.plan.Verify()
			empty := obj(out["data"])
			if len(empty["items"].([]any)) != 0 || empty["nextCursor"] != nil {
				t.Fatalf("empty: %+v", empty)
			}
			absencePlan := readPlan(principal, header(mcpStepsTaskID, version), nil, "abcdef01", store.TaskStepProjection{}, model.ErrNotFound, nil)
			absence := failure(alice, "task_step_show", map[string]any{"stepId": "abcdef01"}, "not_found")
			absencePlan.plan.Verify()
			if obj(absence["refs"])["version"] != empty["version"] {
				t.Fatalf("absence version: %+v, empty: %+v", absence, empty)
			}
		})
	}
}
