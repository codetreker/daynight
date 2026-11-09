package postgres

import (
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func searchMutationFence(t *testing.T, database *Store, projectID string) store.TaskSearchFence {
	t.Helper()
	var fence store.TaskSearchFence
	if err := NewTaskSearch(database.Pool).ReadTaskSearch(t.Context(), func(snapshot store.TaskSearchSnapshot) error {
		var err error
		fence, err = snapshot.Fence(t.Context(), projectID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return fence
}
func TestTaskSearchRollbackRetainsFenceAndPersistentTask(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	ctx := t.Context()
	t.Run("read-only and rollback retain fence", func(t *testing.T) {
		before := searchMutationFence(t, database, project.ID)
		read := snapshotTask(t, database, project.ID, target.ID)
		if !reflect.DeepEqual(read, target) || searchMutationFence(t, database, project.ID) != before {
			t.Fatal("read-only snapshot changed the fence")
		}
		refusal := errors.New("rollback sentinel")
		completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			values := taskMutationValues(target)
			values.Title = "Must roll back"
			if _, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values); err != nil {
				return err
			}
			return refusal
		})
		if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("rollback outcome: %+v %v", completion, err)
		}
		if searchMutationFence(t, database, project.ID) != before || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), target) {
			t.Fatal("rolled-back update changed persistent task or fence")
		}
	})
}
