package mcptransfer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strconv"
	"sync/atomic"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

type countedUploadStorage struct {
	filestorage.TransferStorage
	puts, opens atomic.Int32
}

type uploadGateCloseError struct {
	filestorage.Storage
	cause error
}

type uploadCloseError struct {
	io.Closer
	cause error
}

func (c uploadCloseError) Close() error { return errors.Join(c.Closer.Close(), c.cause) }

func (s uploadGateCloseError) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	gate, err := s.Storage.AcquireGate(ctx, domain, key)
	if err != nil || domain != filestorage.PrivateGate {
		return gate, err
	}
	return uploadCloseError{Closer: gate, cause: s.cause}, nil
}

type uploadTransitionError struct {
	store.PrivateTransferWriter
	state string
	cause error
}

type uploadTransitionErrorDAO struct {
	store.PrivateTransferDAO
	state string
	cause error
}

func (d uploadTransitionErrorDAO) Put(ctx context.Context, record model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	if record.State == d.state {
		return model.PrivateTransfer{}, d.cause
	}
	return d.PrivateTransferDAO.Put(ctx, record, version)
}

func (w uploadTransitionError) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.PrivateTransferWriter.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		return fn(uploadTransitionErrorDAO{PrivateTransferDAO: d, state: w.state, cause: w.cause})
	})
}

func (s *countedUploadStorage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	s.puts.Add(1)
	return s.TransferStorage.PutTransfer(ctx, n, id, body)
}

func (s *countedUploadStorage) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	s.opens.Add(1)
	return s.TransferStorage.OpenTransfer(ctx, n, id)
}

func TestUploadCompleteFileLimitAndReplay(t *testing.T) {
	f, uploads, attachments := uploadFixture(t)
	counted := &countedUploadStorage{TransferStorage: f.files}
	uploads.files = counted
	id := uuid.NewString()
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "bounded", ContentType: "application/octet-stream"})
	chunk := bytes.Repeat([]byte("x"), MaxChunkBytes)
	encoded := base64.StdEncoding.EncodeToString(chunk)
	var last UploadInput
	for offset := int64(0); offset < attachmentcore.MaxFileBytes; offset += MaxChunkBytes {
		last = UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: strconv.FormatInt(offset, 10), ContentBase64: encoded}
		result := runUpload(t, uploads, f, f.actor, last)
		if result["nextOffset"] != strconv.FormatInt(offset+MaxChunkBytes, 10) {
			t.Fatalf("chunk offset: %+v", result)
		}
	}
	if result := runUpload(t, uploads, f, f.actor, last); result["receipt"] != "already_accepted" {
		t.Fatalf("replay at limit: %+v", result)
	}
	puts := counted.puts.Load()
	tooLarge := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: strconv.FormatInt(attachmentcore.MaxFileBytes, 10), ContentBase64: "eA=="}
	result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, tooLarge)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" || result["writeOutcome"] != "not_committed" || counted.puts.Load() != puts {
		t.Fatalf("oversized chunk: result=%+v err=%v writes=%d", result, err, counted.puts.Load()-puts)
	}
	result, err = uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.FormatInt(attachmentcore.MaxFileBytes+1, 10)})
	fault = nil
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" || result["writeOutcome"] != "not_committed" || counted.opens.Load() != 0 {
		t.Fatalf("oversized commit: result=%+v err=%v reads=%d", result, err, counted.opens.Load())
	}
	status := runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["nextOffset"] != strconv.FormatInt(attachmentcore.MaxFileBytes, 10) || status["state"] != "receiving" {
		t.Fatalf("rejected operations changed transfer: %+v", status)
	}
	result = runUpload(t, uploads, f, f.actor, UploadInput{Action: "commit", TransferID: id, TotalBytes: strconv.FormatInt(attachmentcore.MaxFileBytes, 10)})
	if result["writeOutcome"] != "confirmed" {
		t.Fatalf("commit: %+v", result)
	}
	item, object, err := attachments.Open(t.Context(), f.actor.Principal, f.binding.ProjectID, f.binding.TaskID, "bounded")
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(object.Body)
	err = errors.Join(err, object.Body.Close())
	if err != nil || item.SizeBytes != attachmentcore.MaxFileBytes || !bytes.Equal(content, bytes.Repeat(chunk, 10)) {
		t.Fatalf("published content: size=%d bytes=%d error=%v", item.SizeBytes, len(content), err)
	}
}

func TestUploadLeaseRetainedUntilResponseCompletes(t *testing.T) {
	f, uploads, _ := uploadFixture(t)
	id := uuid.NewString()
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "bounded", ContentType: "text/plain"})
	var held io.Closer
	ctx := attachmentservice.WithUploadLeaseRetainer(t.Context(), func(lease io.Closer) { held = lease })
	first := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
	if _, err := uploads.Execute(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID, first); err != nil || held == nil {
		t.Fatalf("first chunk: lease=%v error=%v", held, err)
	}
	t.Cleanup(func() { _ = held.Close() })
	second := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "1", ContentBase64: "Yg=="}
	result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, second)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_busy" || result["writeOutcome"] != "not_committed" {
		t.Fatalf("active response did not retain slot: %+v %v", result, err)
	}
	if status := runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id}); status["nextOffset"] != "1" {
		t.Fatalf("control operation or offset: %+v", status)
	}
	if err := held.Close(); err != nil {
		t.Fatal(err)
	}
	result = runUpload(t, uploads, f, f.actor, second)
	if result["nextOffset"] != "2" {
		t.Fatalf("slot was not released: %+v", result)
	}
}

func TestUploadCleanupFailuresPreserveResultsAndCauses(t *testing.T) {
	t.Run("private gate close", func(t *testing.T) {
		f, uploads, _ := uploadFixture(t)
		id := uuid.NewString()
		runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
		cause := errors.New("private gate close failed")
		f.lifecycle.files = uploadGateCloseError{Storage: f.files, cause: cause}
		result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="})
		if !errors.Is(err, cause) || result["receipt"] != "accepted" || result["nextOffset"] != "1" {
			t.Fatalf("chunk receipt or close cause lost: %+v %v", result, err)
		}
	})
	for _, state := range []string{"committed", "cleanup_pending"} {
		t.Run(state, func(t *testing.T) {
			f, uploads, attachments := uploadFixture(t)
			id := uuid.NewString()
			runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
			runUpload(t, uploads, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="})
			cause := errors.New("transfer completion failed")
			f.lifecycle.db = uploadTransitionError{PrivateTransferWriter: f.lifecycle.db, state: state, cause: cause}
			result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "1"})
			if !errors.Is(err, cause) || result["writeOutcome"] != "confirmed" || result["attachment"] == nil {
				t.Fatalf("publication facts or cause lost: %+v %v", result, err)
			}
			verifyUploadBytes(t, attachments, f, "file", []byte("a"))
		})
	}
	t.Run("failed receipt", func(t *testing.T) {
		f, uploads, _ := uploadFixture(t)
		id := uuid.NewString()
		runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
		runUpload(t, uploads, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="})
		stageCause, finishCause := errors.New("stage failed"), errors.New("failed receipt could not be saved")
		files := &uploadStageFailure{Storage: f.files, TransferStorage: f.files, TransferAttachmentPublisher: f.files, cause: stageCause}
		uploads.attachments = attachmentservice.NewAttachments(f.db, f.db, files)
		f.lifecycle.db = uploadTransitionError{PrivateTransferWriter: f.lifecycle.db, state: "failed", cause: finishCause}
		result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "1"})
		if !errors.Is(err, stageCause) || !errors.Is(err, finishCause) || result["writeOutcome"] != "not_committed" {
			t.Fatalf("failure facts or causes lost: %+v %v", result, err)
		}
	})
}
