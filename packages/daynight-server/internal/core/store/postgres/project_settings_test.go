package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectSettingsStoreUpdatesAndRollbackKeepOneProjectResource(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	other := queryProject(t, database, 2)
	if project.Settings != (model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) {
		t.Fatalf("new project has no explicit settings default: %#v", project)
	}
	for _, field := range []string{"execution_warning_minutes", "settings_version"} {
		_, err := database.Pool.Exec(ctx, `UPDATE projects SET `+field+`=0 WHERE id=$1`, project.ID)
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("invalid %s bypassed storage constraint: %v", field, err)
		}
	}
	var saved model.Project
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		before, err := tx.ProjectDAO().Project(ctx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, project) {
			t.Fatalf("locked project disagrees with creation: %#v", before)
		}
		saved, err = tx.ProjectDAO().UpdateProjectSettings(ctx, 90)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if saved.Settings != (model.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}) || !saved.UpdatedAt.After(project.UpdatedAt) || !saved.CreatedAt.Equal(project.CreatedAt) {
		t.Fatalf("settings write changed the wrong metadata: %#v", saved)
	}
	failure := errors.New("reject project transaction after setting write")
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		if _, err := tx.ProjectDAO().UpdateProjectSettings(ctx, 120); err != nil {
			return err
		}
		return failure
	}); !errors.Is(err, failure) {
		t.Fatalf("rollback lost its original cause: %v", err)
	}
	assertStoredProject := func(want model.Project) {
		t.Helper()
		if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			read, err := snapshot.ProjectDAO().Project(ctx, project.ID)
			if err != nil {
				return err
			}
			unchanged, err := snapshot.ProjectDAO().Project(ctx, other.ID)
			if err != nil {
				return err
			}
			page, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 10})
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(read, want) || !reflect.DeepEqual(unchanged, other) || !reflect.DeepEqual(page.Items, []model.Project{want, other}) {
				t.Fatalf("project settings lost isolation, rollback or list consistency: %#v %#v %#v", read, unchanged, page)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			read, err := tx.ProjectDAO().Project(ctx)
			if err == nil && !reflect.DeepEqual(read, want) {
				t.Fatalf("locked project settings disagreed with committed readers: %#v %#v", read, want)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	assertStoredProject(saved)
	const exactVersion int64 = 9007199254740993
	mustQueryExec(t, database, `UPDATE projects SET settings_version=$2 WHERE id=$1`, project.ID, exactVersion)
	saved.Settings.Version = exactVersion
	assertStoredProject(saved)
	for _, minutes := range []int32{2147483647, 1} {
		before := saved
		if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			locked, err := tx.ProjectDAO().Project(ctx)
			if err != nil {
				return err
			}
			if !reflect.DeepEqual(locked, before) {
				t.Fatalf("precise settings version changed before update: %#v %#v", locked, before)
			}
			saved, err = tx.ProjectDAO().UpdateProjectSettings(ctx, minutes)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if saved.Settings != (model.ProjectSettings{Version: before.Settings.Version + 1, ExecutionWarningMinutes: minutes}) || !saved.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("precise settings update: %#v", saved)
		}
		preserved := saved
		preserved.Settings, preserved.UpdatedAt = before.Settings, before.UpdatedAt
		if !reflect.DeepEqual(preserved, before) {
			t.Fatalf("settings update changed unrelated project facts: %#v %#v", saved, before)
		}
		assertStoredProject(saved)
	}
}
