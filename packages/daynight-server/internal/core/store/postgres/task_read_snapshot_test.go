package postgres

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	for _, resolve := range []bool{false, true} {
		t.Run(fmt.Sprintf("resolve=%t", resolve), func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			userID := storeAssigneeUser(t, database, project.ID, 101, true)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
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
		})
	}
}

func TestTaskAssigneesReadOneAssignmentSnapshot(t *testing.T) {
	for _, resolve := range []bool{false, true} {
		t.Run(fmt.Sprintf("resolve=%t", resolve), func(t *testing.T) {
			database := isolatedStore(t)
			project := queryProject(t, database, 1)
			former := storeAssigneeUser(t, database, project.ID, 101, false)
			target := queryTask(t, database, project.ID, 11, model.TaskTodo)
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
		})
	}
}

func TestTaskSyncAssigneeFactsUseTheTaskSnapshot(t *testing.T) {
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
