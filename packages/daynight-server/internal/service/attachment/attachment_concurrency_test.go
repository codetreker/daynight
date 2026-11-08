package attachment

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type pausedAttachmentReader struct {
	io.Reader
	ctx     context.Context
	reached chan struct{}
	release chan struct{}
	once    sync.Once
}

func (r *pausedAttachmentReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.reached) })
	select {
	case <-r.release:
		return r.Reader.Read(p)
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	}
}

func TestAdmittedAttachmentUploadDoesNotBlockGrantRevocation(t *testing.T) {
	for _, overwrite := range []bool{false, true} {
		t.Run(fmt.Sprintf("overwrite=%t", overwrite), func(t *testing.T) {
			attachments, _, database, files, task, owner := attachmentService(t)
			member := testsupport.ServicePrincipal(t, database)
			memberships := projectservice.NewMemberships(database)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			invitation, err := memberships.CreateInvitation(ctx, owner, task.ProjectID, owner.UserID)
			if err != nil {
				t.Fatal(err)
			}
			joined, err := memberships.AcceptInvitation(ctx, member, invitation.Secret, member.UserID)
			if err != nil || joined.Access.TeamRole != nil {
				t.Fatalf("direct-only project membership: %#v %v", joined, err)
			}
			var previous model.Attachment
			if overwrite {
				previous = putAttachment(t, attachments, member, task, "file", "before")
			}
			const prefix, suffix = "before revocation\x00", "after revocation\xff\n"
			reader := &pausedAttachmentReader{Reader: strings.NewReader(suffix), ctx: ctx, reached: make(chan struct{}), release: make(chan struct{})}
			type uploadResult struct {
				metadata model.Attachment
				created  bool
				err      error
			}
			result, finished := make(chan uploadResult, 1), make(chan struct{})
			var release sync.Once
			unblock := func() { release.Do(func() { close(reader.release) }) }
			go func() {
				defer close(finished)
				metadata, created, err := attachments.Put(ctx, member, task.ProjectID, task.ID, "file", "application/octet-stream", io.MultiReader(strings.NewReader(prefix), reader))
				result <- uploadResult{metadata: metadata, created: created, err: err}
			}()
			defer func() {
				cancel()
				unblock()
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Error("attachment upload did not finish after cancellation")
				}
			}()
			select {
			case <-reader.reached:
			case got := <-result:
				t.Fatalf("upload did not reach its streamed body: %v", got.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			// Reaching the suffix proves admission and file streaming have begun.
			// Revocation must finish while that admitted stream remains paused.
			revokeCtx, revokeCancel := context.WithTimeout(ctx, 5*time.Second)
			defer revokeCancel()
			_, err = memberships.RemoveGrant(revokeCtx, owner, task.ProjectID, member.UserID, coreproject.RemoveProjectMember{Version: joined.DirectGrant.Version, ExpectedUserID: owner.UserID})
			if err != nil {
				t.Fatalf("grant revocation waited for the admitted attachment stream: %v", err)
			}
			select {
			case got := <-result:
				t.Fatalf("upload finished before releasing its body: %v", got.err)
			default:
			}
			unblock()
			var uploaded uploadResult
			select {
			case uploaded = <-result:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if uploaded.err != nil || uploaded.created == overwrite {
				t.Fatalf("admitted upload: %#v", uploaded)
			}
			metadata, object, err := attachments.Open(ctx, owner, task.ProjectID, task.ID, "file")
			if err != nil {
				t.Fatal(err)
			}
			content, readErr := io.ReadAll(object.Body)
			closeErr := object.Body.Close()
			if readErr != nil || closeErr != nil || !bytes.Equal(content, []byte(prefix+suffix)) || !reflect.DeepEqual(metadata, uploaded.metadata) || metadata.SizeBytes != int64(len(content)) || metadata.ContentType != "application/octet-stream" {
				t.Fatalf("upload bytes/metadata changed across revocation: metadata=%#v uploaded=%#v content=%q read=%v close=%v", metadata, uploaded.metadata, content, readErr, closeErr)
			}
			if overwrite && !metadata.CreatedAt.Equal(previous.CreatedAt) {
				t.Fatalf("overwrite changed creation time: before=%v after=%v", previous.CreatedAt, metadata.CreatedAt)
			}
			observed := &observedAttachmentStorage{Storage: files}
			refused := newAttachmentService(database, observed)
			_, _, err = refused.Put(ctx, member, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("must not replace"))
			requireFault(t, err, "not_found")
			requireFault(t, refused.Delete(ctx, member, task.ProjectID, task.ID, "file"), "not_found")
			_, _, err = refused.Open(ctx, member, task.ProjectID, task.ID, "file")
			requireFault(t, err, "not_found")
			if observed.calls.Load() != 0 {
				t.Fatalf("revoked request reached file mutation: %d", observed.calls.Load())
			}
		})
	}
}

type observedAttachmentStorage struct {
	filestorage.Storage
	calls   atomic.Int32
	reached chan struct{}
	release chan struct{}
}

func (s *observedAttachmentStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	s.calls.Add(1)
	result, err := s.Storage.Put(ctx, bucket, path, body)
	if err == nil && s.reached != nil {
		close(s.reached)
		select {
		case <-s.release:
		case <-ctx.Done():
			return filestorage.FileInfo{}, ctx.Err()
		}
	}
	return result, err
}

func (s *observedAttachmentStorage) Delete(ctx context.Context, bucket, path string) error {
	s.calls.Add(1)
	err := s.Storage.Delete(ctx, bucket, path)
	if err == nil && s.reached != nil {
		close(s.reached)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return err
}

func attachmentMutation(ctx context.Context, attachments *Attachments, principal model.Principal, task model.Task, operation string) error {
	if operation == "delete" {
		return attachments.Delete(ctx, principal, task.ProjectID, task.ID, "file")
	}
	_, _, err := attachments.Put(ctx, principal, task.ProjectID, task.ID, "file", "text/plain", strings.NewReader("after"))
	return err
}

func waitAttachmentBlocked(t *testing.T, ctx context.Context, database *postgres.Store, blocker int32) int32 {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int32
		err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity
          WHERE application_name=current_schema() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, blocker).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatalf("no database waiter blocked by %d: %v", blocker, ctx.Err())
		}
	}
}

func attachmentWaitResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return nil
	}
}

func assertAttachmentState(t *testing.T, ctx context.Context, database *postgres.Store, files filestorage.Storage, task model.Task, exists bool, content string) {
	t.Helper()
	var size int64
	var contentType string
	err := database.Pool.QueryRow(ctx, `SELECT size_bytes,content_type FROM task_attachments WHERE project_id=$1 AND task_id=$2 AND path='file'`, task.ProjectID, task.ID).Scan(&size, &contentType)
	object, fileErr := files.Open(ctx, attachmentcore.Bucket, attachmentTestStoragePath(task, "file"))
	if !exists {
		if !errors.Is(err, pgx.ErrNoRows) || !errors.Is(fileErr, fs.ErrNotExist) {
			t.Fatalf("unexpected metadata/file: %v, %v", err, fileErr)
		}
		return
	}
	if err != nil || fileErr != nil {
		t.Fatalf("missing metadata/file: %v, %v", err, fileErr)
	}
	bytes, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	wantType := "text/plain"
	if content == "before" {
		wantType = "text/plain; charset=utf-8"
	}
	if readErr != nil || closeErr != nil || string(bytes) != content || size != int64(len(content)) || contentType != wantType {
		t.Fatalf("metadata/file mismatch: size=%d type=%q content=%q read=%v close=%v", size, contentType, bytes, readErr, closeErr)
	}
}

// The local gate deliberately shares 256 stripes across targets; see
// docs/design/daynight-task-attachments.md. This fixture tests database lock
// isolation, so unrelated writes must not wait for the paused storage stripe.
func independentAttachmentPath(t *testing.T, held, independent model.Task) string {
	t.Helper()
	heldAddress, err := attachmentcore.NewAddress(held.ProjectID, held.ID, "file")
	if err != nil {
		t.Fatal(err)
	}
	heldStripe := sha256.Sum256([]byte(heldAddress.StoragePath))[0]
	for index := range 4096 {
		path := fmt.Sprintf("independent-%d", index)
		address, err := attachmentcore.NewAddress(independent.ProjectID, independent.ID, path)
		if err != nil {
			t.Fatal(err)
		}
		if sha256.Sum256([]byte(address.StoragePath))[0] != heldStripe {
			return path
		}
	}
	t.Fatal("no independent attachment gate stripe found")
	return ""
}

func TestAttachmentMutationBlocksTaskDeletion(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		t.Run(operation, func(t *testing.T) {
			attachments, tasks, database, files, task, principal := attachmentService(t)
			if operation != "put" {
				putAttachment(t, attachments, principal, task, "file", "before")
			}
			other := createTask(t, tasks, principal, task.ProjectID, "Independent task")
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			otherProject, err := projectservice.NewProjects(database).Create(ctx, principal, coreproject.CreateProject{ExpectedUserID: principal.UserID, Name: "Independent project", RepoURL: "host:independent"})
			if err != nil {
				t.Fatal(err)
			}
			otherProjectTask := createTask(t, tasks, principal, otherProject.ID, "Independent project task")
			otherPath := independentAttachmentPath(t, task, other)
			otherProjectPath := independentAttachmentPath(t, task, otherProjectTask)
			observed := &observedAttachmentStorage{Storage: files, reached: make(chan struct{}), release: make(chan struct{})}
			mutation := make(chan error, 1)
			go func() {
				mutation <- attachmentMutation(ctx, newAttachmentService(database, observed), principal, task, operation)
			}()
			select {
			case <-observed.reached:
			case err := <-mutation:
				t.Fatalf("mutation did not reach file operation: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var blocker int32
			if err := database.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity
              WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE '%task_attachments%' LIMIT 1),0)`).Scan(&blocker); err != nil || blocker == 0 {
				t.Fatalf("mutation transaction not found: %d %v", blocker, err)
			}
			deletion := make(chan error, 1)
			go func() {
				deletion <- tasks.Delete(ctx, principal, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version})
			}()
			waitAttachmentBlocked(t, ctx, database, blocker)
			if _, _, err := attachments.Put(ctx, principal, other.ProjectID, other.ID, otherPath, "text/plain", strings.NewReader("ok")); err != nil {
				t.Fatalf("independent Task blocked or failed: %v", err)
			}
			if _, _, err := attachments.Put(ctx, principal, otherProjectTask.ProjectID, otherProjectTask.ID, otherProjectPath, "text/plain", strings.NewReader("ok")); err != nil {
				t.Fatalf("independent Project blocked or failed: %v", err)
			}
			close(observed.release)
			if err := attachmentWaitResult(t, ctx, mutation); err != nil {
				t.Fatalf("attachment mutation: %v", err)
			}
			if err := attachmentWaitResult(t, ctx, deletion); err != nil {
				t.Fatalf("Task deletion: %v", err)
			}
			assertAttachmentState(t, ctx, database, files, task, operation != "delete", "after")
		})
	}
}

func TestTaskDeletionOrdersAttachmentMutations(t *testing.T) {
	for _, operation := range []string{"put", "overwrite", "delete"} {
		for _, commits := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/commit=%t", operation, commits), func(t *testing.T) {
				attachments, tasks, database, files, task, principal := attachmentService(t)
				if operation != "put" {
					putAttachment(t, attachments, principal, task, "file", "before")
				}
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				var originalMetadata *string
				if err := database.Pool.QueryRow(ctx, `SELECT (SELECT to_jsonb(a)::text FROM task_attachments a WHERE task_id=$1 AND path='file')`, task.ID).Scan(&originalMetadata); err != nil {
					t.Fatal(err)
				}
				action := "RETURN NEW"
				if !commits {
					action = "RAISE EXCEPTION 'injected delete rollback'"
				}
				if _, err := database.Pool.Exec(ctx, `CREATE FUNCTION block_task_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(13629018); `+action+`; END $$;
                  CREATE TRIGGER block_task_delete BEFORE UPDATE OF deleted_at ON tasks FOR EACH ROW EXECUTE FUNCTION block_task_delete()`); err != nil {
					t.Fatal(err)
				}
				locker, err := database.Pool.Acquire(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer locker.Release()
				if _, err := locker.Exec(ctx, `SELECT pg_advisory_lock(13629018)`); err != nil {
					t.Fatal(err)
				}
				defer locker.Exec(context.Background(), `SELECT pg_advisory_unlock(13629018)`)
				deletion := make(chan error, 1)
				go func() {
					deletion <- tasks.Delete(ctx, principal, task.ProjectID, task.ID, taskcore.DeleteTask{Version: task.Version})
				}()
				deletingPID := waitAttachmentBlocked(t, ctx, database, int32(locker.Conn().PgConn().PID()))
				observed := &observedAttachmentStorage{Storage: files}
				mutation := make(chan error, 1)
				go func() {
					mutation <- attachmentMutation(ctx, newAttachmentService(database, observed), principal, task, operation)
				}()
				waitAttachmentBlocked(t, ctx, database, deletingPID)
				if observed.calls.Load() != 0 {
					t.Fatal("file operation ran before deletion completed")
				}
				if _, err := locker.Exec(ctx, `SELECT pg_advisory_unlock(13629018)`); err != nil {
					t.Fatal(err)
				}
				deleteErr := attachmentWaitResult(t, ctx, deletion)
				mutationErr := attachmentWaitResult(t, ctx, mutation)
				if commits {
					if deleteErr != nil {
						t.Fatalf("Task deletion: %v", deleteErr)
					}
					requireFault(t, mutationErr, "task_deleted")
					if observed.calls.Load() != 0 {
						t.Fatal("deleted Task changed physical content")
					}
					assertAttachmentState(t, ctx, database, files, task, operation != "put", "before")
					var metadata *string
					if err := database.Pool.QueryRow(ctx, `SELECT (SELECT to_jsonb(a)::text FROM task_attachments a WHERE task_id=$1 AND path='file')`, task.ID).Scan(&metadata); err != nil {
						t.Fatal(err)
					}
					if (metadata == nil) != (originalMetadata == nil) || metadata != nil && *metadata != *originalMetadata {
						t.Fatalf("metadata changed: before=%v after=%v", originalMetadata, metadata)
					}
				} else {
					var databaseError *pgconn.PgError
					if !errors.As(deleteErr, &databaseError) || databaseError.Message != "injected delete rollback" {
						t.Fatalf("missing injected rollback: %v", deleteErr)
					}
					if mutationErr != nil || observed.calls.Load() != 1 {
						t.Fatalf("mutation after rollback: %v calls=%d", mutationErr, observed.calls.Load())
					}
					assertAttachmentState(t, ctx, database, files, task, operation != "delete", "after")
				}
			})
		}
	}
}
