package mcptransfer

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type deletionTransferStorage struct {
	filestorage.TransferStorage
	reads, writes atomic.Int32
}

func (s *deletionTransferStorage) OpenTransfer(ctx context.Context, namespace filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	s.reads.Add(1)
	return s.TransferStorage.OpenTransfer(ctx, namespace, id)
}

func (s *deletionTransferStorage) PutTransfer(ctx context.Context, namespace filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	s.writes.Add(1)
	return s.TransferStorage.PutTransfer(ctx, namespace, id, body)
}

func rejectDeletedProjectChunk(t *testing.T, accepted int64) {
	t.Helper()
	h := newUploadHarness(t)
	r := h.record("file", accepted)
	r.ReservedBytes = accepted
	h.lookup(h.actor, r, nil)
	lease := h.lease(h.actor, nil)
	current := h.permit(h.actor, r)
	h.expect(get(current))
	h.expect(get(current), method("LockProjectLifecycle", nil, model.ErrNotFound, r.ProjectID, r.TaskID))
	files := &deletionTransferStorage{TransferStorage: h.files}
	h.uploads.files = files
	result, err := h.execute(h.actor, UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("chunk"))})
	fault, known := operation.KnownFault(err)
	if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) || result != nil || files.reads.Load() != 0 || files.writes.Load() != 0 || lease.count() != 1 {
		t.Fatalf("deleted Project chunk: result=%+v error=%v reads=%d writes=%d lease closes=%d", result, err, files.reads.Load(), files.writes.Load(), lease.count())
	}
}

func TestUploadChunkRequiresLiveProjectBeforePrivateWrite(t *testing.T) {
	rejectDeletedProjectChunk(t, 0)
}

func TestUploadCommitRequiresLiveProjectBeforeReadingOrPublishing(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("file", int64(len("confirmed chunk")))
	h.lookup(h.actor, r, nil)
	lease := h.lease(h.actor, nil)
	current := h.permit(h.actor, r)
	h.expect(get(current))
	files := &deletionTransferStorage{TransferStorage: h.files}
	h.uploads.files = files
	admissions := 0
	h.uploads.admitTransfer = func(ctx context.Context, principal model.Principal, project, task, path, contentType string, namespace filestorage.TransferNamespace) (transferAdmission, error) {
		admissions++
		if admissions != 1 || ctx.Err() != nil || principal != h.actor.Principal || project != r.ProjectID || task != r.TaskID || path != "file" || contentType != "text/plain" || namespace.ID() != r.ID {
			t.Errorf("unexpected rejected admission: calls=%d principal=%+v address=%s/%s/%s type=%s namespace=%s context=%v", admissions, principal, project, task, path, contentType, namespace.ID(), ctx.Err())
		}
		return nil, &model.Fault{Code: "not_found", Message: "Project is unavailable."}
	}
	result, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: strconv.Itoa(len("confirmed chunk"))})
	fault, known := operation.KnownFault(err)
	if !known || fault.Code != "not_found" || result["writeOutcome"] != "not_committed" || result["attachment"] != nil || admissions != 1 || files.reads.Load() != 0 || files.writes.Load() != 0 || lease.count() != 1 {
		t.Fatalf("deleted Project publication: result=%+v error=%v admissions=%d reads=%d writes=%d lease closes=%d", result, err, admissions, files.reads.Load(), files.writes.Load(), lease.count())
	}
}

func TestDeletedProjectDoesNotTreatDuplicateChunkAdmissionAsMissingReceipt(t *testing.T) {
	rejectDeletedProjectChunk(t, int64(len("chunk")))
}

func TestDeletedProjectRetainsPublishedAttachmentWhilePrivateChunksAreReclaimed(t *testing.T) {
	h := newUploadHarness(t)
	content := []byte("already published")
	r := h.record("file", int64(len(content)))
	r.ReservedBytes = int64(len(content))
	chunks := h.seed(r, content)
	// The independently configured publication fact has already affected this target.
	h.target(r, content)
	item := uploadAttachment(r, int64(len(content)))
	plan, admission := h.commit(h.actor, r, chunks, content, item, true, nil, nil, nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	admission.effect = func(ctx context.Context, streamed []byte) {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
			t.Errorf("publication canceled before configured completion: %v", ctx.Err())
		}
	}
	type result struct {
		data map[string]any
		err  error
	}
	finished := make(chan result, 1)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	go func() {
		data, err := h.uploads.Execute(ctx, h.actor, r.ProjectID, r.TaskID, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: strconv.Itoa(len(content))})
		finished <- result{data, err}
	}()
	select {
	case <-entered:
	case got := <-finished:
		t.Fatalf("publication did not reach completion barrier: %+v %v", got.data, got.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	// Current access disappears while the admitted publication retains its receipt right.
	pending := plan.pending()
	closed := h.maintain(pending)
	h.lookup(h.actor, closed, model.ErrNotFound)
	unblock()
	select {
	case got := <-finished:
		attachment, ok := got.data["attachment"].(map[string]any)
		if got.err != nil || got.data["writeOutcome"] != "confirmed" || got.data["operationId"] != plan.operation || got.data["created"] != true || got.data["nextOffset"] != strconv.Itoa(len(content)) || got.data["totalBytes"] != strconv.Itoa(len(content)) || !ok || attachment["path"] != "file" || attachment["contentType"] != "text/plain" || attachment["sizeBytes"] != strconv.Itoa(len(content)) || attachment["createdAt"] != item.CreatedAt.UTC() || attachment["updatedAt"] != item.UpdatedAt.UTC() {
			t.Fatalf("confirmed result after deletion: %+v %v", got.data, got.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if admission.puts != 1 || admission.closes != 1 {
		t.Fatalf("publication calls=%d closes=%d", admission.puts, admission.closes)
	}
	namespace, err := filestorage.NewTransferNamespace(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	private, err := h.files.OpenTransfer(t.Context(), namespace, chunks[0].ObjectID)
	if err != nil {
		t.Fatalf("private chunk missing before cleanup: %v", err)
	}
	if err = private.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if err = h.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	if private, err = h.files.OpenTransfer(t.Context(), namespace, chunks[0].ObjectID); err == nil {
		_ = private.Body.Close()
		t.Fatal("private chunk survived namespace cleanup")
	}
	h.verifyTarget(r, content)
	_, err = h.execute(h.actor, UploadInput{Action: "status", TransferID: r.ID})
	fault, known := operation.KnownFault(err)
	if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted Project became readable: %v", err)
	}
}
