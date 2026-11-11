package task_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestVisibleDependencyIDsDatabaseFailures(t *testing.T) {
	for _, test := range []struct {
		name, ddl, code string
	}{
		{"missing relation", `DROP VIEW task_resource_rows`, "42P01"},
		{"row evaluation", `CREATE FUNCTION fail_visibility() RETURNS timestamptz LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1004', MESSAGE='private visibility failure'; END $$;
			ALTER VIEW task_resource_rows RENAME TO resource_source;
			CREATE VIEW task_resource_rows AS SELECT id,project_id,type,fail_visibility() AS effective_deleted_at FROM resource_source`, "P1004"},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := writerStore(t)
			project := writerProject(t, database, 1)
			target := writerTask(t, database, project.ID, 10, model.TaskTodo)
			readerExec(t, database, test.ddl)
			var got []string
			err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
				var inner error
				got, inner = dao.VisibleTaskIDs(t.Context(), []string{target.ID})
				return inner
			})
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != test.code || got != nil || strings.Contains(err.Error(), "private") {
				t.Fatalf("visibility error or partial result: ids=%v err=%v cause=%+v", got, err, cause)
			}
		})
	}
	t.Run("cancelled context", func(t *testing.T) {
		database := writerStore(t)
		project := writerProject(t, database, 1)
		err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			ids, err := dao.VisibleTaskIDs(ctx, []string{project.ID})
			if ids != nil {
				t.Fatalf("cancelled lookup returned ids: %v", ids)
			}
			return err
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation cause lost: %v", err)
		}
	})
}
