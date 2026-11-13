package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
)

func TestTaskTagAssociationsAndTouch(t *testing.T) {
	db := readerStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := readerProject(t, db, 1)
	other := readerProject(t, db, 2)
	live := readerTask(t, db, project.ID, 11, model.TaskDone)
	deleted := readerTask(t, db, project.ID, 12, model.TaskCancelled)
	foreign := readerTask(t, db, other.ID, 13, model.TaskTodo)
	dependency := readerTask(t, db, project.ID, 14, model.TaskTodo)
	goalID, hiddenGoalID, hiddenChildID := readerID(15), readerID(16), readerID(17)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,title,type,status,deleted_at) VALUES ($1,$3,'goal','goal','todo',NULL),($2,$3,'hidden goal','goal','todo',now())`, goalID, hiddenGoalID, project.ID)
	readerExec(t, db, `INSERT INTO tasks(id,project_id,title,type,status,parent_id) VALUES ($1,$2,'hidden child','task','todo',$3)`, hiddenChildID, project.ID, hiddenGoalID)
	actor := readerAssigneeUser(t, db, project.ID, 31, true)
	readerExec(t, db, `UPDATE tasks SET parent_id=$2, assigned_to=$3, allow_agents=true, required_platform='linux' WHERE id=$1`, live.ID, goalID, actor)
	readerExec(t, db, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3)`, project.ID, live.ID, dependency.ID)
	claim := readerWorkerClaim(32, actor, readerID(33), model.WorkerActive)
	readerPutProperty(t, db, live.ID, "worker", readerTaskProperties(t, claim)["worker"])
	tag1, tag2, otherTag := readerID(21), readerID(22), readerID(23)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES
		($1,$4,'One','one',now(),now()),($2,$4,'Two','two',now(),now()),($3,$5,'One','one',now(),now())`, tag1, tag2, otherTag, project.ID, other.ID)
	readerExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, deleted.ID)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3),($4,$5,$6)`, project.ID, deleted.ID, tag1, other.ID, foreign.ID, otherTag)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3)`, project.ID, hiddenChildID, tag2)
	var beforeTask, beforeProject, beforeRelations string
	if err := db.Pool.QueryRow(ctx, `SELECT (to_jsonb(t)-'version'-'updated_at')::text FROM tasks t WHERE id=$1`, live.ID).Scan(&beforeTask); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, project.ID).Scan(&beforeProject); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id)::text FROM task_dependencies d WHERE task_id=$1) || (SELECT jsonb_agg(to_jsonb(p) ORDER BY name)::text FROM task_properties p WHERE task_id=$1)`, live.ID).Scan(&beforeRelations); err != nil {
		t.Fatal(err)
	}
	observed := time.Now().UTC().Truncate(time.Microsecond)
	if err := readerWriteProject(db, ctx, project.ID, func(scope ProjectWriteScope) error {
		dao := scope.TaskTagDAO()
		if err := dao.ReplaceTaskTags(ctx, live.ID, []string{tag2, tag1, tag1}); err != nil {
			return err
		}
		refs, err := dao.TaskTags(ctx, live.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(refs, []model.TagReference{{ID: tag1, Name: "One"}, {ID: tag2, Name: "Two"}}) {
			t.Fatalf("references: %#v", refs)
		}
		readback, err := scope.TaskDAO().Task(ctx, live.ID)
		if err != nil || !reflect.DeepEqual(readback.Tags, refs) {
			t.Fatalf("task readback references: %#v, %v", readback.Tags, err)
		}
		for _, id := range []string{deleted.ID, hiddenChildID} {
			hidden, err := dao.TaskTags(ctx, id)
			if err != nil {
				return err
			}
			if len(hidden) != 0 {
				t.Fatalf("deleted resource disclosed tags: %#v", hidden)
			}
		}
		count, err := dao.TouchTaggedTasks(ctx, tag1, observed)
		if err != nil {
			return err
		}
		if count != 2 {
			t.Fatalf("touch count = %d", count)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var afterTask, afterProject, afterRelations string
	var version int64
	var updated time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT (to_jsonb(t)-'version'-'updated_at')::text,version,updated_at FROM tasks t WHERE id=$1`, live.ID).Scan(&afterTask, &version, &updated); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(p)::text FROM projects p WHERE id=$1`, project.ID).Scan(&afterProject); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id)::text FROM task_dependencies d WHERE task_id=$1) || (SELECT jsonb_agg(to_jsonb(p) ORDER BY name)::text FROM task_properties p WHERE task_id=$1)`, live.ID).Scan(&afterRelations); err != nil {
		t.Fatal(err)
	}
	if beforeRelations != afterRelations {
		t.Fatal("touch changed dependencies or worker property")
	}
	if beforeTask != afterTask || beforeProject != afterProject || version != live.Version+1 || !updated.Equal(observed) {
		t.Fatalf("touch changed unrelated data or clock: task=%v project=%v version=%d updated=%v", beforeTask == afterTask, beforeProject == afterProject, version, updated)
	}
	var deletedVersion int64
	if err := db.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, deleted.ID).Scan(&deletedVersion); err != nil || deletedVersion != deleted.Version+1 {
		t.Fatalf("deleted task touch: %d, %v", deletedVersion, err)
	}

	rollback := errors.New("rollback association replacement")
	err := readerWriteProject(db, ctx, project.ID, func(scope ProjectWriteScope) error {
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, live.ID, nil); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("rollback cause: %v", err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND task_id=$2`, project.ID, live.ID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("rollback association count %d: %v", count, err)
	}
	if err := readerWriteProject(db, ctx, project.ID, func(scope ProjectWriteScope) error { return scope.TaskTagDAO().ClearTagAssociations(ctx, tag1) }); err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2`, project.ID, tag1).Scan(&count); err != nil || count != 0 {
		t.Fatalf("clear retained deleted association: %d, %v", count, err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND task_id=$2 AND tag_id=$3`, other.ID, foreign.ID, otherTag).Scan(&count); err != nil || count != 1 {
		t.Fatalf("foreign association changed: %d, %v", count, err)
	}
}

// Failed replacement must roll back its earlier deletion, and DAO errors must
// retain the underlying transaction failure for completion handling.
func TestTaskTagWriteFailures(t *testing.T) {
	db := readerStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	tagID := readerID(21)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES ($1,$2,'name','name',now(),now())`, tagID, project.ID)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3)`, project.ID, item.ID, tagID)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := task.NewTagWriter(tx, project.ID)
	err = dao.ReplaceTaskTags(ctx, item.ID, []string{"not-a-uuid"})
	if err == nil {
		t.Fatal("invalid tag identity accepted")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND task_id=$2 AND tag_id=$3`, project.ID, item.ID, tagID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("failed replacement changed associations: %d %v", count, err)
	}
	if _, err := dao.TaskTags(ctx, item.ID); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("read closed transaction: %v", err)
	}
	if err := dao.ReplaceTaskTags(ctx, item.ID, nil); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("replace closed transaction: %v", err)
	}
	if _, err := dao.TouchTaggedTasks(ctx, tagID, time.Now()); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("touch closed transaction: %v", err)
	}
	if err := dao.ClearTagAssociations(ctx, tagID); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("clear closed transaction: %v", err)
	}
}

func TestTaskReceiptsLoadCurrentTagsInTransaction(t *testing.T) {
	db := readerStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := readerProject(t, db, 1)
	taskID, tagID := readerID(11), readerID(21)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES ($1,$2,'name','name',now(),now())`, tagID, project.ID)
	want := []model.TagReference{{ID: tagID, Name: "name"}}
	if err := readerWriteProject(db, ctx, project.ID, func(scope ProjectWriteScope) error {
		created, err := scope.TaskDAO().CreateTask(ctx, taskID, TaskWrite{Title: "created", Status: model.TaskTodo})
		if err != nil {
			return err
		}
		if len(created.Tags) != 0 {
			t.Fatalf("new task tags: %#v", created.Tags)
		}
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, taskID, []string{tagID}); err != nil {
			return err
		}
		updated, err := scope.TaskDAO().UpdateTask(ctx, taskID, TaskWrite{Title: "updated", Status: model.TaskTodo})
		if err != nil || !reflect.DeepEqual(updated.Tags, want) {
			t.Fatalf("updated receipt: %#v, %v", updated.Tags, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		got, err := scope.TaskDAO().Task(ctx, project.ID, taskID)
		if err != nil || !reflect.DeepEqual(got.Tags, want) {
			t.Fatalf("committed task: %#v, %v", got.Tags, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
