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

func (s *scopedStepProbe) Get(_ context.Context, a model.CredentialAuthorization, _, _, step string) (taskservice.StepDocument, error) {
	if step != "abcdef12" {
		s.t.Fatal("get step lost")
	}
	err := s.check(a, "get")
	return taskservice.StepDocument{}, err
}
func (s *scopedStepProbe) GetSummary(_ context.Context, a model.CredentialAuthorization, _, _, step string) (taskservice.StepSummary, error) {
	if step != "abcdef12" {
		s.t.Fatal("summary step lost")
	}
	err := s.check(a, "summary")
	return taskservice.StepSummary{Header: model.TaskHeader{ProjectID: testProjectID, ID: testTargetID, Version: 7}, Item: store.TaskStepProjection{Step: model.TaskStep{ID: step}}}, err
}
func (s *scopedStepProbe) Update(_ context.Context, a model.CredentialAuthorization, _, _, step string, in taskservice.UpdateTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Title == nil || *in.Title != "new" {
		s.t.Fatalf("update %+v", in)
	}
	err := s.check(a, "update")
	return stepWriteFixture().result, err
}
func (s *scopedStepProbe) SetStatus(_ context.Context, a model.CredentialAuthorization, _, _, step string, in taskservice.SetTaskStepStatus) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Status != model.TaskStepDone {
		s.t.Fatalf("status %+v", in)
	}
	err := s.check(a, "status")
	return stepWriteFixture().result, err
}
func (s *scopedStepProbe) Move(_ context.Context, a model.CredentialAuthorization, _, _, step string, in taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 || in.Position == nil || *in.Position != "last" {
		s.t.Fatalf("move %+v", in)
	}
	err := s.check(a, "move")
	return stepWriteFixture().result, err
}
func (s *scopedStepProbe) Delete(_ context.Context, a model.CredentialAuthorization, _, _, step string, in taskservice.DeleteTaskStep) (taskservice.StepsWriteResult, error) {
	if step != "abcdef12" || in.Version != 7 {
		s.t.Fatalf("delete %+v", in)
	}
	err := s.check(a, "delete")
	return stepWriteFixture().result, err
}

func TestScopedStepMCPAdapterOperationsAndMissingAuthorization(t *testing.T) {
	f := newEntryFixture(t)
	a := scopedTestAuthorization(t, "step:read", "step:write")
	if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{"all": a}}); err != nil {
		t.Fatal(err)
	}
	probe := &scopedStepProbe{t: t, auth: a}
	if err := RegisterScopedStepTools(f.entry, probe); err != nil {
		t.Fatal(err)
	}
	client := f.client(t, "2026-07-28", "all")
	base := func() map[string]any {
		return map[string]any{"projectId": testProjectID, "taskId": testTargetID, "stepId": "abcdef12", "ifVersion": "7"}
	}
	for _, tc := range []struct {
		name, seen string
		extra      map[string]any
	}{
		{"task_step_show", "summary", map[string]any{}}, {"task_step_update", "update", map[string]any{"title": "new"}}, {"task_step_set_status", "status", map[string]any{"status": "done"}}, {"task_step_move", "move", map[string]any{"position": "last"}}, {"task_step_delete", "delete", map[string]any{}},
	} {
		args := base()
		if tc.name == "task_step_show" {
			delete(args, "ifVersion")
		}
		for k, v := range tc.extra {
			args[k] = v
		}
		result := readCall(t, client, tc.name, args)
		if result.IsError || probe.seen != tc.seen {
			t.Fatalf("%s: %+v", tc.name, structured(t, result))
		}
	}
	adapter := scopedStepAdapter{steps: probe}
	ctx := context.Background()
	p := a.Principal
	for _, call := range []func() error{
		func() error { _, e := adapter.Get(ctx, p, "p", "t", "s"); return e }, func() error { _, e := adapter.ListPage(ctx, p, "p", "t", 0, 1, nil, false); return e }, func() error { _, e := adapter.GetSummary(ctx, p, "p", "t", "s"); return e }, func() error { _, e := adapter.Add(ctx, p, "p", "t", taskservice.AddTaskStep{}); return e }, func() error { _, e := adapter.Update(ctx, p, "p", "t", "s", taskservice.UpdateTaskStep{}); return e }, func() error {
			_, e := adapter.SetStatus(ctx, p, "p", "t", "s", taskservice.SetTaskStepStatus{})
			return e
		}, func() error { _, e := adapter.Move(ctx, p, "p", "t", "s", taskservice.MoveTaskStep{}); return e }, func() error { _, e := adapter.Delete(ctx, p, "p", "t", "s", taskservice.DeleteTaskStep{}); return e },
	} {
		if call() == nil {
			t.Fatal("missing authorization accepted")
		}
	}
	// Full Step reads use Get instead of GetSummary.
	ctx = context.WithValue(ctx, scopedAuthorizationKey{}, a)
	if _, err := adapter.Get(ctx, p, testProjectID, testTargetID, "abcdef12"); err != nil || probe.seen != "get" {
		t.Fatalf("get: %v", err)
	}
}

func TestScopedStepRegistrationRefusesInvalidDefinitionsAndDuplicates(t *testing.T) {
	probe := &scopedStepProbe{t: t}
	if RegisterScopedStepTools(nil, probe) == nil {
		t.Fatal("nil entry")
	}
	if RegisterScopedStepTools(newEntryFixture(t).entry, nil) == nil {
		t.Fatal("nil operations")
	}
	originalRead, originalWrite := stepReadToolsJSON, stepWriteToolsJSON
	t.Cleanup(func() { stepReadToolsJSON, stepWriteToolsJSON = originalRead, originalWrite })
	for _, tc := range []struct {
		name        string
		read, write []byte
	}{{"bad read", []byte(`{`), originalWrite}, {"bad write", originalRead, []byte(`{`)}, {"invalid read tool", []byte(`[{"name":"x"}]`), originalWrite}, {"invalid write tool", originalRead, []byte(`[{"name":"x"}]`)}} {
		t.Run(tc.name, func(t *testing.T) {
			stepReadToolsJSON, stepWriteToolsJSON = tc.read, tc.write
			if RegisterScopedStepTools(newEntryFixture(t).entry, probe) == nil {
				t.Fatal("bad definition accepted")
			}
		})
	}
	stepReadToolsJSON, stepWriteToolsJSON = originalRead, originalWrite
	entry := newEntryFixture(t).entry
	if err := RegisterScopedStepTools(entry, probe); err != nil {
		t.Fatal(err)
	}
	if RegisterScopedStepTools(entry, probe) == nil {
		t.Fatal("duplicate accepted")
	}
}
