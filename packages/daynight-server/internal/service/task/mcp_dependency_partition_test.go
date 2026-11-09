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

func TestMCPTaskDependencyPartitionReplacement(t *testing.T) {
	prerequisiteID := "a1111111-1111-4111-8111-111111111111"
	for _, name := range []string{"ordinary reclassification", "omitted partition", "empty external partition", "duplicate partition"} {
		t.Run(name, func(t *testing.T) {
			f := newTaskRuleFixture(t)
			ctx := t.Context()
			current := f.target
			current.DependsOn, current.ExternalDependsOn = []string{prerequisiteID}, []string{prerequisiteID}
			current.BlockedBy, current.Ready = []string{prerequisiteID}, false
			input := taskcore.UpdateTask{Version: current.Version}
			var ordinary, external *[]string
			wantedDependencies, wantedExternal := []string{prerequisiteID}, []string{}
			wantedDescription := current.Description
			wantReads := 2
			switch name {
			case "ordinary reclassification":
				ordinary = pointer([]string{prerequisiteID})
			case "omitted partition":
				current.ExternalDependsOn = []string{}
				wantedDescription = "changed"
				input.Description = &wantedDescription
				wantReads = 1
			case "empty external partition":
				external = pointer([]string{})
				wantedDependencies = []string{}
			case "duplicate partition":
				ordinary, external = pointer([]string{prerequisiteID}), pointer([]string{prerequisiteID})
			}
			f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
			reads := 0
			f.writer.TaskFn = func(actual context.Context, id string) (model.Task, error) {
				reads++
				if actual != ctx || id != current.ID || reads > wantReads {
					t.Fatal("partition replacement changed the scoped Task read")
				}
				return current, nil
			}
			if name != "duplicate partition" {
				prerequisites := []model.Task{}
				if len(wantedDependencies) != 0 {
					prerequisites = []model.Task{ruleTask(prerequisiteID, "Prerequisite")}
				}
				f.dependencies(ctx, wantedDependencies, prerequisites)
				f.noCycles(ctx, current.ID, wantedDependencies)
				result := current
				result.Description, result.Version, result.UpdatedAt = wantedDescription, current.Version+1, current.UpdatedAt.Add(time.Second)
				result.DependsOn, result.ExternalDependsOn = slices.Clone(wantedDependencies), slices.Clone(wantedExternal)
				result.BlockedBy, result.Ready = slices.Clone(wantedDependencies), len(wantedDependencies) == 0
				f.update(ctx, current.ID, store.TaskWrite{Title: current.Title, Description: wantedDescription, Properties: current.Properties, Status: current.Status, DependsOn: wantedDependencies, ExternalDependsOn: wantedExternal}, result)
				actual, err := f.tasks.UpdatePartitionedDependencies(ctx, f.principal, f.project.ID, current.ID, input, ordinary, external)
				if err != nil || !reflect.DeepEqual(actual, result) {
					t.Fatalf("partition replacement result: %#v %v", actual, err)
				}
			} else {
				_, err := f.tasks.UpdatePartitionedDependencies(ctx, f.principal, f.project.ID, current.ID, input, ordinary, external)
				requireFault(t, err, "invalid_input")
			}
			if reads != wantReads {
				t.Fatalf("partition Task reads=%d want%d", reads, wantReads)
			}
		})
	}
}
