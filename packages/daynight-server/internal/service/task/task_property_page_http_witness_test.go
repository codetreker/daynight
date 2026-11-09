package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskPagePropertyOverflowKeepsPreviousCursorWithBoundedDAO(t *testing.T) {
	f := newTaskReadFixture(t)
	_, first, _ := taskMockModels()
	first.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"https://example.com/first","title":"First"}]`)}
	second := first
	second.ID = taskReadID(2)
	second.Title = "Withheld property"
	second.CreatedAt = first.CreatedAt.Add(time.Microsecond)
	second.UpdatedAt = second.CreatedAt
	second.Properties = model.TaskProperties{}
	queries := 0
	f.reader.TasksFn = func(ctx context.Context, projectID string, request store.TaskQuery) (store.TaskPage, error) {
		f.requireProject(ctx, projectID)
		queries++
		want := store.TaskQuery{Page: store.Page{Limit: 1}, BoundedText: true, LegacyProjection: true}
		if queries > 1 {
			want.Page.After = &store.Position{CreatedAt: first.CreatedAt, ID: first.ID}
		}
		if queries > 3 || !reflect.DeepEqual(request, want) {
			t.Fatalf("bounded property query %d: %#v, want %#v", queries, request, want)
		}
		if queries == 1 {
			return store.TaskPage{Items: []model.Task{first}, HasMore: true}, nil
		}
		return store.TaskPage{Items: []model.Task{second}, Oversized: true}, nil
	}
	tasks := taskservice.NewTasks(f.store)
	page, err := tasks.List(f.ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100}})
	if err != nil || !reflect.DeepEqual(page.Items, []model.Task{first}) || page.NextCursor == nil || queries != 2 || f.reads != 1 {
		t.Fatalf("property overflow lost its accepted prefix: page=%#v queries=%d snapshots=%d err=%v", page, queries, f.reads, err)
	}
	next, err := tasks.List(f.ctx, f.principal, f.project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 100, Cursor: page.NextCursor}})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" || fault.Message != "Task does not fit in the encoded page limit." || !reflect.DeepEqual(next, taskservice.TaskPage{}) || queries != 3 || f.reads != 2 {
		t.Fatalf("continuation skipped the overflowing property or exposed a partial page: page=%#v queries=%d snapshots=%d err=%v", next, queries, f.reads, err)
	}
}
