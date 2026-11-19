//go:build stress

package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

// Run explicitly with -tags=stress. Ordinary module and CI suites must not
// include this mixed-edge size and access-path qualification.
func TestGoalRelationsMixedGraphQualification(t *testing.T) {
	for _, goalCount := range []int{1000, 10000} {
		t.Run(map[int]string{1000: "sparse-goal", 10000: "dense-goal"}[goalCount], func(t *testing.T) {
			f := emptyGoalRelationFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
			defer cancel()
			_, viewer, _ := testutil.AuthRecords(t, f.db)
			mustQueryExec(t, f.db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, f.upProject.ID, viewer.UserID)
			mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status)
 SELECT md5('qualification-task-'||i)::uuid,$1,'task','ordinary','todo' FROM generate_series(1,10000) i`, f.downProject.ID)
			mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,external)
 SELECT $1,md5('qualification-task-'||i)::uuid,md5('qualification-task-'||(i-1))::uuid,'task',false FROM generate_series(2,10000) i`, f.downProject.ID)
			mustQueryExec(t, f.db, `INSERT INTO tasks(id,project_id,type,title,status)
 SELECT md5('qualification-goal-'||i)::uuid,CASE WHEN i%2=0 THEN $1::uuid ELSE $3::uuid END,'goal','acceptance','todo' FROM generate_series(1,$2::integer) i`, f.downProject.ID, goalCount, f.upProject.ID)
			mustQueryExec(t, f.db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,dependency_type,goal_edge_id,external)
 SELECT CASE WHEN i%2=0 THEN $1::uuid ELSE $3::uuid END,md5('qualification-goal-'||i)::uuid,md5('qualification-goal-'||CASE WHEN i<=1000 THEN (i-1) ELSE 1 END)::uuid,
 'goal',md5('qualification-edge-'||i)::uuid,false FROM generate_series(2,$2::integer) i`, f.downProject.ID, goalCount, f.upProject.ID)
			mustQueryExec(t, f.db, `ANALYZE tasks; ANALYZE task_dependencies; ANALYZE project_grants; ANALYZE project_ownership; ANALYZE team_members`)
			var first, deep string
			if err := f.db.Pool.QueryRow(ctx, `SELECT md5('qualification-goal-1')::uuid::text,md5('qualification-goal-1000')::uuid::text`).Scan(&first, &deep); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			err := f.db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
				dao := scope.GoalRelationDAO()
				rows, err := dao.Successors(ctx, f.upProject.ID, first, viewer.UserID, "", 21)
				want := 21
				if goalCount == 1000 {
					want = 0
				}
				if err == nil && len(rows) != want {
					t.Errorf("successor page=%d want %d", len(rows), want)
				}
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("actual DAO ACL successor default-page latency=%s Goals=%d ordinaryTasks=10000", time.Since(started), goalCount)
			_, err = f.db.WriteProject(ctx, f.downProject.ID, func(scope store.ProjectWriteScope) error {
				dao := scope.GoalRelationDAO()
				if err := dao.LockTeam(ctx); err != nil {
					return err
				}
				started := time.Now()
				found, err := dao.Reaches(ctx, f.downProject.ID, deep, first, []string{})
				if err == nil && !found {
					t.Error("deep Goal path was not reachable")
				}
				t.Logf("actual DAO 1000-Goal traversal latency=%s", time.Since(started))
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			explainGoalRelation(t, ctx, f.db, "authorized successors", `SELECT p.id::text,p.name,t.id::text,t.title,t.status
 FROM task_dependencies d JOIN task_resource_rows t ON t.project_id=d.project_id AND t.id=d.task_id AND t.type='goal' AND t.effective_deleted_at IS NULL
 JOIN projects p ON p.id=t.project_id AND p.deleted_at IS NULL
 JOIN (`+pg.ProjectAccessRelation+`) a ON a.project_id=p.id AND a.user_id=$2
 WHERE d.depends_on_task_id=$1 AND d.dependency_type='goal' AND ($3::uuid IS NULL OR t.id>$3)
 ORDER BY t.id LIMIT $4`, first, viewer.UserID, nil, 21)
			explainGoalRelation(t, ctx, f.db, "outgoing edges", `SELECT d.goal_edge_id::text,t.project_id::text,t.id::text,t.status
 FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id
 WHERE d.project_id=$1 AND d.task_id=$2 AND d.dependency_type='goal' ORDER BY d.goal_edge_id`, f.downProject.ID, deep)
			explainGoalRelation(t, ctx, f.db, "1000-Goal reachability", `WITH RECURSIVE reachable(project_id,id) AS (
 SELECT $1::uuid,$2::uuid UNION SELECT t.project_id,t.id FROM reachable r
 JOIN task_dependencies d ON d.project_id=r.project_id AND d.task_id=r.id AND d.dependency_type='goal'
 JOIN tasks t ON t.id=d.depends_on_task_id WHERE NOT(d.goal_edge_id=ANY($4::uuid[])))
 SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$3)`, f.downProject.ID, deep, first, []string{})
			var walStart, walEnd string
			var heldLocks int
			started = time.Now()
			_, err = f.db.WriteProject(ctx, f.downProject.ID, func(scope store.ProjectWriteScope) error {
				if err := scope.ProjectGoalDependencyDAO().LockTeam(ctx); err != nil {
					return err
				}
				tx := scope.(*ProjectTx).tx
				if err := tx.QueryRow(ctx, `SELECT pg_current_wal_insert_lsn()::text`).Scan(&walStart); err != nil {
					return err
				}
				if err := scope.ProjectGoalDependencyDAO().RemoveProjectEdges(ctx); err != nil {
					return err
				}
				return tx.QueryRow(ctx, `SELECT pg_current_wal_insert_lsn()::text,(SELECT count(*) FROM pg_locks WHERE pid=pg_backend_pid() AND granted)`).Scan(&walEnd, &heldLocks)
			})
			if err != nil {
				t.Fatal(err)
			}
			var walBytes int64
			if err := f.db.Pool.QueryRow(ctx, `SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::bigint`, walEnd, walStart).Scan(&walBytes); err != nil {
				t.Fatal(err)
			}
			removed := 999 + (goalCount-1000)/2
			t.Logf("actual project cleanup transaction latency=%s edgesRemoved=%d heldLocks=%d WAL-insert-LSN-delta=%d bytes (cluster-wide observation)", time.Since(started), removed, heldLocks, walBytes)
			var ordinary, goals, revisions int
			if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE dependency_type='task'),count(*) FILTER(WHERE dependency_type='goal'),(SELECT count(*) FROM goal_dependency_revisions) FROM task_dependencies`).Scan(&ordinary, &goals, &revisions); err != nil || ordinary != 9999 || goals != goalCount-1-removed || revisions != removed {
				t.Fatalf("cleanup mixed-edge readback ordinary=%d goal=%d revisions=%d error=%v", ordinary, goals, revisions, err)
			}
		})
	}
}

func explainGoalRelation(t *testing.T, ctx context.Context, db *Store, name, statement string, args ...any) {
	t.Helper()
	rows, err := db.Pool.Query(ctx, "EXPLAIN (ANALYZE, BUFFERS) "+statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	t.Log(name)
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		t.Log(line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
}
