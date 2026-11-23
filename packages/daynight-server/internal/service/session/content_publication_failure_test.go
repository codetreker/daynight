package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// The underlying database performs the transaction; only its completion
// observation is controlled to exercise an unknown or failed cleanup result.
type capacityOutcomeWriter struct {
	store.SessionWriter
	mode    string
	observe func(store.Completion, error)
}

func (w capacityOutcomeWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	completion, err := w.SessionWriter.WriteSession(ctx, work)
	var refusal *model.Fault
	if w.mode != "rollback" && errors.As(err, &refusal) && refusal.Code == "quota_exceeded" {
		if w.mode == "cleanup" {
			completion, err = store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: err}
		} else {
			completion, err = store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: err}
		}
	}
	if w.observe != nil {
		w.observe(completion, err)
	}
	return completion, err
}

func serviceCapacityFixture(t *testing.T, mode string) (serviceFixture, *Service, *local.Storage) {
	t.Helper()
	f := newServiceFixture(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if e := files.Close(); e != nil {
			t.Error(e)
		}
	})
	engine := core.NewEngine(files)
	engine.Origin = "https://daynight.cc"
	engine.SetImageDecoder(func(_ context.Context, input io.Reader, length int64, digest string) (sp.ValidatedImage, error) {
		data, e := io.ReadAll(input)
		if e != nil || int64(len(data)) != length || !bytes.Equal(data, []byte("image")) {
			return sp.ValidatedImage{}, errors.New("invalid image test bytes")
		}
		return sp.ValidatedImage{MediaType: "image/png", ByteLength: "5", SHA256: digest, Width: 2, Height: 3, FrameCount: 1}, nil
	})
	t.Cleanup(func() {
		if e := engine.Stop(context.Background()); e != nil {
			t.Error(e)
		}
	})
	service := New(capacityOutcomeWriter{SessionWriter: f.db, mode: mode}, engine)
	return f, service, files
}

func seedFullSessionResource(t *testing.T, f serviceFixture, id string) {
	t.Helper()
	length, hash, mime := "134217728", hex.EncodeToString(make([]byte, 32)), "image/png"
	resourceID := uuid.NewString()
	descriptor, err := json.Marshal(sp.Resource{ResourceID: resourceID, Revision: "1", Status: "available", Name: "existing", ByteLength: &length, SHA256: &hash, MediaType: &mime})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(t.Context(), `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$2,'existing')`, id, resourceID, descriptor); err != nil {
		t.Fatal(err)
	}
}

func TestServiceArchiveCapacityFailureRetainsTransactionEvidence(t *testing.T) {
	for _, mode := range []string{"rollback", "unknown", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			f, service, _ := serviceCapacityFixture(t, mode)
			f.service = service
			v := f.registerWeb(t)
			if _, err := f.db.Pool.Exec(t.Context(), `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
				t.Fatal(err)
			}
			op, err := service.BeginArchive(t.Context(), f.owner, f.project, f.task, v.SessionID, core.ArchiveV1Upload)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if e := op.Close(); e != nil {
					t.Error(e)
				}
			}()
			prepared, err := op.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID})
			if err != nil {
				t.Fatal(err)
			}
			seedFullSessionResource(t, f, v.SessionID)
			data, err := json.Marshal(sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: prepared.SourceThrough, Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			digest := hex.EncodeToString(sum[:])
			file := uuid.NewString()
			_, err = op.PutArchiveFile(t.Context(), "history", file, 0, int64(len(data)), digest, digest, data)
			var refusal *model.Fault
			if !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" {
				t.Fatalf("capacity refusal: %v", err)
			}
			receipt, err := service.ArchiveFileStatus(t.Context(), f.owner, f.project, f.task, v.SessionID, file)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "rollback" {
				if receipt.State != "failed" || receipt.Error == nil || receipt.Error.Code != "quota_exceeded" {
					t.Fatalf("confirmed failure not recorded: %+v", receipt)
				}
			} else if receipt.State != "receiving" || receipt.Error != nil {
				t.Fatalf("uncertain failure became terminal: %+v", receipt)
			}
		})
	}
}

func TestServiceImageCapacityFailureRetainsTransactionEvidence(t *testing.T) {
	for _, mode := range []string{"rollback", "unknown", "cleanup"} {
		t.Run(mode, func(t *testing.T) {
			f, service, files := serviceCapacityFixture(t, mode)
			f.service = service
			v := f.registerWeb(t)
			grant, err := service.Grant(t.Context(), f.owner, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1, ContentRevision: 2}
			v, err = service.Connect(t.Context(), grant.Token, hello, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			raw := []byte("image")
			hash := sha256.Sum256(raw)
			digest := hex.EncodeToString(hash[:])
			spec := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: f.owner.UserID, Fence: v.Fence, ExpectedNativeSessionID: v.Identity.NativeSessionID}, Name: "image", MediaType: "image/png", ByteLength: "5", SHA256: digest}
			if _, _, err = service.PrepareUpload(t.Context(), f.owner, f.project, f.task, v.SessionID, spec); err != nil {
				t.Fatal(err)
			}
			if _, err = service.WriteUploadChunk(t.Context(), f.owner, f.project, f.task, v.SessionID, spec.UploadID, sp.ImageChunkWrite{UploadID: spec.UploadID, Offset: "0", SHA256: digest, Data: base64.StdEncoding.EncodeToString(raw)}); err != nil {
				t.Fatal(err)
			}
			seedFullSessionResource(t, f, v.SessionID)
			validated := sp.ValidatedImage{MediaType: "image/png", ByteLength: "5", SHA256: digest, Width: 2, Height: 3, FrameCount: 1}
			captureID := uuid.NewString()
			_, err = f.db.WriteSession(t.Context(), func(scope store.SessionScope) error {
				dao := scope.SessionDAO().(store.SessionResourceDAO)
				upload, err := dao.SessionUpload(t.Context(), v.SessionID, spec.UploadID)
				if err != nil {
					return err
				}
				request := sp.ImageCaptureRequest{CaptureID: captureID, AttemptID: spec.UploadID, Occurrence: sp.ImageOccurrence{ImageID: spec.ImageID, EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
				return dao.SaveSessionCapture(t.Context(), store.SessionCaptureRecord{SessionID: v.SessionID, Request: request, Receipt: sp.ImageCaptureReceipt{CaptureID: captureID, AttemptID: spec.UploadID, Revision: "1", Occurrence: request.Occurrence, State: "reserved", ResourceID: &upload.BlobID}})
			})
			if err != nil {
				t.Fatal(err)
			}
			// Display capture uses the same publication and failure-settlement
			// transaction without enabling a native input profile. Observe its
			// persisted receipt before capture-owned cleanup releases it.
			type publication struct {
				upload store.SessionUploadRecord
				err    error
			}
			observed := make(chan publication, 1)
			var mutex sync.Mutex
			var failure error
			sent := false
			service.writer = capacityOutcomeWriter{SessionWriter: f.db, mode: mode, observe: func(completion store.Completion, err error) {
				mutex.Lock()
				defer mutex.Unlock()
				if sent {
					return
				}
				var refusal *model.Fault
				if errors.As(err, &refusal) && refusal.Code == "quota_exceeded" {
					failure = err
				}
				if failure == nil || mode == "rollback" && (err != nil || completion.Outcome != store.TransactionCommitted) {
					return
				}
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				var row store.SessionUploadRecord
				_, readErr := f.db.WriteSession(ctx, func(scope store.SessionScope) error {
					var e error
					row, e = scope.SessionDAO().(store.SessionResourceDAO).SessionUpload(ctx, v.SessionID, spec.UploadID)
					return e
				})
				if readErr != nil {
					sent = true
					observed <- publication{err: readErr}
					return
				}
				if mode == "rollback" && row.Receipt.State != "failed" {
					return
				}
				sent = true
				observed <- publication{upload: row, err: failure}
			}}
			body, err := json.Marshal(sp.ImageCaptureCommit{CaptureID: captureID, AttemptID: spec.UploadID, Validated: validated})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = service.Handle(t.Context(), sp.ControllerMessage{Type: "image_capture", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, RequestID: uuid.NewString(), Action: "commit", MediaBody: body}); err != nil {
				t.Fatal(err)
			}
			var result publication
			select {
			case result = <-observed:
			case <-time.After(10 * time.Second):
				t.Fatal("image publication transaction did not finish")
			}
			var refusal *model.Fault
			if !errors.As(result.err, &refusal) || refusal.Code != "quota_exceeded" {
				t.Fatalf("capacity refusal: %v", result.err)
			}
			row := result.upload
			if mode != "rollback" {
				// Completion releases this gate after every deferred settlement.
				// Observe uncertainty only after those writes have had a chance to run.
				ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
				defer cancel()
				gate, err := files.AcquireGate(ctx, filestorage.PrivateGate, "session-image-upload/"+v.SessionID+"/"+spec.UploadID)
				if err != nil {
					t.Fatal(err)
				}
				_, err = f.db.WriteSession(ctx, func(scope store.SessionScope) error {
					var e error
					row, e = scope.SessionDAO().(store.SessionResourceDAO).SessionUpload(ctx, v.SessionID, spec.UploadID)
					return e
				})
				if err = errors.Join(err, gate.Close()); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "rollback" {
				if row.Receipt.State != "failed" || row.Receipt.Error == nil || row.Receipt.Error.Code != "quota_exceeded" {
					t.Fatalf("confirmed failure not recorded: %+v", row.Receipt)
				}
			} else if row.Receipt.State != "verifying" || row.Receipt.Resource != nil {
				t.Fatalf("uncertain failure became terminal: %+v", row.Receipt)
			}
		})
	}
}
