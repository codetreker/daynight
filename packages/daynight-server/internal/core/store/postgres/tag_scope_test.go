package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTagScopesShareSnapshotAndProjectTransaction(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tagID := queryID(21)
	var initialEpoch string
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		var err error
		initialEpoch, err = scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	abort := errors.New("abort tag transaction")
	completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "Before", NameKey: "before", CreatedAt: now}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		if err := scope.ProjectDAO().RotateTagCatalogEpoch(ctx); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("rollback: %#v %v", completion, err)
	}
	var count int
	var epoch string
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM task_tags WHERE project_id=$1)+(SELECT count(*) FROM project_tags WHERE project_id=$1),tag_catalog_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&count, &epoch); err != nil || count != 0 || epoch != initialEpoch {
		t.Fatalf("rollback readback: %d %s %v", count, epoch, err)
	}
	completion, err = s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "Before", NameKey: "before", CreatedAt: now}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		return scope.ProjectDAO().RotateTagCatalogEpoch(ctx)
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("commit: %#v %v", completion, err)
	}
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		original, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		epoch, err := scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if epoch == initialEpoch {
			t.Fatal("catalog epoch did not rotate")
		}
		completion, err := s.WriteProject(ctx, project.ID, func(write ProjectWriteScope) error {
			now, err := write.TaskDAO().ObservedAt(ctx)
			if err != nil {
				return err
			}
			if _, err := write.TagDAO().UpdateTag(ctx, tagID, original.Version, "After", "after", now); err != nil {
				return err
			}
			return write.ProjectDAO().RotateTagCatalogEpoch(ctx)
		})
		if err != nil || completion.Outcome != TransactionCommitted {
			t.Fatalf("concurrent commit: %#v %v", completion, err)
		}
		again, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		againEpoch, err := scope.TagDAO().TagCatalogEpoch(ctx, project.ID)
		if err != nil {
			return err
		}
		if again.Name != "Before" || againEpoch != epoch {
			t.Fatalf("snapshot changed: %#v %s", again, againEpoch)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.ReadSnapshot(ctx, func(scope SnapshotScope) error {
		item, err := scope.TagDAO().Tag(ctx, project.ID, tagID)
		if err != nil {
			return err
		}
		if item.Name != "After" || item.Version != 2 {
			t.Fatalf("committed value: %#v", item)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTagSnapshotQueryCancellation(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	ctx, finish := context.WithTimeout(context.Background(), 10*time.Second)
	defer finish()
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err := blocker.Exec(ctx, `LOCK TABLE project_tags IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	waiting, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	go func() {
		result <- s.ReadSnapshot(waiting, func(scope SnapshotScope) error {
			_, err := scope.TagDAO().Tags(waiting, project.ID, TagQuery{Limit: 10})
			return err
		})
	}()
	waitForQueryLock(t, s, "SELECT id::text, project_id::text, name, name_key")
	cancel()
	if err := receiveQueryResult(t, ctx, result); !errors.Is(err, context.Canceled) {
		t.Fatalf("query cancellation cause: %v", err)
	}
	if err := blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, s.Pool)
}

func TestTagDeleteAndAttachSerialize(t *testing.T) {
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tagID := queryID(21)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
		now, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		_, err = scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "tag", NameKey: "tag", CreatedAt: now})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
		go func() {
			result <- writeProjectForTest(s, ctx, project.ID, func(waiter ProjectWriteScope) error {
				items, err := waiter.TagDAO().ResolveTags(ctx, []string{tagID})
				if err != nil {
					return err
				}
				if len(items) != 0 {
					return errors.New("waiter observed deleted tag")
				}
				return nil
			})
		}()
		waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
		if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID}); err != nil {
			return err
		}
		if err := scope.TaskTagDAO().ClearTagAssociations(ctx, tagID); err != nil {
			return err
		}
		return scope.TagDAO().DeleteTag(ctx, tagID, 1)
	}); err != nil {
		t.Fatal(err)
	}
	if err := receiveQueryResult(t, ctx, result); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2`, project.ID, tagID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("remaining associations: %d %v", count, err)
	}
}
