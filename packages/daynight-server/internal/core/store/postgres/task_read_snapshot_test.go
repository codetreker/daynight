package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func taskSnapshotPeople(t *testing.T, facts []model.TaskAssigneeFact) map[string]model.TaskAssigneeFact {
	t.Helper()
	people := make(map[string]model.TaskAssigneeFact, len(facts))
	for _, fact := range facts {
		if _, exists := people[fact.UserID]; exists {
			t.Fatalf("snapshot duplicated person %s", fact.UserID)
		}
		people[fact.UserID] = fact
	}
	return people
}

func taskSnapshotAssignees(ctx context.Context, snapshot SnapshotScope, projectID string, ids []string) ([]model.TaskAssigneeFact, error) {
	if ids != nil {
		return snapshot.TaskDAO().ResolveTaskAssignees(ctx, projectID, ids)
	}
	return snapshot.TaskDAO().TaskAssignees(ctx, projectID)
}

func readTaskSnapshotAssignees(t *testing.T, database *Store, projectID string, ids []string) []model.TaskAssigneeFact {
	t.Helper()
	var facts []model.TaskAssigneeFact
	if err := database.ReadSnapshot(t.Context(), func(snapshot SnapshotScope) error {
		var err error
		facts, err = taskSnapshotAssignees(t.Context(), snapshot, projectID, ids)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return facts
}

func TestTaskObservationKeepsEpochAndTaskInOneSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		old, err := snapshot.TaskDAO().Task(ctx, project.ID, target.ID)
		if err != nil {
			return err
		}
		write, err := database.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer write.Rollback(context.Background())
		if _, err = write.Exec(ctx, `UPDATE tasks SET title='After replacement' WHERE id=$1`, target.ID); err != nil {
			return err
		}
		if _, err = write.Exec(ctx, `UPDATE projects SET task_cache_epoch=gen_random_uuid() WHERE id=$1`, project.ID); err != nil {
			return err
		}
		if err = write.Commit(ctx); err != nil {
			return err
		}
		epoch, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(old, target) || epoch != before {
			return fmt.Errorf("Task and epoch mixed snapshots: task=%#v epoch=%s", old, epoch)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		fresh, err := snapshot.TaskDAO().Task(ctx, project.ID, target.ID)
		if err != nil {
			return err
		}
		epoch, err := snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if fresh.Title != "After replacement" || fresh.Version != target.Version || epoch == before {
			return fmt.Errorf("replacement missing from fresh snapshot: task=%#v epoch=%s", fresh, epoch)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskAssigneesReadOneMembershipAndProfileSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	for index, resolve := range []bool{false, true} {
		if !t.Run(fmt.Sprintf("resolve=%t", resolve), func(t *testing.T) {
			offset := index * 1000
			project := queryProject(t, database, offset+1)
			userID := storeAssigneeUser(t, database, project.ID, offset+101, true)
			target := queryTask(t, database, project.ID, offset+11, model.TaskTodo)
			oldName, newName := "Before snapshot", "After snapshot"
			mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, userID, oldName)
			mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, target.ID, userID)
			before := snapshotTask(t, database, project.ID, target.ID)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var ids []string
			if resolve {
				ids = []string{userID}
			}
			if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				access, err := snapshot.ProjectDAO().ProjectAccess(ctx, model.Principal{UserID: userID}, project.ID)
				if err != nil {
					return err
				}
				if access.DirectGrant == nil {
					return fmt.Errorf("initial member access omitted its direct grant: %#v", access)
				}
				if err := writeProjectForTest(database, ctx, project.ID, func(write ProjectWriteScope) error {
					return write.ProjectDAO().RemoveMember(ctx, userID)
				}); err != nil {
					return err
				}
				mustQueryExec(t, database, `UPDATE users SET name=$2,updated_at=statement_timestamp() WHERE id=$1`, userID, newName)
				facts, err := taskSnapshotAssignees(ctx, snapshot, project.ID, ids)
				if err != nil {
					return err
				}
				old := taskSnapshotPeople(t, facts)[userID]
				if !old.HasProjectAccess || !model.EqualOptional(old.Name, &oldName) {
					return fmt.Errorf("directory mixed old access with new profile: %#v", old)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			fresh := taskSnapshotPeople(t, readTaskSnapshotAssignees(t, database, project.ID, ids))[userID]
			if fresh.HasProjectAccess || !model.EqualOptional(fresh.Name, &newName) || resolve && !fresh.Qualified {
				t.Fatalf("fresh retained assignee missed access/profile change: %#v", fresh)
			}
			if after := snapshotTask(t, database, project.ID, target.ID); !reflect.DeepEqual(after, before) {
				t.Fatalf("directory read changed assigned Task: before=%#v after=%#v", before, after)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, database.Pool)
	}
}

func TestTaskAssigneesReadOneAssignmentSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	for index, resolve := range []bool{false, true} {
		if !t.Run(fmt.Sprintf("resolve=%t", resolve), func(t *testing.T) {
			offset := index * 1000
			project := queryProject(t, database, offset+1)
			former := storeAssigneeUser(t, database, project.ID, offset+101, false)
			target := queryTask(t, database, project.ID, offset+11, model.TaskTodo)
			mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, target.ID, former)
			before := snapshotTask(t, database, project.ID, target.ID)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			var ids []string
			if resolve {
				ids = []string{former}
			}
			var changed model.Task
			if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				if _, err := snapshot.ProjectDAO().Project(ctx, project.ID); err != nil {
					return err
				}
				if err := writeProjectForTest(database, ctx, project.ID, func(write ProjectWriteScope) error {
					var err error
					changed, err = write.TaskDAO().UpdateTask(ctx, target.ID, TaskWrite{Title: before.Title, Description: before.Description, Status: before.Status, Properties: before.Properties})
					return err
				}); err != nil {
					return err
				}
				facts, err := taskSnapshotAssignees(ctx, snapshot, project.ID, ids)
				if err != nil {
					return err
				}
				old, found := taskSnapshotPeople(t, facts)[former]
				if !found || old.ProfileID == nil || old.HasProjectAccess || resolve && !old.Qualified {
					return fmt.Errorf("old assignment qualification was lost: %#v", facts)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			fresh, found := taskSnapshotPeople(t, readTaskSnapshotAssignees(t, database, project.ID, ids))[former]
			if resolve && (!found || fresh.Qualified || fresh.ProfileID != nil) || !resolve && found {
				t.Fatalf("fresh assignment read retained an unqualified profile: %#v", fresh)
			}
			if changed.AssignedTo != nil || changed.Version != before.Version+1 || !reflect.DeepEqual(snapshotTask(t, database, project.ID, target.ID), changed) {
				t.Fatalf("assignment replacement not preserved: before=%#v after=%#v", before, changed)
			}
		}) {
			return
		}
		testutil.AssertPoolReusable(t, database.Pool)
	}
}

func TestTaskSyncAssigneeFactsUseTheTaskSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	member := storeAssigneeUser(t, database, project.ID, 101, true)
	unreferenced := storeAssigneeUser(t, database, project.ID, 102, true)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	oldName, newName := "Before profile", "Fresh profile"
	mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, member, oldName)
	mustQueryExec(t, database, `UPDATE tasks SET assigned_to=$2 WHERE id=$1`, target.ID, member)
	initial := readTaskSnapshotAssignees(t, database, project.ID, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160); err != nil {
			return err
		}
		if err := writeProjectForTest(database, ctx, project.ID, func(write ProjectWriteScope) error {
			_, err := write.TaskDAO().UpdateTask(ctx, target.ID, TaskWrite{Title: "Changed in another transaction", Description: target.Description, Status: target.Status, AssignedTo: &member})
			return err
		}); err != nil {
			return err
		}
		mustQueryExec(t, database, `UPDATE users SET name=$2 WHERE id=$1`, member, newName)
		mustQueryExec(t, database, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=ANY($2::uuid[])`, project.ID, []string{member, unreferenced})
		oldTasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		oldPeople, err := snapshot.TaskDAO().TaskAssignees(ctx, project.ID)
		if err != nil {
			return err
		}
		if len(oldTasks) != 1 || oldTasks[0].TitlePreview != target.Title || oldTasks[0].Version != target.Version || !reflect.DeepEqual(oldPeople, initial) {
			return fmt.Errorf("TaskSync mixed Task and people snapshots: tasks=%#v people=%#v", oldTasks, oldPeople)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		tasks, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		facts, err := snapshot.TaskDAO().TaskAssignees(ctx, project.ID)
		if err != nil {
			return err
		}
		people := taskSnapshotPeople(t, facts)
		former, exists := people[member]
		if len(tasks) != 1 || tasks[0].TitlePreview == target.Title || tasks[0].Version != target.Version+1 || !exists || former.HasProjectAccess || !model.EqualOptional(former.Name, &newName) {
			return fmt.Errorf("fresh snapshot missed Task/profile/qualification changes: tasks=%#v people=%#v", tasks, facts)
		}
		if _, exists := people[unreferenced]; exists {
			return fmt.Errorf("unreferenced former member remained in catalogue: %#v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func storeAssigneeUser(t *testing.T, database *Store, projectID string, number int, member bool) string {
	t.Helper()
	id := queryID(number)
	mustQueryExec(t, database, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,$1::uuid::text,now(),now())`, id)
	if member {
		mustQueryExec(t, database, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, id)
	}
	return id
}

func testGraphSelection() TaskGraphSelection {
	return TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
}

func TestTaskGraphProjectionKeepsSnapshot(t *testing.T) {
	parallelRootDatabaseTest(t)
	s := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, s, 1)
	a := queryTask(t, s, project.ID, 11, model.TaskTodo)
	b := queryTask(t, s, project.ID, 12, model.TaskTodo, a.ID)
	if err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if _, err := snapshot.ProjectDAO().Project(ctx, project.ID); err != nil {
			return err
		}
		before, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, a.ID, testGraphSelection(), 160)
		if err != nil {
			return err
		}
		if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
			if _, err := tx.TaskDAO().UpdateTask(ctx, a.ID, TaskWrite{Title: "Changed", Status: model.TaskDone}); err != nil {
				return err
			}
			_, err := tx.TaskDAO().CreateTask(ctx, queryID(13), TaskWrite{Title: "New", Status: model.TaskTodo, DependsOn: []string{b.ID}})
			return err
		}); err != nil {
			return err
		}
		after, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, a.ID, testGraphSelection(), 160)
		if err != nil || len(before) != 2 || !reflect.DeepEqual(after, before) {
			t.Fatalf("graph mixed snapshots: before %#v after %#v, %v", before, after, err)
		}
		tasks, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, queryID(11), testGraphSelection(), 160)
		if err != nil || len(tasks) != 2 || tasks[0].TitlePreview != a.Title || tasks[0].Status != model.TaskTodo ||
			!reflect.DeepEqual(tasks[1].BlockedBy, []string{a.ID}) || tasks[1].Ready {
			t.Fatalf("projection mixed snapshots: %#v, %v", tasks, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	fresh := snapshotTask(t, s, project.ID, b.ID)
	if !fresh.Ready || len(fresh.BlockedBy) != 0 || fresh.Version != b.Version || fresh.UpdatedAt != b.UpdatedAt || !slices.Equal(fresh.DependsOn, b.DependsOn) {
		t.Fatalf("fresh derived state changed Task metadata: %#v, before %#v", fresh, b)
	}
}

func graphCancellationWaiter(t *testing.T, ctx context.Context, observer *Store, reader, blocker uint32) {
	t.Helper()
	for {
		var blocked bool
		if err := observer.Pool.QueryRow(ctx, `SELECT coalesce((SELECT wait_event_type='Lock'
 AND $2::integer=ANY(pg_blocking_pids(pid)) FROM pg_stat_activity WHERE pid=$1),false)`, reader, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("graph reader %d did not wait for blocker %d: %v", reader, blocker, err)
		}
	}
}

func graphCancellationReleased(t *testing.T, ctx context.Context, observer *Store, reader uint32) {
	t.Helper()
	for {
		var active bool
		if err := observer.Pool.QueryRow(ctx, `SELECT coalesce((SELECT state='active'
 OR xact_start IS NOT NULL OR cardinality(pg_blocking_pids(pid))>0 FROM pg_stat_activity WHERE pid=$1),false)`, reader).Scan(&active); err != nil {
			t.Fatal(err)
		}
		if !active {
			return
		}
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("canceled graph reader %d retained a transaction or blocker: %v", reader, err)
		}
	}
}

func graphCancellationPoolDrained(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for pool.Stat().AcquiredConns() != 0 {
		if err := waitThreadClock(ctx); err != nil {
			t.Fatalf("canceled graph snapshot retained %d acquired connections: %v", pool.Stat().AcquiredConns(), err)
		}
	}
}

func TestTaskGraphSnapshotCancellationReleasesBlockedQuery(t *testing.T) {
	parallelRootDatabaseTest(t)
	database, principal, _, project := membershipFixture(t)
	root := queryTask(t, database, project.ID, 10, model.TaskTodo)
	queryTask(t, database, project.ID, 11, model.TaskTodo, root.ID)
	for _, test := range []struct {
		name, table string
		read        func(context.Context, SnapshotScope) error
	}{
		{"project access", "projects", func(ctx context.Context, snapshot SnapshotScope) error {
			_, err := snapshot.ProjectDAO().ProjectAccess(ctx, principal, project.ID)
			return err
		}},
		{"graph projection", "tasks", func(ctx context.Context, snapshot SnapshotScope) error {
			_, err := snapshot.TaskDAO().TaskGraphTasks(ctx, project.ID, root.ID, testGraphSelection(), 160)
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			bounded, stop := context.WithTimeout(t.Context(), 10*time.Second)
			defer stop()
			config := database.Pool.Config().Copy()
			config.MaxConns = 1
			config.MinConns = 0
			config.ConnConfig.RuntimeParams["application_name"] = fmt.Sprintf("graph-cancellation-%s", test.table)
			pool, err := pgxpool.NewWithConfig(bounded, config)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			reader := &Store{Pool: pool}
			var readerPID uint32
			if err := pool.QueryRow(bounded, "SELECT pg_backend_pid()").Scan(&readerPID); err != nil {
				t.Fatal(err)
			}
			holder, err := database.Pool.Begin(bounded)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := holder.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("graph lock cleanup: %v", err)
				}
			}()
			if _, err := holder.Exec(bounded, "LOCK TABLE "+test.table+" IN ACCESS EXCLUSIVE MODE"); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(bounded)
			finished := make(chan error, 1)
			go func() {
				finished <- reader.ReadSnapshot(ctx, func(snapshot SnapshotScope) error { return test.read(ctx, snapshot) })
			}()
			drained := false
			t.Cleanup(func() {
				cancel()
				if drained {
					return
				}
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Error("graph snapshot did not stop during cleanup")
				}
			})
			graphCancellationWaiter(t, bounded, database, readerPID, holder.Conn().PgConn().PID())
			cancel()
			select {
			case err := <-finished:
				drained = true
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("graph cancellation lost its caller cause: %v", err)
				}
			case <-bounded.Done():
				t.Fatal("canceled graph snapshot did not return")
			}
			graphCancellationReleased(t, bounded, database, readerPID)
			graphCancellationPoolDrained(t, bounded, pool)
			if err := pool.Ping(bounded); err != nil {
				t.Fatalf("graph pool could not be reused while the original lock remained: %v", err)
			}
			if err := holder.Rollback(bounded); err != nil {
				t.Fatal(err)
			}
			if err := reader.ReadSnapshot(bounded, func(snapshot SnapshotScope) error {
				tasks, err := snapshot.TaskDAO().TaskGraphTasks(bounded, project.ID, root.ID, testGraphSelection(), 160)
				if err != nil {
					return err
				}
				if len(tasks) != 2 || tasks[0].ID != root.ID || len(tasks[1].DependsOn) != 1 || tasks[1].DependsOn[0] != root.ID {
					return fmt.Errorf("graph read after cancellation: tasks=%#v", tasks)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestTaskPrioritySnapshotRetainsPredecessorOrderingAndFence(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, db, 1)
	predecessor := queryTask(t, db, project.ID, 10, model.TaskTodo)
	dependent := queryTask(t, db, project.ID, 11, model.TaskTodo, predecessor.ID)
	queryTask(t, db, project.ID, 12, model.TaskTodo, predecessor.ID)
	ready := false
	query := TaskPriorityQuery{Limit: 1, Ready: &ready, ExcludeTerminal: true}
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
