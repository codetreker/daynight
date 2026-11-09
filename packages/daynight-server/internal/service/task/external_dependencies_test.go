package task_test

import (
	"context"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestExternalDependencyFlagsPreserveExecutionAndVersionAdmission(t *testing.T) {
	a := ruleTask("aa000000-0000-4000-8000-000000000001", "A")
	b := ruleTask("bb000000-0000-4000-8000-000000000001", "B")
	a.Status, b.Status = model.TaskDone, model.TaskDone
	ids := []string{a.ID, b.ID}
	for _, status := range []model.TaskStatus{model.TaskInProgress, model.TaskDone} {
		t.Run(string(status), func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			current := f.target
			current.Status, current.AllowAgents, current.Ready = status, true, false
			current.Version = 7
			current.DependsOn, current.BlockedBy = slices.Clone(ids), []string{}
			current.StartedAt = pointer(current.CreatedAt)
			wanted := []string{a.ID}
			if status == model.TaskDone {
				current.ExternalDependsOn = []string{a.ID}
				current.CompletedAt = pointer(current.UpdatedAt)
				wanted = []string{b.ID}
			}
			f.current(ctx, current)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.dependencies(ctx, ids, []model.Task{a, b})
			f.noCycles(ctx, current.ID, ids)
			result := current
			result.ExternalDependsOn, result.Version, result.UpdatedAt = wanted, current.Version+1, current.UpdatedAt.Add(time.Second)
			values := store.TaskWrite{Title: current.Title, Description: current.Description, Status: current.Status, Properties: current.Properties, AllowAgents: true, DependsOn: ids, ExternalDependsOn: wanted}
			f.update(ctx, current.ID, values, result)
			got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, ExternalDependsOn: &wanted})
			if err != nil || !reflect.DeepEqual(got, result) {
				t.Fatalf("classification changed execution facts or result: %#v %v", got, err)
			}
			_, err = f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version - 1, ExternalDependsOn: pointer([]string{"cc000000-0000-4000-8000-000000000001"})})
			requireFault(t, err, "version_conflict")
			f.current(ctx, result)
			noop, err := f.tasks.Update(ctx, f.principal, f.project.ID, result.ID, taskcore.UpdateTask{Version: result.Version, ExternalDependsOn: &wanted})
			if err != nil || !reflect.DeepEqual(noop, result) {
				t.Fatalf("same classification wrote metadata or changed facts: %#v %v", noop, err)
			}
		})
	}
}

func TestExternalDependencyCyclesAndScopeUseCompleteCandidate(t *testing.T) {
	for _, classified := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "external"}[classified], func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			dependency := ruleTask("aa000000-0000-4000-8000-000000000001", "Target")
			ids := []string{dependency.ID}
			f.current(ctx, f.target)
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.dependencies(ctx, ids, []model.Task{dependency})
			calls := 0
			f.writer.ReachableFn = func(actual context.Context, from, to string, replacement store.DependencyReplacement) (bool, error) {
				calls++
				if actual != ctx || from != dependency.ID || to != f.target.ID || replacement.TaskID != f.target.ID || !slices.Equal(replacement.DependsOn, ids) {
					t.Fatal("classification changed the cycle query")
				}
				return true, nil
			}
			external := []string{}
			if classified {
				external = slices.Clone(ids)
			}
			_, err := f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, DependsOn: &ids, ExternalDependsOn: &external})
			requireFault(t, err, "dependency_cycle")
			if calls != 1 {
				t.Fatalf("cycle queries: %d want1", calls)
			}
		})
	}
	for _, operation := range []string{"create", "update"} {
		t.Run(operation+" foreign external", func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			foreign := []string{"aa000000-0000-4000-8000-000000000001"}
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			f.dependencies(ctx, foreign, []model.Task{})
			if operation == "update" {
				f.current(ctx, f.target)
				_, err := f.tasks.Update(ctx, f.principal, f.project.ID, f.target.ID, taskcore.UpdateTask{Version: f.target.Version, DependsOn: &foreign, ExternalDependsOn: &foreign})
				requireFault(t, err, "invalid_input")
			} else {
				_, err := f.tasks.Create(ctx, f.principal, f.project.ID, taskcore.CreateTask{Title: "Invalid", DependsOn: foreign, ExternalDependsOn: foreign})
				requireFault(t, err, "invalid_input")
			}
		})
	}
}
