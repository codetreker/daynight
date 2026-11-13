package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	tasktext "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/text"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
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

func TestTaskTagAdmissionRollbackAndRenameReadback(t *testing.T) {
	s, principal, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	item := queryTask(t, s, project.ID, 11, model.TaskTodo)
	tasks := taskservice.NewTasks(s)
	description := strings.Repeat("&", tasktext.MaxDescriptionBytes)
	current, err := tasks.Update(ctx, principal, project.ID, item.ID, taskcore.UpdateTask{Version: item.Version, Description: &description})
	if err != nil {
		t.Fatalf("legal description update: %v", err)
	}
	mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at)
		SELECT gen_random_uuid(),$1,format('tag-%s',n),format('tag-%s',n),statement_timestamp(),statement_timestamp() FROM generate_series(1,400) n`, project.ID)
	rows, err := s.Pool.Query(ctx, `SELECT id::text,name FROM project_tags WHERE project_id=$1 ORDER BY id`, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	var refs []model.TagReference
	for rows.Next() {
		var ref model.TagReference
		if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		ids = append(ids, ref.ID)
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	reserved := current
	reserved.Version = math.MaxInt64
	reserved.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	reserved.Tags = []model.TagReference{{ID: ids[0], Name: strings.Repeat("&", 64)}}
	first, err := taskprotocol.EncodeREST(io.Discard, reserved, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	reserved.Tags = append(reserved.Tags, model.TagReference{ID: ids[1], Name: strings.Repeat("&", 64)})
	second, err := taskprotocol.EncodeREST(io.Discard, reserved, true, taskcore.MaxTaskResponseJSONBytes)
	if err != nil {
		t.Fatal(err)
	}
	safeCount := 1 + int((taskcore.MaxTaskResponseJSONBytes-first)/(second-first))
	if safeCount < 1 || safeCount >= len(ids) {
		t.Fatalf("fixture does not span admission boundary: %d of %d", safeCount, len(ids))
	}
	safeIDs := ids[:safeCount]
	tooMany := ids[:safeCount+1]
	var epoch string
	if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	attached, err := tasks.ReplaceTags(ctx, principal, project.ID, item.ID, current.Version, &safeIDs)
	if err != nil || attached.Version != current.Version+1 || !reflect.DeepEqual(attached.Tags, refs[:safeCount]) {
		t.Fatalf("attach receipt: count=%d, error=%v", len(attached.Tags), err)
	}
	before := snapshotTask(t, s, project.ID, item.ID)
	_, err = tasks.ReplaceTags(ctx, principal, project.ID, item.ID, before.Version, &tooMany)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("oversize association: %v", err)
	}
	after := snapshotTask(t, s, project.ID, item.ID)
	if !reflect.DeepEqual(after, before) {
		t.Fatal("failed admission changed the task or its references")
	}
	var count int
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM task_tags WHERE project_id=$1 AND task_id=$2`, project.ID, item.ID).Scan(&count); err != nil || count != safeCount {
		t.Fatalf("failed admission persisted association: %d %v", count, err)
	}
	name := strings.Repeat("&", 64)
	if _, err := tagservice.New(s).Rename(ctx, principal, project.ID, ids[0], 1, name); err != nil {
		t.Fatalf("rename: %v", err)
	}
	read := snapshotTask(t, s, project.ID, item.ID)
	want := append([]model.TagReference(nil), refs[:safeCount]...)
	want[0].Name = name
	if read.Version != attached.Version+1 || !reflect.DeepEqual(read.Tags, want) {
		t.Fatalf("renamed readback: count=%d version=%d", len(read.Tags), read.Version)
	}
	var afterEpoch string
	if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil || afterEpoch != epoch {
		t.Fatalf("tag operations changed task cache epoch: %s to %s, %v", epoch, afterEpoch, err)
	}
	for _, extended := range []bool{false, true} {
		if _, err := taskprotocol.EncodeREST(io.Discard, read, extended, taskcore.MaxTaskResponseJSONBytes); err != nil {
			t.Fatalf("renamed task response extended=%v: %v", extended, err)
		}
	}
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

func TestTaskTagWriteRemainsVisibleToSyncAcrossLockAndCommit(t *testing.T) {
	for _, waiting := range []bool{false, true} {
		t.Run(fmt.Sprintf("waitingForProjectLock=%t", waiting), func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			project := queryProject(t, s, 1)
			item := queryTask(t, s, project.ID, 11, model.TaskTodo)
			tagID := queryID(21)
			mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'name','name',statement_timestamp(),statement_timestamp())`, tagID, project.ID)

			readSync := func(lower *time.Time) ([]model.TaskViewRecord, string, error) {
				var rows []model.TaskViewRecord
				var epoch string
				err := s.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
					var err error
					epoch, err = snapshot.TaskDAO().TaskCacheEpoch(ctx, project.ID)
					if err != nil {
						return err
					}
					rows, err = snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, lower, 160)
					return err
				})
				return rows, epoch, err
			}
			var observed, releaseTime, watermark time.Time
			var epoch string
			attach := func(scope ProjectWriteScope) error {
				if _, err := scope.TaskDAO().Task(ctx, item.ID); err != nil {
					return err
				}
				tags, err := scope.TagDAO().ResolveTags(ctx, []string{tagID})
				if err != nil || len(tags) != 1 {
					return fmt.Errorf("resolve tag: %v (%d results)", err, len(tags))
				}
				observed, err = scope.TaskDAO().ObservedAt(ctx)
				if err != nil {
					return err
				}
				if err := scope.TaskTagDAO().ReplaceTaskTags(ctx, item.ID, []string{tagID}); err != nil {
					return err
				}
				return scope.TaskDAO().TouchTask(ctx, item.ID, observed)
			}
			readBeforeCommit := func() error {
				rows, currentEpoch, err := readSync(nil)
				if err != nil {
					return err
				}
				if len(rows) != 1 || rows[0].ID != item.ID || rows[0].Version != item.Version {
					return fmt.Errorf("uncommitted write leaked into sync: %#v", rows)
				}
				watermark, epoch = rows[0].UpdatedAt, currentEpoch
				return nil
			}
			if waiting {
				finished := make(chan error, 1)
				err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
					go func() { finished <- writeProjectForTest(s, ctx, project.ID, attach) }()
					waitForQueryLock(t, s, "SELECT id::text FROM projects WHERE")
					if err := readBeforeCommit(); err != nil {
						return err
					}
					return s.Pool.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&releaseTime)
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := receiveQueryResult(t, ctx, finished); err != nil {
					t.Fatal(err)
				}
				if observed.Before(releaseTime) {
					t.Fatalf("timestamp was taken before the project lock: observed=%v release=%v", observed, releaseTime)
				}
			} else if err := writeProjectForTest(s, ctx, project.ID, func(scope ProjectWriteScope) error {
				if err := attach(scope); err != nil {
					return err
				}
				return readBeforeCommit()
			}); err != nil {
				t.Fatal(err)
			}
			rows, afterEpoch, err := readSync(&watermark)
			if err != nil || afterEpoch != epoch || len(rows) != 1 || rows[0].ID != item.ID || rows[0].Version != item.Version+1 || !rows[0].UpdatedAt.Equal(observed) || rows[0].UpdatedAt.Before(watermark) {
				t.Fatalf("sync missed committed tag change: rows=%#v epoch=%s/%s watermark=%v observed=%v err=%v", rows, epoch, afterEpoch, watermark, observed, err)
			}
		})
	}
}
