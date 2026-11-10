package project_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestInvalidateTaskCacheUsesProjectTransaction(t *testing.T) {
	ctx := t.Context()
	database := testutil.OpenStore(t, postgres.Open)
	project := testutil.QueryProject(t, database.Pool, database, 1)
	var before, after string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	raw, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Rollback(context.Background())
	dao := pgproject.NewWriter(raw, project.ID)
	if err := dao.InvalidateTaskCache(ctx); err != nil {
		t.Fatal(err)
	}
	if err := raw.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&after); err != nil || before == after {
		t.Fatalf("cache epoch did not change: %q %q %v", before, after, err)
	}
	if err := dao.InvalidateTaskCache(ctx); err == nil {
		t.Fatal("expired transaction accepted cache invalidation")
	}
}

func TestProjectReadMissingRelationPreservesDatabaseCause(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	project := testutil.QueryProject(t, database.Pool, database, 1)
	testutil.MustExec(t, database.Pool, "DROP TABLE projects")
	raw, err := database.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Rollback(context.Background())
	_, err = pgproject.NewReader(raw).Project(t.Context(), project.ID)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "42P01" {
		t.Fatalf("missing Project relation lost its driver cause: %v", err)
	}
}

func TestProjectQueryKeysets(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := t.Context()
	for _, n := range []int{1, 3, 2, 4} {
		testutil.QueryProject(t, s.Pool, s, n)
	}
	instant := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	testutil.MustExec(t, s.Pool, "UPDATE projects SET created_at=$1", instant)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		first, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 2})
		if err != nil || !first.HasMore || len(first.Items) != 2 || first.Items[0].ID != testutil.QueryID(1) || first.Items[1].ID != testutil.QueryID(2) {
			t.Fatalf("first project page: %#v, %v", first, err)
		}
		second, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 2, After: &Position{CreatedAt: instant, ID: first.Items[1].ID}})
		if err != nil || second.HasMore || len(second.Items) != 2 || second.Items[0].ID != testutil.QueryID(3) || second.Items[1].ID != testutil.QueryID(4) {
			t.Fatalf("second project page: %#v, %v", second, err)
		}
		empty, err := snapshot.ProjectDAO().Projects(ctx, Page{Limit: 2, After: &Position{CreatedAt: instant, ID: testutil.QueryID(4)}})
		if err != nil || empty.HasMore || empty.Items == nil || len(empty.Items) != 0 {
			t.Fatalf("empty project page: %#v, %v", empty, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProjectQueryReadFailuresAreNeverEmptyResults(t *testing.T) {
	t.Run("project decoding", func(t *testing.T) {
		s := testutil.OpenStore(t, postgres.Open)
		testutil.QueryProject(t, s.Pool, s, 1)
		testutil.MustExec(t, s.Pool, `ALTER TABLE projects RENAME TO project_source;
			CREATE VIEW projects AS SELECT id, name, repo_url, created_at, 1::bigint AS updated_at, settings_version, execution_warning_minutes, deleted_at FROM project_source`)
		err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Projects(context.Background(), Page{Limit: 10})
			return err
		})
		if err == nil || errors.Is(err, model.ErrNotFound) {
			t.Fatalf("project decode failure became an empty result: %v", err)
		}
	})
	t.Run("project database execution", func(t *testing.T) {
		s := testutil.OpenStore(t, postgres.Open)
		testutil.QueryProject(t, s.Pool, s, 1)
		testutil.MustExec(t, s.Pool, `CREATE FUNCTION fail_read() RETURNS text LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'private read failure'; END $$;
			ALTER TABLE projects RENAME TO project_source;
			CREATE VIEW projects AS SELECT id, fail_read() AS name, repo_url, created_at, updated_at, settings_version, execution_warning_minutes, deleted_at FROM project_source`)
		err := s.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().Projects(context.Background(), Page{Limit: 10})
			return err
		})
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "P1002" || strings.Contains(err.Error(), "private read") {
			t.Fatalf("project read failure cause or redaction: %v", err)
		}
	})

}

func TestProjectQueryScopedResourcesAndCreationMetadata(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := t.Context()
	first := testutil.QueryProject(t, s.Pool, s, 1)
	if first.CreatedAt.IsZero() || first.CreatedAt.Location() != time.UTC || !first.CreatedAt.Equal(first.UpdatedAt) {
		t.Fatalf("database creation timestamps: %#v", first)
	}
	if _, err := testutil.CreateProject(ctx, s.Pool, s, first.ID, "Duplicate", "ssh://git@example.com/repo"); err == nil {
		t.Fatal("duplicate project succeeded")
	} else {
		var cause *pgconn.PgError
		if !errors.As(err, &cause) || cause.Code != "23505" || strings.Contains(err.Error(), "projects_pkey") {
			t.Fatalf("redacted error and driver cause: %v", err)
		}
	}
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		project, err := snapshot.ProjectDAO().Project(ctx, first.ID)
		if err != nil || !reflect.DeepEqual(project, first) {
			t.Fatalf("project read: %#v, %v", project, err)
		}
		_, err = snapshot.ProjectDAO().Project(ctx, testutil.QueryID(999))
		return err
	}); !errors.Is(err, model.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing project: %v", err)
	}

}

func TestProjectContinuationRecoversAfterRelationRestored(t *testing.T) {
	database := testutil.OpenStore(t, postgres.Open)
	owner, _, first := testutil.ProjectMembershipFixture(t, database)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	for _, n := range []int{1, 2} {
		if _, err := testutil.CreatePrivateProject(ctx, database, owner, testutil.QueryID(n), "Project", "host:repo"); err != nil {
			t.Fatal(err)
		}
	}
	var position *Position
	read := func() (ProjectPage, error) {
		var page ProjectPage
		err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
			var err error
			page, err = snapshot.ProjectDAO().ScopedProjects(ctx, owner, ProjectScope{Kind: ProjectScopeAll}, Page{Limit: 1, After: position})
			return err
		})
		return page, err
	}
	page, err := read()
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.Items[0].ID != first.ID {
		t.Fatalf("first Project page: %+v %v", page, err)
	}
	position = &Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}
	baseline, err := read()
	if err != nil || len(baseline.Items) != 1 || baseline.Items[0].ID == page.Items[0].ID {
		t.Fatalf("baseline continuation: %+v %v", baseline, err)
	}
	testutil.MustExec(t, database.Pool, `ALTER TABLE projects RENAME TO private_missing_projects`)
	renamed := true
	t.Cleanup(func() {
		if renamed {
			testutil.MustExec(t, database.Pool, `ALTER TABLE private_missing_projects RENAME TO projects`)
		}
	})
	failed, err := read()
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "42P01" || len(failed.Items) != 0 {
		t.Fatalf("failed continuation returned data or lost database cause: %+v %v", failed, err)
	}
	testutil.MustExec(t, database.Pool, `ALTER TABLE private_missing_projects RENAME TO projects`)
	renamed = false
	recovered, err := read()
	if err != nil || !reflect.DeepEqual(recovered, baseline) {
		t.Fatalf("same continuation changed after recovery: baseline=%+v recovered=%+v error=%v", baseline, recovered, err)
	}
}
