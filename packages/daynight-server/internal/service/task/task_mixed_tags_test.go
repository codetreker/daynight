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
