package mcptransfer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"sync/atomic"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

func (s *countedUploadStorage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	s.puts.Add(1)
	return s.TransferStorage.PutTransfer(ctx, n, id, body)
}

func (s *countedUploadStorage) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	s.opens.Add(1)
	return s.TransferStorage.OpenTransfer(ctx, n, id)
}

func TestUploadCompleteFileLimitAndReplay(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("bounded", 0)
	counted := &countedUploadStorage{TransferStorage: h.files}
	h.uploads.files = counted
	chunk := bytes.Repeat([]byte("x"), MaxChunkBytes)
	encoded := base64.StdEncoding.EncodeToString(chunk)
	var last UploadInput
	chunks := make([]model.UploadChunk, 0, 10)
	for offset := int64(0); offset < attachmentcore.MaxFileBytes; offset += MaxChunkBytes {
		last = UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: decimal(offset), ContentBase64: encoded}
		next, c := h.planChunk(h.actor, r, last, chunk)
		result := h.run(h.actor, last)
		if result["nextOffset"] != decimal(offset+MaxChunkBytes) {
			t.Fatalf("offset %+v", result)
		}
		r = next
		chunks = append(chunks, *c)
	}
	r = h.replay(h.actor, r, last, chunks[len(chunks)-1])
	if result := h.run(h.actor, last); result["receipt"] != "already_accepted" {
		t.Fatalf("limit replay %+v", result)
	}
	puts := counted.puts.Load()
	extra := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: decimal(attachmentcore.MaxFileBytes), ContentBase64: "eA=="}
	current := h.prepare(h.actor, r)
	h.missingReceipt(current, extra.ChunkID)
	r = current
	result, err := h.execute(h.actor, extra)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" || result["writeOutcome"] != "not_committed" || counted.puts.Load() != puts {
		t.Fatalf("extra chunk %+v %v writes=%d", result, err, counted.puts.Load()-puts)
	}
	r = h.prepare(h.actor, r)
	result, err = h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(attachmentcore.MaxFileBytes + 1)})
	fault = nil
	if !errors.As(err, &fault) || fault.Code != "payload_too_large" || result["writeOutcome"] != "not_committed" || counted.opens.Load() != 0 {
		t.Fatalf("extra commit %+v %v reads=%d", result, err, counted.opens.Load())
	}
	if status := h.status(h.actor, r); status["nextOffset"] != decimal(attachmentcore.MaxFileBytes) || status["state"] != "receiving" {
		t.Fatalf("limit status %+v", status)
	}
	content := bytes.Repeat(chunk, 10)
	_, a := h.commit(h.actor, r, chunks, content, uploadAttachment(r, attachmentcore.MaxFileBytes), true, nil, nil, nil)
	a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
	result = h.run(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: decimal(attachmentcore.MaxFileBytes)})
	if result["writeOutcome"] != "confirmed" || a.item.SizeBytes != attachmentcore.MaxFileBytes {
		t.Fatalf("limit commit %+v", result)
	}
	h.verifyTarget(r, content)
}
func TestUploadLeaseRetainedUntilResponseCompletes(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("bounded", 0)
	first := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
	next, _ := h.planChunk(h.actor, r, first, []byte("a"))
	var held io.Closer
	ctx := attachmentservice.WithUploadLeaseRetainer(t.Context(), func(l io.Closer) { held = l })
	if _, err := h.uploads.Execute(ctx, h.actor, r.ProjectID, r.TaskID, first); err != nil || held == nil {
		t.Fatalf("retained lease %v %v", held, err)
	}
	lease := held.(*uploadLease)
	if lease.count() != 0 {
		t.Fatal("lease closed before response")
	}
	t.Cleanup(func() {
		if lease.count() == 0 {
			_ = lease.Close()
		}
	})
	second := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "1", ContentBase64: "Yg=="}
	h.lookup(h.actor, next, nil)
	h.lease(h.actor, &model.Fault{Code: "resource_busy", Message: "response pending"})
	result, err := h.execute(h.actor, second)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "resource_busy" || result["writeOutcome"] != "not_committed" {
		t.Fatalf("retained slot %+v %v", result, err)
	}
	if status := h.status(h.actor, next); status["nextOffset"] != "1" {
		t.Fatalf("control status %+v", status)
	}
	if err := held.Close(); err != nil || lease.count() != 1 {
		t.Fatalf("lease release %v", err)
	}
	h.planChunk(h.actor, next, second, []byte("b"))
	if result = h.run(h.actor, second); result["nextOffset"] != "2" {
		t.Fatalf("released slot %+v", result)
	}
}
func TestUploadCleanupFailuresPreserveResultsAndCauses(t *testing.T) {
	t.Run("private gate close", func(t *testing.T) {
		h := newUploadHarness(t)
		r := h.record("file", 0)
		cause := errors.New("private gate close failed")
		h.lifecycle.files = uploadGateCloseError{Storage: h.files, cause: cause}
		in := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
		h.planChunk(h.actor, r, in, []byte("a"))
		result, err := h.execute(h.actor, in)
		if !errors.Is(err, cause) || result["receipt"] != "accepted" || result["nextOffset"] != "1" {
			t.Fatalf("gate close %+v %v", result, err)
		}
	})
	for _, state := range []string{"committed", "cleanup_pending"} {
		t.Run(state, func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("file", 1)
			chunks := h.seed(r, []byte("a"))
			cause := errors.New("transfer completion failed")
			var finishErr, cleanupErr error
			if state == "committed" {
				finishErr = cause
			} else {
				cleanupErr = cause
			}
			_, a := h.commit(h.actor, r, chunks, []byte("a"), uploadAttachment(r, 1), true, nil, finishErr, cleanupErr)
			a.effect = func(_ context.Context, b []byte) { h.target(r, b) }
			result, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "1"})
			if !errors.Is(err, cause) || result["writeOutcome"] != "confirmed" || result["attachment"] == nil {
				t.Fatalf("completion %+v %v", result, err)
			}
			h.verifyTarget(r, []byte("a"))
		})
	}
	t.Run("failed receipt", func(t *testing.T) {
		h := newUploadHarness(t)
		r := h.record("file", 1)
		chunks := h.seed(r, []byte("a"))
		stageCause, finishCause := errors.New("stage failed"), errors.New("failed receipt could not be saved")
		h.commit(h.actor, r, chunks, []byte("a"), model.Attachment{}, false, stageCause, finishCause, nil)
		result, err := h.execute(h.actor, UploadInput{Action: "commit", TransferID: r.ID, TotalBytes: "1"})
		if !errors.Is(err, stageCause) || !errors.Is(err, finishCause) || result["writeOutcome"] != "not_committed" {
			t.Fatalf("failed receipt %+v %v", result, err)
		}
	})
}
