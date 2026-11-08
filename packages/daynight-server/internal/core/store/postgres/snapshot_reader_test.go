package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestSnapshotScopeExposesOnlyReadCapabilities(t *testing.T) {
	scope := reflect.TypeOf((*SnapshotScope)(nil)).Elem()
	for i := 0; i < scope.NumMethod(); i++ {
		method := scope.Method(i)
		if method.Name == "ObservedAt" {
			continue
		}
		if method.Type.NumOut() != 1 || method.Type.Out(0).Kind() != reflect.Interface {
			t.Fatalf("%s exposes a non-reader capability: %v", method.Name, method.Type)
		}
		reader := method.Type.Out(0)
		for _, forbidden := range []string{"Exec", "Pool", "Begin", "Commit", "Rollback", "CreateTask", "WriteProject", "WriteThread"} {
			if _, ok := reader.MethodByName(forbidden); ok {
				t.Errorf("%s exposes %s", method.Name, forbidden)
			}
		}
	}
}

func TestSnapshotReadersShareAuthorizationAndDataView(t *testing.T) {
	database, _, member, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	task := queryTask(t, database, project.ID, 91, model.TaskTodo)
	mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, project.ID, member.UserID)

	err := database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); err != nil {
			return err
		}
		write, err := database.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer write.Rollback(context.Background())
		if _, err = write.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `UPDATE tasks SET title='Changed' WHERE id=$1`, task.ID); err != nil {
			return err
		}
		if err = write.Commit(ctx); err != nil {
			return err
		}
		if _, err = scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); err != nil {
			return fmt.Errorf("authorization changed within snapshot: %w", err)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if stored.Title != task.Title {
			return fmt.Errorf("task changed within snapshot: got %q, want %q", stored.Title, task.Title)
		}
		observedAt, err := scope.ObservedAt(ctx)
		if err != nil || observedAt.IsZero() || observedAt.Location() != time.UTC {
			return fmt.Errorf("invalid snapshot observation time %v: %w", observedAt, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = database.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		if _, err := scope.ProjectDAO().ProjectAccess(ctx, member, project.ID); !errors.Is(err, model.ErrNotFound) {
			return fmt.Errorf("new snapshot did not observe revoked access: %v", err)
		}
		stored, err := scope.TaskDAO().Task(ctx, project.ID, task.ID)
		if err != nil {
			return err
		}
		if stored.Title != "Changed" {
			return fmt.Errorf("new snapshot did not observe changed task: %q", stored.Title)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
