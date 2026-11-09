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
	"github.com/google/uuid"
)

func TestUploadRejectsInvalidRequestsWithoutChangingTransfer(t *testing.T) {
	h := newUploadHarness(t)
	r := h.record("valid", 0)
	id := r.ID
	chunk := UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ=="}
	bad := []struct {
		name, project, task string
		input               UploadInput
	}{
		{"project", "bad", h.binding.TaskID, chunk},
		{"task", h.binding.ProjectID, "bad", chunk},
		{"unknown action", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "other"}},
		{"invalid path", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: "../escape", ContentType: "text/plain"}},
		{"long path", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: strings.Repeat("a", 1025), ContentType: "text/plain"}},
		{"invalid MIME", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "begin", TransferID: uuid.NewString(), Path: "file", ContentType: "bad"}},
		{"invalid inline content", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "inline", Path: "file", ContentType: "text/plain", ContentBase64: "%%%"}},
		{"invalid inline path", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "inline", Path: "../file", ContentType: "text/plain", ContentBase64: "YQ=="}},
		{"invalid chunk id", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: "bad", Offset: "0", ContentBase64: "YQ=="}},
		{"negative offset", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "-1", ContentBase64: "YQ=="}},
		{"noncanonical offset", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "00", ContentBase64: "YQ=="}},
		{"overflow offset", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "9223372036854775808", ContentBase64: "YQ=="}},
		{"empty chunk", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0"}},
		{"invalid chunk encoding", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "%%%"}},
		{"short hash", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: "abc"}},
		{"nonhex hash", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: strings.Repeat("z", 64)}},
		{"uppercase hash", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: strings.ToUpper(digest([]byte("a")))}},
		{"hash mismatch", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "chunk", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", SHA256: digest([]byte("b"))}},
		{"missing transfer", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "status", TransferID: uuid.NewString()}},
		{"abort missing", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "abort", TransferID: uuid.NewString()}},
		{"negative total", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "-1"}},
		{"invalid commit hash", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "0", SHA256: strings.Repeat("g", 64)}},
		{"mismatched total", h.binding.ProjectID, h.binding.TaskID, UploadInput{Action: "commit", TransferID: id, TotalBytes: "1"}},
	}

	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			switch tc.name {
			case "missing transfer", "abort missing":
				h.expect(getMissing(tc.input.TransferID))
			case "mismatched total":
				h.prepare(h.actor, r)
			case "invalid inline path":
				item := uploadAttachment(r, 1)
				h.planInline(h.actor, "../file", []byte("a"), item, false, errors.New("invalid attachment path"))
			}
			if result, err := h.uploads.Execute(t.Context(), h.actor, tc.project, tc.task, tc.input); err == nil {
				t.Fatalf("invalid request accepted %+v", result)
			}
		})
	}
	var missing *Uploads
	if _, err := missing.Execute(t.Context(), h.actor, h.binding.ProjectID, h.binding.TaskID, chunk); err == nil {
		t.Fatal("missing service accepted")
	}
	status := h.status(h.actor, r)
	if status["state"] != "receiving" || status["nextOffset"] != "0" || status["operationId"] != nil {
		t.Fatalf("invalid request changed transfer %+v", status)
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

func TestUploadChunkFailuresRetainRecoverableState(t *testing.T) {
	for _, failure := range []string{"storage", "lookup", "receipt", "capacity"} {
		t.Run(failure, func(t *testing.T) {
			h := newUploadHarness(t)
			r := h.record("file", 0)
			content := []byte("data")
			cause := errors.New("injected " + failure)
			in := UploadInput{Action: "chunk", TransferID: r.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString(content)}
			current := h.prepare(h.actor, r)
			if failure == "lookup" {
				h.expect(get(current), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("UploadChunk", nil, cause, r.ID, in.ChunkID))
			} else {
				h.missingReceipt(current, in.ChunkID)
				if failure == "capacity" {
					h.lifecycle.budget = 1
					h.expect(get(current), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil), get(current), method("LockLedger", nil, nil), method("ReservedTotal", int64(0), nil))
				} else {
					reserved := h.reserve(current, 4)
					steps := []daoStep{get(reserved), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID)}
					if failure == "storage" {
						h.uploads.files = failedUploadStorage{TransferStorage: h.files, putErr: cause}
					} else {
						steps = append(steps, daoStep{method: "InsertUploadChunk", check: func(args []any) {
							c := args[0].(model.UploadChunk)
							if c.TransferID != r.ID || c.ChunkID != in.ChunkID || c.Size != 4 || c.Offset != 0 || c.SHA256 != digest(content) {
								t.Errorf("attempted receipt %+v", c)
							}
						}, err: cause})
					}
					h.expect(steps...)
				}
			}
			result, err := h.execute(h.actor, in)
			if err == nil || failure != "capacity" && !errors.Is(err, cause) || failure == "capacity" && result["writeOutcome"] != "not_committed" {
				t.Fatalf("failure result %+v %v", result, err)
			}
			h.uploads.files = h.files
			h.lifecycle.budget = 1 << 30
			if status := h.status(h.actor, r); status["nextOffset"] != "0" {
				t.Fatalf("unconfirmed chunk advanced %+v", status)
			}
			next, _ := h.planChunk(h.actor, r, in, content)
			accepted := h.run(h.actor, in)
			if accepted["receipt"] != "accepted" || accepted["nextOffset"] != "4" || uploadNextOffset(next) != 4 {
				t.Fatalf("recovery %+v", accepted)
			}
		})
	}
}
func TestUploadStreamRejectsMissingCorruptAndIncompleteObjects(t *testing.T) {
	h := newUploadHarness(t)
	content := []byte("correct")
	r := h.record("file", int64(len(content)))
	chunks := h.seed(r, content)
	permit := h.lifecycleFixture.permit(r)
	current := cloneTransfer(r)
	current.Version++
	if _, err := h.uploads.stream(t.Context(), permit, "invalid", int64(len(content))); err == nil {
		t.Fatal("invalid namespace accepted")
	}
	cause := errors.New("object failure")
	for _, tc := range []struct {
		name    string
		storage failedUploadStorage
		total   int64
		want    error
	}{
		{"open", failedUploadStorage{TransferStorage: h.files, openErr: cause}, int64(len(content)), cause},
		{"size mismatch", failedUploadStorage{TransferStorage: h.files, body: content, infoSize: 1}, int64(len(content)), nil},
		{"short read", failedUploadStorage{TransferStorage: h.files, body: content[:3], infoSize: int64(len(content))}, int64(len(content)), io.ErrUnexpectedEOF},
		{"hash mismatch", failedUploadStorage{TransferStorage: h.files, body: []byte("corrupt"), infoSize: int64(len(content))}, int64(len(content)), nil},
		{"close failure", failedUploadStorage{TransferStorage: h.files, body: content, infoSize: int64(len(content)), closeErr: cause}, int64(len(content)), cause},
		{"receipt exceeds total", failedUploadStorage{TransferStorage: h.files}, 1, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h.uploads.files = tc.storage
			h.streamReads(current, chunks)
			stream, err := h.uploads.stream(t.Context(), permit, r.ID, tc.total)
			if err != nil {
				t.Fatal(err)
			}
			_, readErr := io.ReadAll(stream)
			_ = stream.Close()
			if readErr == nil || tc.want != nil && !errors.Is(readErr, tc.want) {
				t.Fatalf("corruption not reported %v", readErr)
			}
		})
	}
	h.uploads.files = failedUploadStorage{TransferStorage: h.files, body: content, infoSize: int64(len(content)), closeErr: cause}
	h.streamReads(current, chunks)
	stream, err := h.uploads.stream(t.Context(), permit, r.ID, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	var one [1]byte
	if n, err := stream.Read(one[:]); n != 1 || err != nil {
		t.Fatalf("partial read %d %v", n, err)
	}
	if err := stream.Close(); !errors.Is(err, cause) {
		t.Fatalf("close cause %v", err)
	}
}
