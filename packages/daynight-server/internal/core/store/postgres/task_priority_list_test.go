package postgres

import (
	"context"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskPrioritySnapshotRetainsPredecessorOrderingAndFence(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, db, 1)
	predecessor := queryTask(t, db, project.ID, 10, model.TaskTodo)
	dependent := queryTask(t, db, project.ID, 11, model.TaskTodo, predecessor.ID)
	queryTask(t, db, project.ID, 12, model.TaskTodo, predecessor.ID)
	ready := false
	query := TaskPriorityQuery{Limit: 1, Ready: &ready}
	var fence TaskListFence
	if err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var err error
		fence, err = snapshot.TaskDAO().TaskListFence(ctx, project.ID)
		if err != nil {
			return err
		}
		before, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, query)
		if err != nil {
			return err
		}
		if len(before.Items) != 1 || before.Items[0].Task.ID != dependent.ID || !before.HasMore {
			t.Fatalf("filtered predecessor page: %#v", before)
		}
		mustQueryExec(t, db, `UPDATE tasks SET status='done',version=version+1 WHERE id=$1`, predecessor.ID)
		after, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, query)
		if err != nil {
			return err
		}
		repeated, err := snapshot.TaskDAO().TaskListFence(ctx, project.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(after, before) || repeated != fence {
			t.Fatalf("snapshot changed page/fence: %#v %#v %#v %#v", before, after, fence, repeated)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		fresh, err := snapshot.TaskDAO().TaskListFence(ctx, project.ID)
		if err != nil {
			return err
		}
		page, err := snapshot.TaskDAO().TaskPriorityList(ctx, project.ID, query)
		if err != nil {
			return err
		}
		if fresh == fence || len(page.Items) != 0 || page.HasMore {
			t.Fatalf("fresh snapshot retained old predecessor fence/page: %#v %#v", fresh, page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
