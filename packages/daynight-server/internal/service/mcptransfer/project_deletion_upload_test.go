package mcptransfer

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

type lifecycleFenceWriter struct {
	store.PrivateTransferWriter
	gate *pauseOnce
}
type lifecycleFenceDAO struct {
	store.PrivateTransferDAO
	gate *pauseOnce
}

func (d lifecycleFenceDAO) LockProjectLifecycle(ctx context.Context, p, t string) error {
	if err := d.gate.wait(ctx); err != nil {
		return err
	}
	return d.PrivateTransferDAO.LockProjectLifecycle(ctx, p, t)
}
func (w lifecycleFenceWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.PrivateTransferWriter.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return fn(lifecycleFenceDAO{d, w.gate}) })
}

type finalFenceWriter struct {
	store.AttachmentMutationWriter
	calls atomic.Int32
	gate  *pauseOnce
}
type finalFenceScope struct {
	store.AttachmentMutationScope
	gate *pauseOnce
}

func (s finalFenceScope) LockTaskPresence(ctx context.Context, p, t string) (store.TaskPresence, error) {
	if err := s.gate.wait(ctx); err != nil {
		return store.TaskPresence{}, err
	}
	return s.AttachmentMutationScope.LockTaskPresence(ctx, p, t)
}
func (w *finalFenceWriter) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	return w.AttachmentMutationWriter.WriteAttachmentMutation(ctx, func(s store.AttachmentMutationScope) error {
		if w.calls.Add(1) == 2 {
			return fn(finalFenceScope{s, w.gate})
		}
		return fn(s)
	})
}

type pauseOnce struct {
	entered, release chan struct{}
	once             sync.Once
}

func newPause() *pauseOnce {
	return &pauseOnce{entered: make(chan struct{}), release: make(chan struct{})}
}
func (p *pauseOnce) wait(ctx context.Context) error {
	p.once.Do(func() { close(p.entered) })
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type measuredTransferStorage struct {
	*local.Storage
	writes atomic.Int32
	pause  atomic.Bool
	gate   *pauseOnce
}

func (s *measuredTransferStorage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, r io.Reader) (filestorage.FileInfo, error) {
	s.writes.Add(1)
	if s.pause.Load() {
		if err := s.gate.wait(ctx); err != nil {
			return filestorage.FileInfo{}, err
		}
	}
	return s.Storage.PutTransfer(ctx, n, id, r)
}

type heldProjectWriter struct {
	*postgres.Store
	gate *pauseOnce
}
type heldProjectScope struct {
	store.ProjectDeletionScope
	gate *pauseOnce
}
type heldProjectDAO struct {
	store.ProjectDeletionDAO
	gate *pauseOnce
}

func (d heldProjectDAO) MarkDeleted(ctx context.Context) (bool, error) {
	changed, err := d.ProjectDeletionDAO.MarkDeleted(ctx)
	if err != nil {
		return false, err
	}
	if err = d.gate.wait(ctx); err != nil {
		return false, err
	}
	return changed, nil
}
func (s heldProjectScope) ProjectDAO() store.ProjectDeletionDAO {
	return heldProjectDAO{s.ProjectDeletionScope.ProjectDAO(), s.gate}
}
func (w heldProjectWriter) WriteProjectDeletion(ctx context.Context, id string, fn func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return w.Store.WriteProjectDeletion(ctx, id, func(s store.ProjectDeletionScope) error { return fn(heldProjectScope{s, w.gate}) })
}

func transferBlocker(t *testing.T, ctx context.Context, f lifecycleFixture, query string) int32 {
	t.Helper()
	var pid int32
	err := f.db.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND state='idle in transaction' AND query LIKE $1 LIMIT 1),0)`, "%"+query+"%").Scan(&pid)
	if err != nil || pid == 0 {
		t.Fatalf("missing blocker %q: %d %v", query, pid, err)
	}
	return pid
}
func waitTransferBlocked(t *testing.T, ctx context.Context, f lifecycleFixture, query string, blocker int32) int32 {
	t.Helper()
	tick := time.NewTicker(5 * time.Millisecond)
	defer tick.Stop()
	for {
		var pid int32
		err := f.db.Pool.QueryRow(ctx, `SELECT COALESCE((SELECT pid FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE $1 AND $2=ANY(pg_blocking_pids(pid)) LIMIT 1),0)`, "%"+query+"%", blocker).Scan(&pid)
		if err != nil {
			t.Fatal(err)
		}
		if pid != 0 {
			return pid
		}
		select {
		case <-ctx.Done():
			t.Fatalf("no waiter for %q blocked by %d: %v", query, blocker, ctx.Err())
		case <-tick.C:
		}
	}
}

func deleteTransferProject(ctx context.Context, f lifecycleFixture, held *pauseOnce) error {
	var service *projectservice.Projects
	if held != nil {
		service = projectservice.NewProjects(heldProjectWriter{f.db, held})
	} else {
		service = projectservice.NewProjects(f.db)
	}
	receipt, err := service.Delete(ctx, f.actor.Principal, f.binding.ProjectID)
	if err != nil {
		return err
	}
	if !receipt.Deleted {
		return errors.New("missing deletion receipt")
	}
	return nil
}
func receiveTransferError(t *testing.T, ctx context.Context, ch <-chan error) error {
	t.Helper()
	select {
	case err := <-ch:
		return err
	case <-ctx.Done():
		t.Fatal(ctx.Err())
		return nil
	}
}

func TestProjectDeletionSerializesUploadChunk(t *testing.T) {
	for _, order := range []string{"delete-first", "chunk-first"} {
		t.Run(order, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			f, s, _ := uploadFixture(t)
			id := uuid.NewString()
			runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
			gate := newPause()
			var once sync.Once
			release := func() { once.Do(func() { close(gate.release) }) }
			defer release()
			measured := &measuredTransferStorage{Storage: f.files, gate: gate}
			s.files = measured
			if order == "delete-first" {
				f.lifecycle.db = lifecycleFenceWriter{PrivateTransferWriter: f.db, gate: gate}
			} else {
				measured.pause.Store(true)
			}
			result := make(chan error, 1)
			go func() {
				_, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("chunk"))})
				result <- err
			}()
			select {
			case <-gate.entered:
			case err := <-result:
				t.Fatalf("chunk did not reach fence: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			deleteGate := newPause()
			var deleteOnce sync.Once
			releaseDeletion := func() { deleteOnce.Do(func() { close(deleteGate.release) }) }
			defer releaseDeletion()
			deleted := make(chan error, 1)
			if order == "delete-first" {
				go func() { deleted <- deleteTransferProject(ctx, f, deleteGate) }()
			} else {
				go func() { deleted <- deleteTransferProject(ctx, f, nil) }()
			}
			if order == "delete-first" {
				select {
				case <-deleteGate.entered:
				case err := <-deleted:
					t.Fatalf("deletion did not mark project: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				blocker := transferBlocker(t, ctx, f, "UPDATE projects SET deleted_at=")
				release()
				waitTransferBlocked(t, ctx, f, "SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE", blocker)
				releaseDeletion()
				if err := receiveTransferError(t, ctx, deleted); err != nil {
					t.Fatal(err)
				}
				if err := receiveTransferError(t, ctx, result); err == nil {
					t.Fatal("chunk accepted after deletion")
				} else if fault, ok := operation.KnownFault(err); !ok || fault.Code != "not_found" {
					t.Fatalf("chunk refusal: %v", err)
				}
				if measured.writes.Load() != 0 {
					t.Fatal("deleted project wrote private object")
				}
			} else {
				blockerQuery := "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1"
				if order == "upload-first" {
					blockerQuery = "task_attachments"
				}
				blocker := transferBlocker(t, ctx, f, blockerQuery)
				waitTransferBlocked(t, ctx, f, "SELECT id FROM tasks WHERE project_id=$1 ORDER BY id FOR UPDATE", blocker)
				release()
				if err := receiveTransferError(t, ctx, result); err != nil {
					t.Fatal(err)
				}
				if err := receiveTransferError(t, ctx, deleted); err != nil {
					t.Fatal(err)
				}
				if measured.writes.Load() != 1 {
					t.Fatalf("chunk writes %d", measured.writes.Load())
				}
			}
		})
	}
}

func TestProjectDeletionSerializesUploadPublication(t *testing.T) {
	for _, order := range []string{"delete-first", "upload-first"} {
		t.Run(order, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			f, s, _ := uploadFixture(t)
			id := uuid.NewString()
			content := []byte("confirmed chunk")
			runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
			runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
			gate := newPause()
			var once sync.Once
			release := func() { once.Do(func() { close(gate.release) }) }
			defer release()
			measured := &measuredTransferStorage{Storage: f.files, gate: gate}
			var writer store.AttachmentMutationWriter = f.db
			if order == "delete-first" {
				writer = &finalFenceWriter{AttachmentMutationWriter: f.db, gate: gate}
			} else {
				measured.pause.Store(true)
			}
			s.attachments = attachmentservice.NewAttachments(f.db, writer, measured)
			result := make(chan error, 1)
			go func() {
				data, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: fmt.Sprint(len(content))})
				if err == nil && data["writeOutcome"] != "confirmed" {
					err = fmt.Errorf("invalid result: %v", data)
				}
				result <- err
			}()
			select {
			case <-gate.entered:
			case err := <-result:
				t.Fatalf("upload did not reach fence: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			deleteGate := newPause()
			var deleteOnce sync.Once
			releaseDeletion := func() { deleteOnce.Do(func() { close(deleteGate.release) }) }
			defer releaseDeletion()
			deleted := make(chan error, 1)
			if order == "delete-first" {
				go func() { deleted <- deleteTransferProject(ctx, f, deleteGate) }()
			} else {
				go func() { deleted <- deleteTransferProject(ctx, f, nil) }()
			}
			if order == "delete-first" {
				select {
				case <-deleteGate.entered:
				case err := <-deleted:
					t.Fatalf("deletion did not mark project: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				blocker := transferBlocker(t, ctx, f, "UPDATE projects SET deleted_at=")
				release()
				waitTransferBlocked(t, ctx, f, "SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE", blocker)
				releaseDeletion()
				if err := receiveTransferError(t, ctx, deleted); err != nil {
					t.Fatal(err)
				}
				if err := receiveTransferError(t, ctx, result); err == nil {
					t.Fatal("upload published after deletion")
				} else if fault, ok := operation.KnownFault(err); !ok || fault.Code != "not_found" {
					t.Fatalf("commit refusal: %v", err)
				}
				if measured.writes.Load() != 0 {
					t.Fatal("deleted project staged a private object")
				}
				var count int
				if err := f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE task_id=$1`, f.binding.TaskID).Scan(&count); err != nil || count != 0 {
					t.Fatalf("metadata changed: %d %v", count, err)
				}
			} else {
				blockerQuery := "SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1"
				if order == "upload-first" {
					blockerQuery = "task_attachments"
				}
				blocker := transferBlocker(t, ctx, f, blockerQuery)
				waitTransferBlocked(t, ctx, f, "SELECT id FROM tasks WHERE project_id=$1 ORDER BY id FOR UPDATE", blocker)
				status := make(chan error, 1)
				go func() {
					_, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "status", TransferID: id})
					status <- err
				}()
				// Concurrent status may queue behind deletion or complete under the existing Task share lock.
				release()
				if err := receiveTransferError(t, ctx, result); err != nil {
					t.Fatal(err)
				}
				if err := receiveTransferError(t, ctx, deleted); err != nil {
					t.Fatal(err)
				}
				_ = receiveTransferError(t, ctx, status)
				var path string
				if err := f.db.Pool.QueryRow(ctx, `SELECT path FROM task_attachments WHERE task_id=$1`, f.binding.TaskID).Scan(&path); err != nil || path != "file" {
					t.Fatalf("metadata missing: %s %v", path, err)
				}
				address, err := attachmentcore.NewAddress(f.binding.ProjectID, f.binding.TaskID, "file")
				if err != nil {
					t.Fatal(err)
				}
				file, err := f.files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
				if err != nil {
					t.Fatal(err)
				}
				got, err := io.ReadAll(file.Body)
				closeErr := file.Body.Close()
				if err != nil || closeErr != nil || strings.Compare(string(got), string(content)) != 0 {
					t.Fatalf("retained bytes: %q %v %v", got, err, closeErr)
				}
			}
		})
	}
}

func TestDeletedProjectDoesNotTreatDuplicateChunkAdmissionAsMissingReceipt(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f, s, _ := uploadFixture(t)
	id, chunkID := uuid.NewString(), uuid.NewString()
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
	input := UploadInput{Action: "chunk", TransferID: id, ChunkID: chunkID, Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("chunk"))}
	runUpload(t, s, f, f.actor, input)
	gate, deleteGate := newPause(), newPause()
	var once, deleteOnce sync.Once
	release := func() { once.Do(func() { close(gate.release) }) }
	releaseDeletion := func() { deleteOnce.Do(func() { close(deleteGate.release) }) }
	defer release()
	defer releaseDeletion()
	f.lifecycle.db = lifecycleFenceWriter{PrivateTransferWriter: f.db, gate: gate}
	result := make(chan error, 1)
	go func() { _, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, input); result <- err }()
	select {
	case <-gate.entered:
	case err := <-result:
		t.Fatalf("duplicate did not reach fence: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	deleted := make(chan error, 1)
	go func() { deleted <- deleteTransferProject(ctx, f, deleteGate) }()
	select {
	case <-deleteGate.entered:
	case err := <-deleted:
		t.Fatalf("deletion did not mark project: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	blocker := transferBlocker(t, ctx, f, "UPDATE projects SET deleted_at=")
	release()
	waitTransferBlocked(t, ctx, f, "SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE", blocker)
	releaseDeletion()
	if err := receiveTransferError(t, ctx, deleted); err != nil {
		t.Fatal(err)
	}
	err := receiveTransferError(t, ctx, result)
	fault, ok := operation.KnownFault(err)
	if !ok || fault.Code != "not_found" {
		t.Fatalf("duplicate after deletion: %v", err)
	}
}

type postPublicationWriter struct {
	store.AttachmentMutationWriter
	calls atomic.Int32
	gate  *pauseOnce
}

func (w *postPublicationWriter) WriteAttachmentMutation(ctx context.Context, fn func(store.AttachmentMutationScope) error) (store.Completion, error) {
	completion, err := w.AttachmentMutationWriter.WriteAttachmentMutation(ctx, fn)
	if w.calls.Add(1) == 2 && err == nil && completion.Outcome == store.TransactionCommitted {
		if gateErr := w.gate.wait(ctx); gateErr != nil {
			return completion, gateErr
		}
	}
	return completion, err
}

func TestDeletedProjectRetainsPublishedAttachmentWhilePrivateChunksAreReclaimed(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f, s, _ := uploadFixture(t)
	id, chunkID := uuid.NewString(), uuid.NewString()
	content := []byte("already published")
	runUpload(t, s, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
	runUpload(t, s, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: chunkID, Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
	var objectID string
	if err := f.db.Pool.QueryRow(ctx, `SELECT object_id::text FROM private_upload_chunks WHERE transfer_id=$1 AND chunk_id=$2`, id, chunkID).Scan(&objectID); err != nil {
		t.Fatal(err)
	}
	namespace, err := filestorage.NewTransferNamespace(id)
	if err != nil {
		t.Fatal(err)
	}
	gate := newPause()
	var once sync.Once
	release := func() { once.Do(func() { close(gate.release) }) }
	defer release()
	writer := &postPublicationWriter{AttachmentMutationWriter: f.db, gate: gate}
	s.attachments = attachmentservice.NewAttachments(f.db, writer, f.files)
	type result struct {
		data map[string]any
		err  error
	}
	finished := make(chan result, 1)
	go func() {
		data, err := s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: fmt.Sprint(len(content))})
		finished <- result{data, err}
	}()
	select {
	case <-gate.entered:
	case got := <-finished:
		t.Fatalf("commit did not reach confirmed publication: %v", got.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = deleteTransferProject(ctx, f, nil); err != nil {
		t.Fatal(err)
	}
	release()
	select {
	case got := <-finished:
		if got.err != nil || got.data["writeOutcome"] != "confirmed" {
			t.Fatalf("confirmed result lost after deletion: %+v %v", got.data, got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var state, outcome string
	if err = f.db.Pool.QueryRow(ctx, `SELECT state,data->>'writeOutcome' FROM private_transfers WHERE id=$1`, id).Scan(&state, &outcome); err != nil || state != "cleanup_pending" || outcome != "confirmed" {
		t.Fatalf("receipt state: %s %s %v", state, outcome, err)
	}
	object, err := f.files.OpenTransfer(ctx, namespace, objectID)
	if err != nil {
		t.Fatalf("private chunk missing before cleanup: %v", err)
	}
	_ = object.Body.Close()
	if err = f.lifecycle.Maintain(ctx); err != nil {
		t.Fatalf("private cleanup: %v", err)
	}
	if _, err = f.files.OpenTransfer(ctx, namespace, objectID); err == nil {
		t.Fatal("temporary chunk survived cleanup")
	}
	var reserved int64
	if err = f.db.Pool.QueryRow(ctx, `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, id).Scan(&state, &reserved); err != nil || state != "closed" || reserved != 0 {
		t.Fatalf("cleanup ledger: %s %d %v", state, reserved, err)
	}
	address, err := attachmentcore.NewAddress(f.binding.ProjectID, f.binding.TaskID, "file")
	if err != nil {
		t.Fatal(err)
	}
	object, err = f.files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	got, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(got) != string(content) {
		t.Fatalf("formal attachment changed: %q %v %v", got, readErr, closeErr)
	}
	var count int
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$2 AND path='file'`, f.binding.ProjectID, f.binding.TaskID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("formal metadata missing: %d %v", count, err)
	}
	_, err = s.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "status", TransferID: id})
	fault, ok := operation.KnownFault(err)
	if !ok || fault.Code != "not_found" {
		t.Fatalf("deleted Project became readable: %v", err)
	}
}
