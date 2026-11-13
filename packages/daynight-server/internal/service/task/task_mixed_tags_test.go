package task_test

import (
	"context"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestMixedTaskUpdateCoordinatesTags(t *testing.T) {
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, mode := range []string{"both change", "metadata noop", "invalid tag", "metadata refusal", "assignment refusal", "write failure", "admission failure"} {
		t.Run(mode, func(t *testing.T) {
			_, current, _ := taskMockModels()
			current.Type, current.AssignedTo = model.TaskTypeTask, nil
			if mode == "assignment refusal" {
				current.Status = model.TaskInProgress
			}
			f := newTagServiceFixture(t, current)
			f.dependencies(f.ctx, []string{}, []model.Task{})
			f.ids = []string{tagID}
			f.resolved = []model.Tag{{ID: tagID, Name: "label"}}
			f.after.Title = "Changed"
			f.after.Tags = []model.TagReference{{ID: tagID, Name: "label"}}
			title := "Changed"
			if mode == "metadata noop" {
				title, f.after.Title = current.Title, current.Title
			}
			if mode == "invalid tag" {
				f.resolved = nil
			}
			if mode == "metadata refusal" {
				title = " "
			}
			failure := errors.New("write failed")
			f.writer.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
				f.events = append(f.events, "update")
				if ctx != f.ctx || id != current.ID || values.Title != title {
					t.Fatal("metadata write changed")
				}
				if mode == "write failure" {
					return model.Task{}, failure
				}
				return f.after, nil
			}
			if mode == "admission failure" {
				f.after.Description = strings.Repeat("x", 600000)
			}
			f.freeze(f.ctx, current.ID)
			input := []string{tagID}
			update := taskcore.UpdateTask{Version: current.Version, Title: &title, TagIDs: &input}
			if mode == "assignment refusal" {
				assignee := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
				assigned := &assignee
				update.AssignedTo = &assigned
			}
			got, err := f.tasks.Update(f.ctx, f.principal, f.project.ID, current.ID, update)
			switch mode {
			case "both change":
				if err != nil || !reflect.DeepEqual(got, f.after) {
					t.Fatalf("result: %#v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "resolve", "replace", "update")
			case "metadata noop":
				if err != nil || !reflect.DeepEqual(got, f.after) {
					t.Fatalf("result: %#v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "resolve", "clock", "replace", "touch", "task")
			case "invalid tag":
				assertTagFault(t, err, "tag_not_found")
				if f.callbackErr == nil || slices.Contains(f.events, "replace") || slices.Contains(f.events, "update") {
					t.Fatalf("invalid tag mutated: %v", f.events)
				}
			case "metadata refusal":
				assertTagFault(t, err, "invalid_input")
				if f.callbackErr == nil || slices.Contains(f.events, "resolve") || slices.Contains(f.events, "replace") {
					t.Fatalf("invalid metadata mutated: %v", f.events)
				}
			case "assignment refusal":
				assertTagFault(t, err, "invalid_transition")
				if f.callbackErr == nil || slices.Contains(f.events, "replace") || slices.Contains(f.events, "update") {
					t.Fatalf("invalid assignment mutated: %v", f.events)
				}
			case "write failure":
				if !errors.Is(err, failure) || f.callbackErr == nil {
					t.Fatalf("write error lost: %v", err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "resolve", "replace", "update")
			case "admission failure":
				if err == nil || f.callbackErr == nil {
					t.Fatalf("admission accepted oversized result: %v", err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "resolve", "replace", "update")
			}
		})
	}
}

func TestPartitionedDependencyAndTagUpdateSharesWriteScope(t *testing.T) {
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const dependencyID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, mode := range []string{"commit", "invalid tag", "stale version", "unknown commit"} {
		t.Run(mode, func(t *testing.T) {
			_, current, _ := taskMockModels()
			current.Type, current.AssignedTo = model.TaskTypeTask, nil
			f := newTagServiceFixture(t, current)
			f.ids = []string{tagID}
			f.resolved = []model.Tag{{ID: tagID, Name: "label"}}
			f.after.Tags = []model.TagReference{{ID: tagID, Name: "label"}}
			f.after.DependsOn = []string{dependencyID}
			f.after.BlockedBy = []string{dependencyID}
			f.after.Ready = false
			f.writer.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
				f.events = append(f.events, "task")
				if ctx != f.ctx || id != current.ID {
					t.Fatal("task read context or ID changed")
				}
				return current, nil
			}
			f.dependencies(f.ctx, []string{dependencyID}, []model.Task{ruleTask(dependencyID, "Prerequisite")})
			f.noCycles(f.ctx, current.ID, []string{dependencyID})
			f.writer.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
				f.events = append(f.events, "update")
				if ctx != f.ctx || id != current.ID || !slices.Equal(values.DependsOn, []string{dependencyID}) || len(values.ExternalDependsOn) != 0 {
					t.Fatalf("partitioned dependency write changed: %#v", values)
				}
				return f.after, nil
			}
			f.freeze(f.ctx, current.ID)
			input := taskcore.UpdateTask{Version: current.Version, TagIDs: &[]string{tagID}}
			sentinel := errors.New("commit outcome unknown")
			switch mode {
			case "invalid tag":
				f.resolved = nil
			case "stale version":
				input.Version++
			case "unknown commit":
				f.outcome = store.TransactionUnknown
				f.completionErr = &store.TransactionError{Phase: "commit", Cause: sentinel, Outcome: store.TransactionUnknown, CommitAttempted: true}
			}
			got, err := f.tasks.UpdatePartitionedDependencies(f.ctx, f.principal, f.project.ID, current.ID, input, &[]string{dependencyID}, nil)
			switch mode {
			case "commit":
				if err != nil || !reflect.DeepEqual(got, f.after) {
					t.Fatalf("result: %#v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "task", "resolve", "replace", "update")
			case "invalid tag":
				assertTagFault(t, err, "tag_not_found")
				if f.callbackErr == nil {
					t.Fatal("tag refusal did not abort the shared transaction")
				}
				assertTagEvents(t, f.events, "authorize", "task", "task", "resolve")
			case "stale version":
				assertTagFault(t, err, "version_conflict")
				assertTagEvents(t, f.events, "authorize", "task")
			case "unknown commit":
				var failure *store.TransactionError
				if !errors.Is(err, sentinel) || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !reflect.DeepEqual(got, model.Task{}) {
					t.Fatalf("unknown completion lost: %#v %v", got, err)
				}
				assertTagEvents(t, f.events, "authorize", "task", "task", "resolve", "replace", "update")
			}
		})
	}
}
