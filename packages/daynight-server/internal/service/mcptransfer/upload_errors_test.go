package mcptransfer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestUploadRejectsInvalidRequestsWithoutChangingTransfer(t *testing.T) {
	f, uploads, attachments := uploadFixture(t)
	id := uuid.NewString()
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "valid", ContentType: "text/plain"})
	chunk := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
	bad := []struct {
		name, project, task string
		input               UploadInput
	}{
		{"project", "bad", f.binding.TaskID, chunk},
		{"task", f.binding.ProjectID, "bad", chunk},
		{"unknown action", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "other"}},
		{"invalid path", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: "../escape", ContentType: "text/plain"}},
		{"long path", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: strings.Repeat("a", 1025), ContentType: "text/plain"}},
		{"invalid MIME", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: "file", ContentType: "bad"}},
		{"invalid inline content", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "inline", Path: "file", ContentType: "text/plain", ContentBase64: "%%%"}},
		{"invalid inline path", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "inline", Path: "../file", ContentType: "text/plain", ContentBase64: "YQ=="}},
		{"invalid chunk id", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: "bad", Offset: "0", ContentBase64: "YQ=="}},
		{"negative offset", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "-1", ContentBase64: "YQ=="}},
		{"noncanonical offset", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "00", ContentBase64: "YQ=="}},
		{"overflow offset", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "9223372036854775808", ContentBase64: "YQ=="}},
		{"empty chunk", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0"}},
		{"invalid chunk encoding", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "%%%"}},
		{"short hash", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: "abc"}},
		{"nonhex hash", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: strings.Repeat("z", 64)}},
		{"uppercase hash", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: strings.ToUpper(digest([]byte("a")))}},
		{"hash mismatch", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: digest([]byte("b"))}},
		{"missing transfer", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "status", TransferID: uuid.NewString()}},
		{"abort missing", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "abort", TransferID: uuid.NewString()}},
		{"negative total", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "-1"}},
		{"invalid commit hash", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "0", SHA256: strings.Repeat("g", 64)}},
		{"mismatched total", f.binding.ProjectID, f.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "1"}},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if result, err := uploads.Execute(t.Context(), f.actor, tc.project, tc.task, tc.input); err == nil {
				t.Fatalf("invalid request accepted: %+v", result)
			}
		})
	}
	var missing *Uploads
	if _, err := missing.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, chunk); err == nil {
		t.Fatal("missing upload service accepted")
	}
	status := runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id})
	if status["state"] != "receiving" || status["nextOffset"] != "0" || status["operationId"] != nil {
		t.Fatalf("invalid requests changed transfer: %+v", status)
	}
	if _, _, err := attachments.Open(t.Context(), f.actor.Principal, f.binding.ProjectID, f.binding.TaskID, "valid"); err == nil {
		t.Fatal("invalid requests published a target")
	}
}

type failedUploadStorage struct {
	filestorage.TransferStorage
	putErr   error
	openErr  error
	body     []byte
	infoSize int64
	closeErr error
}

func (s failedUploadStorage) PutTransfer(ctx context.Context, n filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	if s.putErr != nil {
		return filestorage.FileInfo{}, s.putErr
	}
	return s.TransferStorage.PutTransfer(ctx, n, id, body)
}
func (s failedUploadStorage) OpenTransfer(ctx context.Context, n filestorage.TransferNamespace, id string) (filestorage.Object, error) {
	if s.openErr != nil {
		return filestorage.Object{}, s.openErr
	}
	if s.body != nil {
		return filestorage.Object{Body: uploadTestBody{Reader: bytes.NewReader(s.body), err: s.closeErr}, Info: filestorage.FileInfo{Size: s.infoSize}}, nil
	}
	return s.TransferStorage.OpenTransfer(ctx, n, id)
}

type uploadTestBody struct {
	*bytes.Reader
	err error
}

func (b uploadTestBody) Close() error { return b.err }

type failUploadReceiptDAO struct {
	store.PrivateTransferDAO
	lookup, insert error
}

func (d failUploadReceiptDAO) UploadChunk(ctx context.Context, id, chunk string) (model.UploadChunk, error) {
	if d.lookup != nil {
		return model.UploadChunk{}, d.lookup
	}
	return d.PrivateTransferDAO.UploadChunk(ctx, id, chunk)
}
func (d failUploadReceiptDAO) InsertUploadChunk(ctx context.Context, chunk model.UploadChunk) error {
	if d.insert != nil {
		return d.insert
	}
	return d.PrivateTransferDAO.InsertUploadChunk(ctx, chunk)
}

type failUploadReceiptWriter struct {
	store.PrivateTransferWriter
	lookup, insert error
}

func (w failUploadReceiptWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	return w.PrivateTransferWriter.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return fn(failUploadReceiptDAO{d, w.lookup, w.insert}) })
}

func TestUploadChunkFailuresRetainRecoverableState(t *testing.T) {
	for _, failure := range []string{"storage", "lookup", "receipt", "capacity"} {
		t.Run(failure, func(t *testing.T) {
			f, uploads, _ := uploadFixture(t)
			id := uuid.NewString()
			runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
			cause := errors.New("injected " + failure)
			originalDB, originalFiles, originalBudget := f.lifecycle.db, uploads.files, f.lifecycle.budget
			switch failure {
			case "storage":
				uploads.files = failedUploadStorage{TransferStorage: f.files, putErr: cause}
			case "lookup":
				f.lifecycle.db = failUploadReceiptWriter{PrivateTransferWriter: originalDB, lookup: cause}
			case "receipt":
				f.lifecycle.db = failUploadReceiptWriter{PrivateTransferWriter: originalDB, insert: cause}
			case "capacity":
				f.lifecycle.budget = 1
			}
			input := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("data"))}
			result, err := uploads.Execute(t.Context(), f.actor, f.binding.ProjectID, f.binding.TaskID, input)
			if err == nil {
				t.Fatalf("%s was ignored: %+v", failure, result)
			}
			if failure != "capacity" && !errors.Is(err, cause) {
				t.Fatalf("cause lost: %v", err)
			}
			if failure == "capacity" && result["writeOutcome"] != "not_committed" {
				t.Fatalf("capacity outcome: %+v", result)
			}
			f.lifecycle.db, uploads.files, f.lifecycle.budget = originalDB, originalFiles, originalBudget
			status := runUpload(t, uploads, f, f.actor, UploadInput{Action: "status", TransferID: id})
			if status["nextOffset"] != "0" {
				t.Fatalf("unconfirmed chunk advanced offset: %+v", status)
			}
			accepted := runUpload(t, uploads, f, f.actor, input)
			if accepted["receipt"] != "accepted" || accepted["nextOffset"] != "4" {
				t.Fatalf("same chunk could not recover: %+v", accepted)
			}
		})
	}
}

func TestUploadStreamRejectsMissingCorruptAndIncompleteObjects(t *testing.T) {
	f, uploads, _ := uploadFixture(t)
	id := uuid.NewString()
	content := []byte("correct")
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "begin", TransferID: id, Path: "file", ContentType: "text/plain"})
	runUpload(t, uploads, f, f.actor, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)})
	permit, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, id)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	if _, err := uploads.stream(t.Context(), permit, "invalid", int64(len(content))); err == nil {
		t.Fatal("invalid namespace accepted")
	}
	cause := errors.New("injected object failure")
	for _, tc := range []struct {
		name    string
		storage failedUploadStorage
		total   int64
		want    error
	}{
		{"open", failedUploadStorage{TransferStorage: f.files, openErr: cause}, int64(len(content)), cause},
		{"size mismatch", failedUploadStorage{TransferStorage: f.files, body: content, infoSize: 1}, int64(len(content)), nil},
		{"short read", failedUploadStorage{TransferStorage: f.files, body: content[:3], infoSize: int64(len(content))}, int64(len(content)), io.ErrUnexpectedEOF},
		{"hash mismatch", failedUploadStorage{TransferStorage: f.files, body: []byte("corrupt"), infoSize: int64(len(content))}, int64(len(content)), nil},
		{"close failure", failedUploadStorage{TransferStorage: f.files, body: content, infoSize: int64(len(content)), closeErr: cause}, int64(len(content)), cause},
		{"receipt exceeds total", failedUploadStorage{TransferStorage: f.files}, 1, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uploads.files = tc.storage
			stream, err := uploads.stream(t.Context(), permit, id, tc.total)
			if err != nil {
				t.Fatal(err)
			}
			_, readErr := io.ReadAll(stream)
			_ = stream.Close()
			if readErr == nil || (tc.want != nil && !errors.Is(readErr, tc.want)) {
				t.Fatalf("corruption not reported: %v", readErr)
			}
		})
	}
	uploads.files = failedUploadStorage{TransferStorage: f.files, body: content, infoSize: int64(len(content)), closeErr: cause}
	stream, err := uploads.stream(t.Context(), permit, id, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	var one [1]byte
	if n, err := stream.Read(one[:]); err != nil || n != 1 {
		t.Fatalf("partial read: %d %v", n, err)
	}
	if err := stream.Close(); !errors.Is(err, cause) {
		t.Fatalf("close failure lost: %v", err)
	}
}
