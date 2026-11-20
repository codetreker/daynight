package task_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
)

func TestGoalRelationEdgesRejectsMissingStoredIdentity(t *testing.T) {
	db := readerStore(t)
	project := readerProject(t, db, 1)
	downstream, upstream := readerID(11), readerID(12)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','Downstream','todo'),($2,$3,'goal','Upstream','todo')`, downstream, upstream, project.ID)
	edgeID := readerID(21)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, project.ID, downstream, upstream, edgeID)
	if err := readerWriteProject(db, t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
		dao := scope.GoalRelationDAO()
		if err := dao.LockTeam(t.Context()); err != nil {
			return err
		}
		edges, err := dao.Edges(t.Context(), downstream)
		if err != nil {
			return err
		}
		if len(edges) != 1 || edges[0].ID != edgeID || edges[0].Endpoint.ProjectID != project.ID || edges[0].Endpoint.GoalID != upstream || edges[0].Status != "todo" {
			t.Fatalf("stored Goal edge: %+v", edges)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// The shared column is nullable for ordinary Task edges. A malformed Goal
	// edge must fail decoding rather than becoming an unremovable hidden edge.
	readerExec(t, db, `UPDATE task_dependencies SET goal_edge_id=NULL WHERE project_id=$1 AND task_id=$2 AND depends_on_task_id=$3`, project.ID, downstream, upstream)
	err := readerWriteProject(db, t.Context(), project.ID, func(scope store.ProjectWriteScope) error {
		dao := scope.GoalRelationDAO()
		if err := dao.LockTeam(t.Context()); err != nil {
			return err
		}
		edges, err := dao.Edges(t.Context(), downstream)
		if err == nil || edges != nil {
			t.Fatalf("malformed edge returned as data: %+v %v", edges, err)
		}
		if !strings.Contains(err.Error(), "scan Goal edit edges") {
			t.Fatalf("missing scan failure context: %v", err)
		}
		return err
	})
	if err == nil {
		t.Fatal("malformed stored identity was accepted")
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM task_dependencies WHERE project_id=$1 AND task_id=$2`, project.ID, downstream).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed read changed stored edge: count=%d error=%v", count, err)
	}
}

func TestGoalRelationEdgesPreservesCanceledQuery(t *testing.T) {
	db := readerStore(t)
	project := readerProject(t, db, 1)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := tx.Rollback(t.Context()); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("rollback canceled-query transaction: %v", err)
		}
	}()
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	edges, err := task.NewGoalRelationEditor(tx, project.ID).Edges(ctx, readerID(11))
	if !errors.Is(err, context.Canceled) || edges != nil {
		t.Fatalf("canceled query returned data or lost cause: %+v %v", edges, err)
	}
}
