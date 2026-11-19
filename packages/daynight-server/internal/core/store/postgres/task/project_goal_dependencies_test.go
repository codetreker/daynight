package task_test

import (
	"errors"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestProjectGoalDependencyRemovalPreservesOrdinaryAndUnrelatedEdges(t *testing.T) {
	db := readerStore(t)
	a, b := readerProject(t, db, 1), readerProject(t, db, 2)
	ids := []string{readerID(11), readerID(12), readerID(13), readerID(14), readerID(15), readerID(16)}
	for i, id := range ids {
		project := b.ID
		if i < 2 {
			project = a.ID
		}
		readerExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','Goal','todo')`, id, project)
	}
	readerExec(t, db, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$3,'ordinary','todo'),($2,$3,'ordinary','todo')`, readerID(17), readerID(18), a.ID)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES
 ($1,$3,$4,'goal',$9),($1,$3,$5,'goal',$10),($2,$5,$3,'goal',$11),($2,$5,$4,'goal',$12),($2,$6,$7,'goal',$13),($1,$8,$14,'task',NULL)`, a.ID, b.ID, ids[0], ids[1], ids[2], ids[3], ids[4], readerID(17), readerID(21), readerID(22), readerID(23), readerID(24), readerID(25), readerID(18))
	readerExec(t, db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,7)`, ids[2])
	write := func(remove bool) error {
		return readerWriteProject(db, t.Context(), a.ID, func(scope store.ProjectWriteScope) error {
			dao := scope.ProjectGoalDependencyDAO()
			if err := dao.LockTeam(t.Context()); err != nil {
				return err
			}
			found, err := dao.HasProjectEdges(t.Context())
			if err != nil {
				return err
			}
			if found != remove {
				t.Fatalf("found %v want %v", found, remove)
			}
			return dao.RemoveProjectEdges(t.Context())
		})
	}
	if err := write(true); err != nil {
		t.Fatal(err)
	}
	if err := write(false); err != nil {
		t.Fatal(err)
	}
	var ordinary, goals int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FILTER(WHERE dependency_type='task'),count(*) FILTER(WHERE dependency_type='goal') FROM task_dependencies`).Scan(&ordinary, &goals); err != nil || ordinary != 1 || goals != 1 {
		t.Fatalf("survivors task=%d goal=%d error=%v", ordinary, goals, err)
	}
	for id, want := range map[string]int64{ids[0]: 2, ids[2]: 8} {
		var got int64
		if err := db.Pool.QueryRow(t.Context(), `SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1`, id).Scan(&got); err != nil || got != want {
			t.Fatalf("revision=%d want %d error=%v", got, want, err)
		}
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM goal_dependency_revisions`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("revisions=%d error=%v", count, err)
	}
}

func TestProjectGoalDependencyRemovalRevisionRefusalsRollback(t *testing.T) {
	db := readerStore(t)
	a := readerProject(t, db, 1)
	source, target := readerID(11), readerID(12)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$3,'goal','source','todo'),($2,$3,'goal','target','todo')`, source, target, a.ID)
	for _, revision := range []int64{0, math.MaxInt64} {
		readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id) VALUES($1,$2,$3,'goal',$4)`, a.ID, source, target, readerID(21))
		readerExec(t, db, `INSERT INTO goal_dependency_revisions(goal_id,revision) VALUES($1,$2) ON CONFLICT(goal_id) DO UPDATE SET revision=$2`, source, revision)
		err := readerWriteProject(db, t.Context(), a.ID, func(scope store.ProjectWriteScope) error {
			dao := scope.ProjectGoalDependencyDAO()
			if err := dao.LockTeam(t.Context()); err != nil {
				return err
			}
			return dao.RemoveProjectEdges(t.Context())
		})
		if revision == math.MaxInt64 {
			var f *model.Fault
			if !errors.As(err, &f) || f.Code != "version_exhausted" {
				t.Fatalf("exhaustion error %v", err)
			}
		} else {
			if err == nil {
				t.Fatal("accepted invalid revision")
			}
		}
		var edges int
		var got int64
		if err := db.Pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM task_dependencies),(SELECT revision FROM goal_dependency_revisions WHERE goal_id=$1)`, source).Scan(&edges, &got); err != nil || edges != 1 || got != revision {
			t.Fatalf("rollback edges=%d revision=%d error=%v", edges, got, err)
		}
		readerExec(t, db, `DELETE FROM task_dependencies`)
	}
}
