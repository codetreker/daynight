package mcp

import (
	"context"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type scopedStepProbe struct {
	ScopedStepOperations
	t    *testing.T
	auth model.CredentialAuthorization
	seen string
	fail bool
}

func (s *scopedStepProbe) check(a model.CredentialAuthorization, name string) error {
	s.t.Helper()
	if a.Principal != s.auth.Principal || a.Policy != s.auth.Policy {
		s.t.Fatalf("authorization changed: %+v", a)
	}
	s.seen = name
	if s.fail {
		return &model.Fault{Code: "insufficient_scope", Message: "scope"}
	}
	return nil
}
func (s *scopedStepProbe) ListPage(_ context.Context, a model.CredentialAuthorization, _, _ string, _ int64, _ int, _ *int64, _ bool) (taskservice.StepsPage, error) {
	err := s.check(a, "list")
	return taskservice.StepsPage{Header: model.TaskHeader{ProjectID: testProjectID, ID: testTargetID, Version: 1}, Items: []store.TaskStepProjection{}}, err
}
func (s *scopedStepProbe) Add(_ context.Context, a model.CredentialAuthorization, _, _ string, input taskservice.AddTaskStep) (taskservice.StepsWriteResult, error) {
	err := s.check(a, "add")
	if input.Version != 1 || input.ID != "abcdef12" {
		s.t.Fatalf("input changed: %+v", input)
	}
	if err != nil {
		return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, err
	}
	result := stepWriteFixture().result
	return result, nil
}

func TestScopedStepToolsUseRequestAuthorizationAndPreserveReceipt(t *testing.T) {
	f := newEntryFixture(t)
	auth := scopedTestAuthorization(t, "step:read", "step:write")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"all": auth}}); err != nil {
		t.Fatal(err)
	}
	probe := &scopedStepProbe{t: t, auth: auth}
	var inventory []StepScopeTool
	if err := RegisterScopedStepTools(f.entry, probe, func(tool StepScopeTool) { inventory = append(inventory, tool) }); err != nil {
		t.Fatal(err)
	}
	want := map[string][]scopepolicy.Operation{
		"task_step_list": {scopepolicy.StepRead}, "task_step_show": {scopepolicy.StepRead},
		"task_step_add": {scopepolicy.StepWrite, scopepolicy.StepRead}, "task_step_update": {scopepolicy.StepWrite, scopepolicy.StepRead},
		"task_step_set_status": {scopepolicy.StepWrite, scopepolicy.StepRead}, "task_step_move": {scopepolicy.StepWrite, scopepolicy.StepRead}, "task_step_delete": {scopepolicy.StepWrite, scopepolicy.StepRead},
	}
	if len(inventory) != len(want) {
		t.Fatalf("inventory: %+v", inventory)
	}
	for _, tool := range inventory {
		ops, ok := want[tool.Name]
		if !ok || !f.entry.toolNames[tool.Name] || !f.entry.scopedTools[tool.Name] || !slices.Equal(tool.Operations, ops) {
			t.Fatalf("tool classification: %+v", tool)
		}
		delete(want, tool.Name)
	}
	client := f.client(t, "2026-07-28", "all")
	read := readCall(t, client, "task_step_list", readArgs())
	if read.IsError || probe.seen != "list" {
		t.Fatalf("read: %+v", structured(t, read))
	}
	args := map[string]any{"projectId": testProjectID, "taskId": testTargetID, "id": "abcdef12", "title": "hello", "ifVersion": "1"}
	result := readCall(t, client, "task_step_add", args)
	response := structured(t, result)
	if result.IsError || probe.seen != "add" || object(t, response["data"])["version"] != "9007199254740994" {
		t.Fatalf("receipt: %+v", response)
	}
	probe.fail = true
	result = readCall(t, client, "task_step_add", args)
	failure := object(t, structured(t, result)["error"])
	if !result.IsError || failure["code"] != "insufficient_scope" || failure["writeOutcome"] != "not_committed" {
		t.Fatalf("failure: %+v", failure)
	}
}
