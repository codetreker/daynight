package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type goalDependencyStub struct {
	show func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error)
	edit func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error)
}

func (s goalDependencyStub) ShowGoalDependencies(ctx context.Context, p model.Principal, project, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
	return s.show(ctx, p, project, goal, page)
}
func (s goalDependencyStub) EditGoalDependencies(ctx context.Context, p model.Principal, project, goal string, edit taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
	return s.edit(ctx, p, project, goal, edit)
}

func TestGoalDependencyToolsDiscoveryAndCalls(t *testing.T) {
	f := newEntryFixture(t)
	revision := int64(9007199254740993)
	edge, cursor := testTeamID, "next-page"
	var reads, writes int
	ops := goalDependencyStub{
		show: func(ctx context.Context, p model.Principal, project, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
			reads++
			if ctx.Err() != nil || p.UserID != "alice" || project != testProjectID || goal != testTargetID || page.Limit != 7 || page.Cursor == nil || *page.Cursor != cursor {
				t.Errorf("show input: actor=%+v project=%s goal=%s page=%+v", p, project, goal, page)
			}
			return taskcore.GoalDependencies{GoalID: goal, CanEdit: true, Revision: &revision, CompletionBlocked: true, Prerequisites: []taskcore.GoalDependencyPrerequisite{{EdgeID: &edge}}, NextCursor: &cursor}, nil
		},
		edit: func(ctx context.Context, p model.Principal, project, goal string, in taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
			writes++
			if ctx.Err() != nil || p.UserID != "alice" || project != testProjectID || goal != testTargetID || in.IfRevision != revision || in.Mode != "edit" || len(in.Remove) != 1 || in.Remove[0] != edge {
				t.Errorf("edit input: actor=%+v project=%s goal=%s edit=%+v", p, project, goal, in)
			}
			return taskcore.GoalDependencyReceipt{GoalID: goal, Revision: revision + 1, Changed: true}, nil
		},
	}
	if err := RegisterGoalDependencyTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	listed, err := client.ListTools(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, tool := range listed.Tools {
		if tool.Name == "goal_dependencies_show" || tool.Name == "goal_dependencies_edit" {
			if tool.InputSchema == nil || tool.OutputSchema != nil || found[tool.Name] {
				t.Fatalf("tool schema: %+v", tool)
			}
			found[tool.Name] = true
		}
	}
	if len(found) != 2 {
		t.Fatalf("missing tools: %+v", found)
	}
	show, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_show", Arguments: map[string]any{"projectId": testProjectID, "goalId": testTargetID, "cursor": cursor, "limit": 7}})
	if err != nil || show.IsError || reads != 1 {
		t.Fatalf("show=%+v err=%v reads=%d", show, err, reads)
	}
	data := object(t, structured(t, show)["data"])
	prerequisites := data["prerequisites"].([]any)
	hidden := object(t, prerequisites[0])
	if data["revision"] != "9007199254740993" || data["completionBlocked"] != true || data["nextCursor"] != cursor || hidden["edgeId"] != edge || hidden["target"] != nil {
		t.Fatalf("show data: %#v", data)
	}
	edit, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_edit", Arguments: map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "9007199254740993", "mode": "edit", "remove": []string{edge}}})
	if err != nil || edit.IsError || writes != 1 {
		t.Fatalf("edit=%+v err=%v writes=%d", edit, err, writes)
	}
	env := structured(t, edit)
	if got := object(t, env["data"]); got["revision"] != "9007199254740994" || got["changed"] != true || got["goalId"] != testTargetID {
		t.Fatalf("receipt: %#v", got)
	}
	if object(t, env["meta"])["outcome"] != "changed" {
		t.Fatalf("meta: %#v", env)
	}
}

func TestGoalDependencyToolsRejectInvalidBeforeBusiness(t *testing.T) {
	f := newEntryFixture(t)
	var calls int
	ops := goalDependencyStub{show: func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error) {
		calls++
		return taskcore.GoalDependencies{}, nil
	}, edit: func(context.Context, model.Principal, string, string, taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		calls++
		return taskcore.GoalDependencyReceipt{}, nil
	}}
	if err := RegisterGoalDependencyTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"goal_dependencies_show", map[string]any{"limit": 51}},
		{"goal_dependencies_show", map[string]any{"cursor": nil}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "0", "mode": "replace", "prerequisites": []any{}}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "9223372036854775808", "mode": "replace", "prerequisites": []any{}}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "1", "mode": "edit", "add": []any{}}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "1", "mode": "replace", "prerequisites": nil}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "1", "mode": "replace", "prerequisites": []any{}, "remove": []any{}}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "1", "mode": "edit", "remove": []string{testTeamID, testTeamID}}},
		{"goal_dependencies_edit", map[string]any{"ifRevision": "1", "mode": "replace", "prerequisites": []any{map[string]any{"edgeId": testTeamID, "goalId": testTargetID}}}},
	} {
		tc.args["projectId"], tc.args["goalId"] = testProjectID, testTargetID
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: tc.name, Arguments: tc.args})
		if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "invalid_input" || calls != 0 {
			t.Fatalf("invalid %s %+v: result=%+v err=%v calls=%d", tc.name, tc.args, result, err, calls)
		}
	}
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"goal_dependencies_edit","arguments":{"projectId":%q,"goalId":%q,"ifRevision":"1","mode":"replace","prerequisites":[{"edgeId":%q,"edgeId":%q}]}}}`, testProjectID, testTargetID, testTeamID, testTeamID)
	_, raw := rpcTaskRawRequest(t, f.server.URL, "2025-11-25", []byte(body))
	if !strings.Contains(string(raw), "invalid_input") || calls != 0 {
		t.Fatalf("duplicate nested key response=%s calls=%d", raw, calls)
	}
}

func TestGoalDependencyToolsResultsAndAdmission(t *testing.T) {
	f := newEntryFixture(t)
	var reads, writes int
	var failure error
	ops := goalDependencyStub{show: func(context.Context, model.Principal, string, string, model.PageRequest) (taskcore.GoalDependencies, error) {
		reads++
		return taskcore.GoalDependencies{}, failure
	}, edit: func(_ context.Context, _ model.Principal, _, goal string, in taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
		writes++
		if failure != nil {
			return taskcore.GoalDependencyReceipt{}, failure
		}
		if in.Mode != "replace" || in.Prerequisites == nil || len(in.Prerequisites) != 0 {
			t.Errorf("clear input: %+v", in)
		}
		return taskcore.GoalDependencyReceipt{GoalID: goal, Revision: in.IfRevision, Changed: false}, nil
	}}
	if err := RegisterGoalDependencyTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	showArgs := map[string]any{"projectId": testProjectID, "goalId": testTargetID}
	editArgs := map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "1", "mode": "replace", "prerequisites": []any{}}
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_edit", Arguments: editArgs})
	if err != nil || result.IsError || object(t, structured(t, result)["data"])["changed"] != false || object(t, structured(t, result)["meta"])["outcome"] != "unchanged" {
		t.Fatalf("unchanged result=%+v error=%v", result, err)
	}
	for _, tc := range []struct {
		err           error
		code, outcome string
	}{
		{&model.Fault{Code: "goal_dependency_revision_conflict", Message: "stale"}, "goal_dependency_revision_conflict", ""},
		{&model.Fault{Code: "goal_dependency_team_mismatch", Message: "team"}, "goal_dependency_team_mismatch", ""},
		{&model.Fault{Code: "goal_dependency_target_unavailable", Message: "Goal dependency target is unavailable."}, "goal_dependency_target_unavailable", ""},
		{&taskservice.GoalWriteUnknown{Cause: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private SQL")}}, "write_outcome_unknown", "unknown"},
	} {
		failure = tc.err
		args := editArgs
		if tc.code == "goal_dependency_target_unavailable" || tc.code == "goal_dependency_team_mismatch" {
			args = map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "1", "mode": "edit", "add": []any{map[string]any{"projectId": testTeamID, "goalId": testUserID}}}
		}
		before := writes
		result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_edit", Arguments: args})
		if err != nil || !result.IsError || writes != before+1 {
			t.Fatalf("failure result=%+v err=%v calls=%d", result, err, writes-before)
		}
		got := object(t, structured(t, result)["error"])
		if got["code"] != tc.code || (tc.outcome != "" && got["writeOutcome"] != tc.outcome) || strings.Contains(fmt.Sprint(got), "private SQL") {
			t.Fatalf("failure: %#v", got)
		}
	}
	failure = &model.Fault{Code: "forbidden", Message: "forbidden"}
	result, err = client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_show", Arguments: showArgs})
	if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "forbidden" || reads != 1 {
		t.Fatalf("show failure=%+v err=%v reads=%d", result, err, reads)
	}
	failure = nil
	var releases []func()
	for i := 0; i < 16; i++ {
		release, err := f.entry.budget.Acquire(t.Context(), BudgetControl)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	before := writes
	result, err = client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_edit", Arguments: editArgs})
	if err != nil || !result.IsError || object(t, structured(t, result)["error"])["code"] != "resource_busy" || writes != before {
		t.Fatalf("budget result=%+v err=%v writes=%d", result, err, writes)
	}
}

func TestGoalDependencyRegistrationRequiresDependencies(t *testing.T) {
	f := newEntryFixture(t)
	if RegisterGoalDependencyTools(nil, goalDependencyStub{}) == nil || RegisterGoalDependencyTools(f.entry, nil) == nil || RegisterGoalDependencyTools(f.entry, (*taskservice.Tasks)(nil)) == nil {
		t.Fatal("missing dependency accepted")
	}
	var definitions []sdk.Tool
	if err := json.Unmarshal(goalDependencyTools, &definitions); err != nil || len(definitions) != 2 {
		t.Fatalf("tool definitions: %v %v", definitions, err)
	}
}

func TestGoalDependencyReadOnlyProjectionAndRetainedEdge(t *testing.T) {
	f := newEntryFixture(t)
	edge, revision := testTeamID, int64(4)
	reads, writes := 0, 0
	ops := goalDependencyStub{
		show: func(_ context.Context, _ model.Principal, _, goal string, page model.PageRequest) (taskcore.GoalDependencies, error) {
			reads++
			if page.Limit != 0 || page.Cursor != nil {
				t.Errorf("default page = %+v", page)
			}
			return taskcore.GoalDependencies{GoalID: goal, CanEdit: false, Revision: &revision, Prerequisites: []taskcore.GoalDependencyPrerequisite{{EdgeID: &edge}}}, nil
		},
		edit: func(_ context.Context, _ model.Principal, _, goal string, input taskcore.GoalDependencyEdit) (taskcore.GoalDependencyReceipt, error) {
			writes++
			if input.Mode != "replace" || len(input.Prerequisites) != 1 || input.Prerequisites[0].EdgeID != edge {
				t.Errorf("retained edge = %+v", input)
			}
			return taskcore.GoalDependencyReceipt{GoalID: goal, Revision: input.IfRevision, Changed: false}, nil
		},
	}
	if err := RegisterGoalDependencyTools(f.entry, ops); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "alice")
	show, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_show", Arguments: map[string]any{"projectId": testProjectID, "goalId": testTargetID}})
	if err != nil || show.IsError || reads != 1 {
		t.Fatalf("show=%+v err=%v reads=%d", show, err, reads)
	}
	data := object(t, structured(t, show)["data"])
	prerequisite := object(t, data["prerequisites"].([]any)[0])
	if _, present := data["revision"]; present {
		t.Fatalf("read-only revision leaked: %#v", data)
	}
	if _, present := prerequisite["edgeId"]; present || prerequisite["target"] != nil {
		t.Fatalf("read-only hidden edge leaked: %#v", prerequisite)
	}
	result, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "goal_dependencies_edit", Arguments: map[string]any{"projectId": testProjectID, "goalId": testTargetID, "ifRevision": "4", "mode": "replace", "prerequisites": []any{map[string]any{"edgeId": edge}}}})
	if err != nil || result.IsError || writes != 1 || object(t, structured(t, result)["data"])["changed"] != false {
		t.Fatalf("retained edge=%+v err=%v writes=%d", result, err, writes)
	}
}
