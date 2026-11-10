package postgres

import (
	"context"
	"reflect"
	"slices"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func testGraphSelection() TaskGraphSelection {
	return TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
}

func TestTaskGraphProjectionKeepsSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	a := queryTask(t, s, project.ID, 11, model.TaskTodo)
	b := queryTask(t, s, project.ID, 12, model.TaskTodo, a.ID)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.ProjectDAO().Project(ctx, project.ID); err != nil {
			return err
		}
		before, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, a.ID, testGraphSelection(), 160)
		if err != nil {
			return err
		}
		if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
			if _, err := tx.TaskDAO().UpdateTask(ctx, a.ID, TaskWrite{Title: "Changed", Status: model.TaskDone}); err != nil {
				return err
			}
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(13), TaskWrite{Title: "New", Status: model.TaskTodo, DependsOn: []string{b.ID}})
			return err
		}); err != nil {
			return err
		}
		after, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, a.ID, testGraphSelection(), 160)
		if err != nil || len(before) != 2 || !reflect.DeepEqual(after, before) {
			t.Fatalf("graph mixed snapshots: before %#v after %#v, %v", before, after, err)
		}
		tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, queryID(11), testGraphSelection(), 160)
		if err != nil || len(tasks) != 2 || tasks[0].TitlePreview != a.Title || tasks[0].Status != model.TaskTodo ||
			!reflect.DeepEqual(tasks[1].BlockedBy, []string{a.ID}) || tasks[1].Ready {
			t.Fatalf("projection mixed snapshots: %#v, %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fresh := snapshotTask(t, s, project.ID, b.ID)
	if !fresh.Ready || len(fresh.BlockedBy) != 0 || fresh.Version != b.Version || fresh.UpdatedAt != b.UpdatedAt || !slices.Equal(fresh.DependsOn, b.DependsOn) {
		t.Fatalf("fresh derived state changed Task metadata: %#v, before %#v", fresh, b)
	}
}
