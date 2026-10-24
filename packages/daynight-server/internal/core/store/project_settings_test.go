package store

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestProjectSettingsMigrationPreservesHistoricalMetadataAndTiming(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:9]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := projectBeforeSettings(t, database, 1)
	taskID := queryID(11)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	mustQueryExec(t, database, `UPDATE projects SET created_at=$2,updated_at=$3 WHERE id=$1`, project.ID, stamp, stamp.Add(time.Hour))
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at)
		VALUES ($1,$2,'Historical completed task','Preserved metadata','done',17,$3,$4,$3,$5)`, taskID, project.ID, stamp, stamp.Add(time.Hour), stamp.Add(time.Minute))
	taskMetadata := func() string {
		var value string
		if err := pool.QueryRow(ctx, `SELECT (to_jsonb(t)-'allow_agents'-'required_platform')::text FROM tasks t WHERE id=$1`, taskID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	beforeTask := taskMetadata()
	if err := migrate(ctx, pool, schemaMigrations[:10]); err != nil {
		t.Fatal(err)
	}
	var migrated core.Project
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		var err error
		migrated, err = snapshot.Project(ctx, project.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if migrated.ID != project.ID || migrated.Name != project.Name || migrated.RepoURL != project.RepoURL || !migrated.CreatedAt.Equal(stamp) || !migrated.UpdatedAt.Equal(stamp.Add(time.Hour)) || migrated.Settings != (core.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) || taskMetadata() != beforeTask {
		t.Fatalf("settings migration changed history or omitted defaults: %#v", migrated)
	}
	for _, field := range []string{"execution_warning_minutes", "settings_version"} {
		_, err := pool.Exec(ctx, `UPDATE projects SET `+field+`=0 WHERE id=$1`, project.ID)
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("invalid %s bypassed storage constraint: %v", field, err)
		}
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=10").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:10]); err != nil {
		t.Fatal(err)
	}
	var repeated time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=10").Scan(&repeated); err != nil || !repeated.Equal(applied) {
		t.Fatalf("repeating settings migration changed its ledger: %v, %v", repeated, err)
	}
}

func TestProjectSettingsStoreUpdatesAndRollbackKeepOneProjectResource(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	other := queryProject(t, database, 2)
	if project.Settings != (core.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) {
		t.Fatalf("new project has no explicit settings default: %#v", project)
	}
	var saved core.Project
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		before, err := tx.Project(ctx)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(before, project) {
			t.Fatalf("locked project disagrees with creation: %#v", before)
		}
		saved, err = tx.UpdateProjectSettings(ctx, 90)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if saved.Settings != (core.ProjectSettings{Version: 2, ExecutionWarningMinutes: 90}) || !saved.UpdatedAt.After(project.UpdatedAt) || !saved.CreatedAt.Equal(project.CreatedAt) {
		t.Fatalf("settings write changed the wrong metadata: %#v", saved)
	}
	failure := errors.New("reject project transaction after setting write")
	if err := database.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
		if _, err := tx.UpdateProjectSettings(ctx, 120); err != nil {
			return err
		}
		return failure
	}); !errors.Is(err, failure) {
		t.Fatalf("rollback lost its original cause: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		read, err := snapshot.Project(ctx, project.ID)
		if err != nil {
			return err
		}
		unchanged, err := snapshot.Project(ctx, other.ID)
		if err != nil {
			return err
		}
		page, err := snapshot.Projects(ctx, Page{Limit: 10})
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(read, saved) || !reflect.DeepEqual(unchanged, other) || !reflect.DeepEqual(page.Items, []core.Project{saved, other}) {
			t.Fatalf("project settings lost isolation, rollback or list consistency: %#v %#v %#v", read, unchanged, page)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
