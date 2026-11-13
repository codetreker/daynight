package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

func tagWitnessDelete(ctx context.Context, scope ProjectWriteScope, id string) error {
	now, err := scope.TaskDAO().ObservedAt(ctx)
	if err != nil {
		return err
	}
	if _, err = scope.TaskTagDAO().TouchTaggedTasks(ctx, id, now); err != nil {
		return err
	}
	if err = scope.TaskTagDAO().ClearTagAssociations(ctx, id); err != nil {
		return err
	}
	if err = scope.TagDAO().DeleteTag(ctx, id, 1); err != nil {
		return err
	}
	return scope.ProjectDAO().RotateTagCatalogEpoch(ctx)
}

// Both operations validate after acquiring the Project lock. A deleted tag must
// not be attached, while an attachment committed first is cleared by deletion.
func TestTagDeletionSerializesWithAttachAndCreate(t *testing.T) {
	for _, create := range []bool{false, true} {
		for _, deleteFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("create=%t/deleteFirst=%t", create, deleteFirst), func(t *testing.T) {
				s := isolatedStore(t)
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				project := queryProject(t, s, 1)
				taskID, tagID := queryID(11), queryID(21)
				if !create {
					queryTask(t, s, project.ID, 11, model.TaskTodo)
				}
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
				missing := errors.New("tag no longer exists")
				attach := func(scope ProjectWriteScope) error {
					tags, err := scope.TagDAO().ResolveTags(ctx, []string{tagID})
					if err != nil {
						return err
					}
					if len(tags) != 1 {
						return missing
					}
					if create {
						if _, err := scope.TaskDAO().CreateTask(ctx, taskID, TaskWrite{Title: "created", Status: model.TaskTodo}); err != nil {
							return err
						}
					}
					return scope.TaskTagDAO().ReplaceTaskTags(ctx, taskID, []string{tagID})
				}
				remove := func(scope ProjectWriteScope) error { return tagWitnessDelete(ctx, scope, tagID) }
				first, second := attach, remove
				if deleteFirst {
					first, second = remove, attach
				}
				result := make(chan error, 1)
				err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
					if err := first(scope); err != nil {
						return err
					}
					go func() { result <- writeProjectForTest(s, ctx, project.ID, second) }()
					waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				err = receiveQueryResult(t, ctx, result)
				if deleteFirst && !errors.Is(err, missing) || !deleteFirst && err != nil {
					t.Fatalf("waiting operation: %v", err)
				}
				var tags, associations, tasks int
				if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_tags WHERE project_id=$1 AND id=$2), (SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2), (SELECT count(*) FROM tasks WHERE project_id=$1 AND id=$3)`, project.ID, tagID, taskID).Scan(&tags, &associations, &tasks); err != nil {
					t.Fatal(err)
				}
				wantTasks := 1
				if create && deleteFirst {
					wantTasks = 0
				}
				if tags != 0 || associations != 0 || tasks != wantTasks {
					t.Fatalf("persisted tag/association/task = %d/%d/%d, want 0/0/%d", tags, associations, tasks, wantTasks)
				}
				if tasks == 1 {
					var status string
					var version int64
					if err := s.Pool.QueryRow(ctx, `SELECT status,version FROM tasks WHERE id=$1`, taskID).Scan(&status, &version); err != nil {
						t.Fatal(err)
					}
					if status != "todo" || !deleteFirst && version != 2 || deleteFirst && version != 1 {
						t.Fatalf("task status/version: %s/%d", status, version)
					}
				}
			})
		}
	}
}

func TestTagDeleteRollbackAndLostCommitReceipt(t *testing.T) {
	for _, lostReceipt := range []bool{false, true} {
		t.Run(fmt.Sprintf("lostReceipt=%t", lostReceipt), func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			project := queryProject(t, s, 1)
			task := queryTask(t, s, project.ID, 11, model.TaskTodo)
			tagID := queryID(21)
			if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
				now, err := scope.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if _, err = scope.TagDAO().InsertTag(ctx, model.Tag{ID: tagID, Name: "tag", NameKey: "tag", CreatedAt: now}); err != nil {
					return err
				}
				return scope.TaskTagDAO().ReplaceTaskTags(ctx, task.ID, []string{tagID})
			}); err != nil {
				t.Fatal(err)
			}
			var originalEpoch string
			if err := s.Pool.QueryRow(ctx, `SELECT tag_catalog_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&originalEpoch); err != nil {
				t.Fatal(err)
			}
			fault := errors.New("delete transaction fault")
			if !lostReceipt {
				completion, err := s.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
					if err := tagWitnessDelete(ctx, scope, tagID); err != nil {
						return err
					}
					return fault
				})
				if completion.Outcome != TransactionNotCommitted || !errors.Is(err, fault) {
					t.Fatalf("rollback: %+v %v", completion, err)
				}
			} else {
				tx, err := s.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				err = transact(ctx, &threadCommitResponseLoss{Tx: tx, cause: fault}, func(raw pgx.Tx) error {
					var id string
					if err := raw.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, project.ID).Scan(&id); err != nil {
						return err
					}
					return tagWitnessDelete(ctx, &ProjectTx{tx: raw, projectID: project.ID}, tagID)
				})
				completion, err := teamCompletion("project write", err)
				var failure *TransactionError
				if completion.Outcome != TransactionUnknown || !errors.As(err, &failure) || !failure.CommitAttempted || !errors.Is(err, fault) {
					t.Fatalf("lost receipt: %+v %#v %v", completion, failure, err)
				}
			}
			var tags, associations int
			var version int64
			var epoch string
			if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_tags WHERE project_id=$1 AND id=$2), (SELECT count(*) FROM task_tags WHERE project_id=$1 AND tag_id=$2), (SELECT version FROM tasks WHERE id=$3), (SELECT tag_catalog_epoch::text FROM projects WHERE id=$1)`, project.ID, tagID, task.ID).Scan(&tags, &associations, &version, &epoch); err != nil {
				t.Fatal(err)
			}
			if lostReceipt && (tags != 0 || associations != 0 || version != task.Version+1 || epoch == originalEpoch) || !lostReceipt && (tags != 1 || associations != 1 || version != task.Version || epoch != originalEpoch) {
				t.Fatalf("readback tag/association/version/epoch = %d/%d/%d/%s", tags, associations, version, epoch)
			}
		})
	}
}
