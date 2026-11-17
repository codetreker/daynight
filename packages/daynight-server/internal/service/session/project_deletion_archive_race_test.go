package session

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
)

type heldDeletion struct {
	*postgres.Store
	entered, release chan struct{}
}

func (d *heldDeletion) WriteProjectDeletion(ctx context.Context, id string, work func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return d.Store.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
		close(d.entered)
		select {
		case <-d.release:
			return work(scope)
		case <-ctx.Done():
			return ctx.Err()
		}
	})
}

func waitArchiveLock(ctx context.Context, db *postgres.Store, query string) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var count int
		err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1`, "%"+query+"%").Scan(&count)
		if err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func TestProjectDeletionSerializesWithWebArchives(t *testing.T) {
	for _, order := range []string{"archive-first", "delete-first"} {
		t.Run(order, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
			defer cancel()
			f := newServiceFixture(t)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			uploadGate := &serviceStorageBarrier{Storage: files, kind: "upload", manifestOnly: true, entered: make(chan struct{}), release: make(chan struct{})}
			var once sync.Once
			releaseUpload := func() { once.Do(func() { close(uploadGate.release) }) }
			t.Cleanup(releaseUpload)
			engine := core.NewEngine(uploadGate)
			defer engine.Stop(context.Background())
			f.service = New(f.db, engine)
			v := f.registerWeb(t)
			id := v.SessionID
			if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
				t.Fatal(err)
			}
			data := prepareServiceArchive(t, ctx, f.service, f.owner, f.project, f.task, v)
			if _, err = f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
				t.Fatal(err)
			}
			if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task); err != nil {
				t.Fatal(err)
			}
			deletionGate := &heldDeletion{Store: f.db, entered: make(chan struct{}), release: make(chan struct{})}
			var dOnce sync.Once
			releaseDelete := func() { dOnce.Do(func() { close(deletionGate.release) }) }
			t.Cleanup(releaseDelete)
			deletions := projectservice.NewProjects(deletionGate, engine)
			archive := make(chan error, 1)
			deletion := make(chan error, 1)
			upload := func() { archive <- publishServiceArchive(ctx, f.service, f.owner, f.project, f.task, id, data) }
			remove := func() {
				receipt, err := deletions.Delete(ctx, f.owner, f.project)
				if err == nil && (!receipt.Deleted || receipt.ProjectID != f.project) {
					err = fmt.Errorf("invalid receipt %+v", receipt)
				}
				deletion <- err
			}
			if order == "archive-first" {
				go upload()
				awaitBarrier(t, ctx, uploadGate, archive)
				go remove()
				// Publication performs volume I/O without holding the Task row.
				// Deletion can commit first; the late manifest must not become ready.
				select {
				case <-deletionGate.entered:
				case err = <-deletion:
					t.Fatalf("deletion did not acquire locks: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				releaseDelete()
				if err = <-deletion; err != nil {
					t.Fatal(err)
				}
				releaseUpload()
				requireServiceError(t, <-archive, "not_found")
				var ready int
				if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archives WHERE session_id=$1 AND state='ready'`, id).Scan(&ready); err != nil || ready != 0 {
					t.Fatalf("late archive became ready: %d %v", ready, err)
				}
			} else {
				go remove()
				select {
				case <-deletionGate.entered:
				case err = <-deletion:
					t.Fatalf("deletion did not acquire locks: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				go upload()
				if err = waitArchiveLock(ctx, f.db, "SELECT id::text FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE"); err != nil {
					t.Fatal(err)
				}
				releaseDelete()
				if err = <-deletion; err != nil {
					t.Fatal(err)
				}
				requireServiceError(t, <-archive, "not_found")
				select {
				case <-uploadGate.entered:
					t.Fatal("deleted project changed archive file")
				default:
				}
			}
			upload()
			requireServiceError(t, <-archive, "not_found")
			if ctx.Err() != nil {
				t.Fatal(ctx.Err())
			}
		})
	}
}
