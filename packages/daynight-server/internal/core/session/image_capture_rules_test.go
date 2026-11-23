package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type captureFailureDAO struct {
	*imageRuleDAO
	point string
	cause error
}

func TestCaptureRequestRefusalRequiresSuccessfulControllerCompletion(t *testing.T) {
	for _, kind := range []string{"committed", "unknown", "cleanup", "fence"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			dao := &mediaHandleDAO{imageRuleDAO: f.d}
			cause := errors.New("transaction completion failed")
			f.s.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				if kind == "fence" {
					return cause
				}
				if e := work(&Access{tx: &operationTx{dao: dao, op: &Operation{}}, record: f.r}); e != nil {
					return e
				}
				switch kind {
				case "unknown":
					return &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
				case "cleanup":
					return &store.TransactionError{Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: cause}
				}
				return nil
			}
			m := sp.ControllerMessage{Type: "image_capture", ControllerFence: f.r.Snapshot.ControllerFence, Action: "query", MediaBody: encode(map[string]any{"captureId": uuid.NewString()})}
			_, err := f.s.Handle(t.Context(), m)
			var refusal *CaptureRequestError
			if kind == "committed" {
				if !errors.As(err, &refusal) || refusal.Code != "capture_not_found" || dao.touches != 1 || dao.sessionWrites != 1 {
					t.Fatal("missing capture was not an isolated request refusal", err, dao)
				}
			} else if !errors.Is(err, cause) || errors.As(err, &refusal) {
				t.Fatal("completion or fence error was hidden by a capture refusal", err)
			}
		})
	}
}

func TestDefiniteImageFailureRetainsUnknownAndCleanupOutcomes(t *testing.T) {
	denied := &definiteImageError{image: sp.ImageError{Code: "storage_unavailable", Message: "Storage refused the write."}, cause: &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: errors.New("disk full")}}
	cleanup := errors.New("cleanup failed")
	for _, tc := range []struct {
		name     string
		err      error
		definite bool
	}{
		{"not published", denied, true},
		{"confirmed rollback", &store.TransactionError{Outcome: store.TransactionNotCommitted, Cause: denied}, true},
		{"unknown commit", &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: denied}, false},
		{"cleanup failure", errors.Join(denied, cleanup), false},
		{"published storage", &filestorage.PublicationError{Outcome: filestorage.Published, Cause: cleanup}, false},
		{"unmarked quota", fault("quota_exceeded", "Other quota."), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := definiteImageFailure(tc.err); (got != nil) != tc.definite {
				t.Fatal("incorrect failure classification", got, tc.err)
			}
		})
	}
	missingWithFailure := errors.Join(model.ErrNotFound, cleanup)
	if got := captureMissing(missingWithFailure); !errors.Is(got, cleanup) || got != missingWithFailure {
		t.Fatal("missing-row classification hid an independent error", got)
	}
}

func TestImageFailureEvidenceRejectsAmbiguousAndUnidentifiedErrors(t *testing.T) {
	cause := errors.New("original write failed")
	cleanup := errors.New("discard failed")
	message := sp.ImageError{Code: "storage_unavailable", Message: "Image storage is unavailable."}
	unidentified := &definiteImageError{image: message, cause: cause}
	if unidentified.Error() != cause.Error() || imageFailureEvidence(fmt.Errorf("write: %w", unidentified)) != nil {
		t.Fatal("an error without an original upload observation became settlement evidence")
	}
	joined := &definiteImageError{image: message, cause: errors.Join(cause, cleanup)}
	if imageFailureEvidence(joined) != nil || !errors.Is(joined, cleanup) || !errors.Is(joined, cause) {
		t.Fatal("ambiguous original and cleanup failures became settlement evidence")
	}
	refusal := captureRefusal("capture_not_found", "Image capture was not found.")
	if refusal.Error() != "Image capture was not found." {
		t.Fatal("capture refusal lost its public message", refusal)
	}
}

func TestCaptureFailureCannotSettleAfterIdentityOrStorageChanges(t *testing.T) {
	for _, kind := range []string{"storage unavailable", "gate failure", "capture missing", "capture terminal", "upload identity changed", "upload disappeared"} {
		t.Run(kind, func(t *testing.T) {
			f, capture := copyingCaptureFixture(t)
			original := f.d.uploads[capture.Receipt.AttemptID]
			evidence := &definiteImageError{image: sp.ImageError{Code: "storage_unavailable", Message: "Storage failed."}, expectedUpload: &original}
			cause := errors.New("gate unavailable")
			switch kind {
			case "storage unavailable":
				f.s.files = nil
			case "gate failure":
				f.s.files = imageBoundaryStorage{Storage: f.files, point: "gate", cause: cause}
			case "capture missing":
				delete(f.d.captures, capture.Request.CaptureID)
			case "capture terminal":
				current := capture
				current.Receipt.State = "failed"
				current.Receipt.ResourceID = nil
				current.Receipt.Error = &sp.ImageError{Code: "invalid_image", Message: "Earlier failure."}
				f.d.captures[capture.Request.CaptureID] = current
			case "upload identity changed":
				changed := original
				changed.ActorID = uuid.NewString()
				f.d.uploads[capture.Receipt.AttemptID] = changed
			case "upload disappeared":
				delete(f.d.uploads, capture.Receipt.AttemptID)
			}
			before := f.d.captures[capture.Request.CaptureID]
			uploadBefore, uploadExists := f.d.uploads[capture.Receipt.AttemptID]
			err := f.s.settleCaptureFailure(t.Context(), f.p, "", "", capture.SessionID, capture, evidence)
			switch kind {
			case "storage unavailable", "capture missing", "upload identity changed":
				if err == nil {
					t.Fatal("invalid settlement succeeded")
				}
			case "gate failure":
				if !errors.Is(err, cause) {
					t.Fatal("gate failure was hidden", err)
				}
			default:
				if err != nil {
					t.Fatal("unchanged state should need no settlement", err)
				}
			}
			if got := f.d.captures[capture.Request.CaptureID]; !jsonEqual(encode(got), encode(before)) {
				t.Fatal("original capture changed", got)
			}
			if got, exists := f.d.uploads[capture.Receipt.AttemptID]; exists != uploadExists || exists && !jsonEqual(encode(got), encode(uploadBefore)) {
				t.Fatal("original upload changed", got)
			}
		})
	}
}

func TestImageUploadValidationWaitsForCleanupBeforeFailureSettlement(t *testing.T) {
	for _, failCleanup := range []bool{false, true} {
		t.Run(map[bool]string{false: "clean", true: "lease cleanup failed"}[failCleanup], func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			f.s.SetImageDecoder(func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
				return sp.ValidatedImage{}, fault("invalid_image", "Original image rejected.")
			})
			cleanupErr := errors.New("lease release failed")
			if failCleanup {
				f.s.releaseMediaLeaseRun = func(context.Context, string, string) error { return cleanupErr }
			}
			_, err := f.complete(t)
			current := f.d.uploads[f.spec.UploadID]
			if failCleanup {
				if !errors.Is(err, cleanupErr) || current.Receipt.State != "verifying" {
					t.Fatal("cleanup failure lost the original verifying responsibility", current.Receipt, err)
				}
			} else if err == nil || current.Receipt.State != "failed" || current.Receipt.Error == nil || current.Receipt.Error.Code != "invalid_image" {
				t.Fatal("verified refusal was not settled", current.Receipt, err)
			}
		})
	}
}

type imageGateCloseFailureStorage struct {
	filestorage.Storage
	fail  *atomic.Bool
	cause error
}
type imageGateCloseFailure struct {
	io.Closer
	fail  *atomic.Bool
	cause error
}

func (g imageGateCloseFailure) Close() error {
	err := g.Closer.Close()
	if g.fail.CompareAndSwap(true, false) {
		return errors.Join(err, g.cause)
	}
	return err
}
func (s imageGateCloseFailureStorage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	gate, err := s.Storage.AcquireGate(ctx, domain, key)
	if err != nil {
		return nil, err
	}
	if domain == filestorage.PrivateGate {
		return imageGateCloseFailure{Closer: gate, fail: s.fail, cause: s.cause}, nil
	}
	return gate, nil
}
func TestFailedUploadReconcilesOriginalAfterGateCloseFailure(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	f.s.SetImageDecoder(func(context.Context, io.Reader, int64, string) (sp.ValidatedImage, error) {
		return sp.ValidatedImage{}, fault("invalid_image", "Original rejected.")
	})
	var fail atomic.Bool
	fail.Store(true)
	closeErr := errors.New("gate close failed")
	f.s.files = imageGateCloseFailureStorage{Storage: f.files, fail: &fail, cause: closeErr}
	_, err := f.complete(t)
	if !errors.Is(err, closeErr) || imageFailureEvidence(err) != nil || f.d.uploads[f.spec.UploadID].Receipt.State != "failed" {
		t.Fatal("gate failure hid original responsibility", err)
	}
	_, err = f.complete(t)
	evidence := imageFailureEvidence(err)
	if evidence == nil || evidence.expectedUpload == nil || evidence.expectedUpload.Receipt.State != "failed" || evidence.image.Code != "invalid_image" {
		t.Fatal("original failed upload could not reconcile", err)
	}
}

type publicationFailureStorage struct {
	filestorage.Storage
	putErr error
	read   bool
}

func (s publicationFailureStorage) Put(_ context.Context, _, _ string, input io.Reader) (filestorage.FileInfo, error) {
	if s.read {
		_, err := io.Copy(io.Discard, input)
		return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: errors.Join(err, s.putErr)}
	}
	return filestorage.FileInfo{}, &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: s.putErr}
}

type failedImageReader struct{ err error }

func (r failedImageReader) Read([]byte) (int, error) { return 0, r.err }

func TestImagePublicationDistinguishesSourceAndStorageFailures(t *testing.T) {
	for _, kind := range []string{"storage", "source", "source and cleanup", "storage and cleanup"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			storageErr, sourceErr, cleanupErr := errors.New("disk full"), errors.New("source read failed"), errors.New("discard failed")
			storage := publicationFailureStorage{Storage: f.files, putErr: storageErr}
			var input io.Reader = failedImageReader{err: sourceErr}
			switch kind {
			case "source":
				storage.read, storage.putErr = true, nil
			case "source and cleanup":
				storage.read, storage.putErr = true, cleanupErr
			case "storage and cleanup":
				storage.putErr = errors.Join(storageErr, cleanupErr)
			}
			f.s.files = storage
			err := f.s.publishImageBytes(t.Context(), "new/image", input, 8, imageBytesHash([]byte("original")))
			got := definiteImageFailure(err)
			if kind == "storage" {
				if got == nil || got.Code != "storage_unavailable" || !errors.Is(err, storageErr) {
					t.Fatal("known storage failure was not preserved", got, err)
				}
			} else if got != nil || kind != "storage and cleanup" && !errors.Is(err, sourceErr) || kind != "source" && !errors.Is(err, cleanupErr) {
				t.Fatal("source or cleanup failure was misclassified", got, err)
			}
		})
	}
}

func copyingCaptureFixture(t *testing.T) (imageRuleFixture, store.SessionCaptureRecord) {
	t.Helper()
	f := newImageRuleFixture(t, []byte("original"))
	capture := registerOccurrenceFixture(t, f)
	capture.Receipt.State = "copying"
	capture.Validated = &sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	f.d.captures[capture.Request.CaptureID] = capture
	f.spec.UploadID, f.spec.ImageID = capture.Receipt.AttemptID, capture.Request.Occurrence.ImageID
	if _, _, err := f.s.prepareUploadIdentity(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, false, *capture.Receipt.ResourceID, capture.Request.CaptureID); err != nil {
		t.Fatal(err)
	}
	return f, capture
}

func TestCaptureFailureReleasesOriginalStagingAndRetainsCleanupFailure(t *testing.T) {
	for _, priorChunk := range []bool{false, true} {
		for _, cleanupFailure := range []bool{false, true} {
			t.Run(fmt.Sprintf("prior=%v/cleanup=%v", priorChunk, cleanupFailure), func(t *testing.T) {
				f, capture := copyingCaptureFixture(t)
				if priorChunk {
					if _, err := f.write(t, []byte("orig"), 0); err != nil {
						t.Fatal(err)
					}
				}
				failure := errors.New("cleanup failed")
				if cleanupFailure {
					f.s.files = imageBoundaryStorage{Storage: f.files, point: "delete", cause: failure}
				}
				expected := f.d.uploads[capture.Receipt.AttemptID]
				err := f.s.settleCaptureFailure(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, capture, &definiteImageError{image: sp.ImageError{Code: "storage_unavailable", Message: "Storage failed."}, expectedUpload: &expected})
				upload := f.d.uploads[capture.Receipt.AttemptID]
				current := f.d.captures[capture.Request.CaptureID]
				if current.Receipt.State != "failed" || upload.Receipt.State != "released" || upload.StorageReleased == cleanupFailure || cleanupFailure != errors.Is(err, failure) {
					t.Fatal("original cleanup responsibility is incorrect", current.Receipt, upload, err)
				}
				canRetry, retryErr := captureCanRetry(t.Context(), f.d, current, true)
				if retryErr != nil || canRetry == cleanupFailure {
					t.Fatal("retry ignored original cleanup", canRetry, retryErr)
				}
			})
		}
	}
}

type captureGateObservedStorage struct {
	filestorage.Storage
	entered chan struct{}
}

func (s captureGateObservedStorage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	if domain == filestorage.PrivateGate {
		close(s.entered)
	}
	return s.Storage.AcquireGate(ctx, domain, key)
}
func TestCaptureFailureDoesNotRewindConcurrentAdvancedUpload(t *testing.T) {
	for _, state := range []string{"complete", "verifying", "advanced"} {
		t.Run(state, func(t *testing.T) {
			f, capture := copyingCaptureFixture(t)
			expected := f.d.uploads[capture.Receipt.AttemptID]
			gate, err := f.files.AcquireGate(t.Context(), filestorage.PrivateGate, "session-image-upload/"+f.r.Snapshot.SessionID+"/"+capture.Receipt.AttemptID)
			if err != nil {
				t.Fatal(err)
			}
			entered := make(chan struct{})
			f.s.files = captureGateObservedStorage{Storage: f.files, entered: entered}
			done := make(chan error, 1)
			go func() {
				done <- f.s.settleCaptureFailure(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, capture, &definiteImageError{image: sp.ImageError{Code: "storage_unavailable", Message: "Storage failed."}, expectedUpload: &expected})
			}()
			<-entered
			select {
			case err := <-done:
				t.Fatal("settlement crossed another writer's gate", err)
			default:
			}
			upload := f.d.uploads[capture.Receipt.AttemptID]
			switch state {
			case "complete":
				upload.Receipt.State = "complete"
				upload.Receipt.Resource = &sp.Resource{ResourceID: upload.BlobID, Status: "available"}
			case "verifying":
				upload.Receipt.State = "verifying"
			case "advanced":
				upload.Receipt.AcceptedOffset = "4"
			}
			f.d.uploads[capture.Receipt.AttemptID] = upload
			if err := gate.Close(); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			if got := f.d.captures[capture.Request.CaptureID]; got.Receipt.State != "copying" {
				t.Fatal("completed original was marked failed", got.Receipt)
			}
			if got := f.d.uploads[capture.Receipt.AttemptID]; !jsonEqual(encode(got), encode(upload)) || got.StorageReleased {
				t.Fatal("completed original was released", got.Receipt)
			}
		})
	}
}

func TestCaptureIdentityDoesNotReserveVolume(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	capture := registerOccurrenceFixture(t, f)
	capture.Receipt.State = "copying"
	capture.Validated = &sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	f.d.captures[capture.Request.CaptureID] = capture
	f.spec.UploadID, f.spec.ImageID = capture.Receipt.AttemptID, capture.Request.Occurrence.ImageID
	f.files.free = 0
	receipt, created, err := f.s.prepareUploadIdentity(t.Context(), f.p, "", "", capture.SessionID, f.spec, false, *capture.Receipt.ResourceID, capture.Request.CaptureID)
	if err != nil || !created || receipt.State != "receiving" || f.d.uploads[f.spec.UploadID].BlobID != *capture.Receipt.ResourceID {
		t.Fatal("copy identity depended on future volume capacity", receipt, err)
	}
	if f.r.Snapshot.ImageBudget.ReservedBytes != "0" {
		t.Fatal("copy identity reserved future bytes", f.r.Snapshot.ImageBudget)
	}
}

func (d *captureFailureDAO) SessionCapture(ctx context.Context, s, id string) (store.SessionCaptureRecord, error) {
	if d.point == "capture" {
		return store.SessionCaptureRecord{}, d.cause
	}
	return d.imageRuleDAO.SessionCapture(ctx, s, id)
}
func (d *captureFailureDAO) SessionResourceUsage(ctx context.Context, s string) (store.SessionResourceUsage, error) {
	if d.point == "usage" {
		return store.SessionResourceUsage{}, d.cause
	}
	return d.imageRuleDAO.SessionResourceUsage(ctx, s)
}
func (d *captureFailureDAO) SaveSessionCapture(ctx context.Context, r store.SessionCaptureRecord) error {
	if d.point == "save" {
		return d.cause
	}
	return d.imageRuleDAO.SaveSessionCapture(ctx, r)
}
func (d *captureFailureDAO) SavedSessionResource(ctx context.Context, s, id string) (store.SessionResourceRecord, error) {
	if d.point == "resource" {
		return store.SessionResourceRecord{}, d.cause
	}
	return d.imageRuleDAO.SavedSessionResource(ctx, s, id)
}
func TestImageCaptureAdmissionRefusesChangedNativeScopeAndResourceCapacity(t *testing.T) {
	for _, kind := range []string{"old content", "rate", "invalid", "native locator", "native source", "frozen", "deleting", "decoder missing", "capture failure", "usage failure", "save failure", "alias missing", "alias unavailable", "resource failure"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			old := registerOccurrenceFixture(t, f)
			request := old.Request
			request.CaptureID, request.AttemptID, request.Occurrence.ImageID, request.Occurrence.SourceKey = uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			f.d.bundle.Ledger = encode(archiveLedger{HistoryID: f.d.bundle.HistoryID, HistoryEpoch: f.r.Snapshot.HistoryEpoch, SourceThrough: "0", Occurrences: []archiveLedgerOccurrence{{EntryID: request.Occurrence.EntryID, ImageID: request.Occurrence.ImageID, Container: "content"}}})
			cause := errors.New("capture storage unavailable")
			d := &captureFailureDAO{imageRuleDAO: f.d, cause: cause}
			body := encode(request)
			switch kind {
			case "old content":
				f.r.Snapshot.ContentRevision = 0
			case "rate":
				f.d.rateDeny = "prepare"
			case "invalid":
				body = []byte(`{}`)
			case "native locator":
				request.Locator = sp.ImageLocator{Kind: "native", Provider: "codex", NativeSessionID: "replacement", NativeMessageID: "message", NativePartID: "part"}
			case "native source":
				request.NativeSource = &sp.NativeImageSource{Provider: "codex", NativeSessionID: "replacement", NativeMessageID: "message", NativePartID: "part"}
			case "frozen":
				f.d.usage.Frozen = true
			case "deleting":
				f.d.usage.Deleting = true
			case "decoder missing":
				f.s.SetImageDecoder(nil)
			case "capture failure":
				d.point = "capture"
			case "usage failure":
				d.point = "usage"
			case "save failure":
				d.point = "save"
			case "alias missing":
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: uuid.NewString()}
			case "alias unavailable":
				id := uuid.NewString()
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: id}
				size := "8"
				f.d.resources[id] = store.SessionResourceRecord{Resource: sp.Resource{ResourceID: id, Status: "pending", ByteLength: &size}}
			case "resource failure":
				request.Locator = sp.ImageLocator{Kind: "resource", ResourceID: uuid.NewString()}
				d.point = "resource"
			}
			if kind != "invalid" {
				body = encode(request)
			}
			_, e := f.s.captureMessage(t.Context(), &operationTx{dao: d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "register", MediaBody: body})
			if e == nil {
				t.Fatal("invalid capture admitted", kind)
			}
			if d.point != "" && !errors.Is(e, cause) {
				t.Fatal("capture storage error hidden", e)
			}
			switch kind {
			case "decoder missing", "alias missing", "alias unavailable":
				failed, ok := f.d.captures[request.CaptureID]
				if !ok || failed.Request.AttemptID != request.AttemptID || failed.Receipt.State != "failed" || failed.Receipt.ResourceID != nil || failed.Receipt.Error == nil || len(f.d.captures) != 2 {
					t.Fatal("refusal did not retain the failed original identity", failed)
				}
				out, err := f.s.captureMessage(t.Context(), &operationTx{dao: d, op: &Operation{}}, f.r, sp.ControllerMessage{Action: "query", MediaBody: encode(map[string]any{"captureId": request.CaptureID})})
				if err != nil || out["result"].(sp.ImageCaptureReceipt).State != "failed" {
					t.Fatal("failed original cannot be queried", out, err)
				}
			default:
				if len(f.d.captures) != 1 {
					t.Fatal("refused capture allocated a replacement occurrence")
				}
			}
		})
	}
}
func TestImageCaptureFailuresAndQueriesKeepCurrentRevisionAndTerminalIdentity(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	c := registerOccurrenceFixture(t, f)
	tx := &operationTx{dao: f.d, op: &Operation{}}
	call := func(action string, body any) (sp.ImageCaptureReceipt, error) {
		out, e := f.s.captureMessage(t.Context(), tx, f.r, sp.ControllerMessage{Action: action, MediaBody: encode(body)})
		if e != nil {
			return sp.ImageCaptureReceipt{}, e
		}
		return out["result"].(sp.ImageCaptureReceipt), nil
	}
	failure := map[string]any{"captureId": c.Request.CaptureID, "attemptId": c.Receipt.AttemptID, "error": sp.ImageError{Code: "invalid_image", Message: "Rejected original."}}
	failed, e := call("failed", failure)
	if e != nil || failed.State != "failed" || failed.ResourceID != nil || failed.Revision != "2" {
		t.Fatal(failed, e)
	}
	replay, e := call("failed", failure)
	if e != nil || replay.Revision != failed.Revision {
		t.Fatal("identical failure changed revision", replay, e)
	}
	query, e := call("query", map[string]any{"captureId": c.Request.CaptureID})
	if e != nil || query.Revision != failed.Revision || query.State != "failed" {
		t.Fatal(query, e)
	}
	metadata := sp.ValidatedImage{MediaType: "image/png", ByteLength: "8", SHA256: imageBytesHash([]byte("original")), Width: 2, Height: 3, FrameCount: 1}
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: metadata}); e == nil {
		t.Fatal("failed attempt revived")
	}
	for _, action := range []string{"query", "failed", "commit", "other"} {
		if _, e = f.s.captureMessage(t.Context(), tx, f.r, sp.ControllerMessage{Action: action, MediaBody: []byte(`{bad`)}); e == nil {
			t.Fatal("invalid capture action accepted", action)
		}
	}
	c.Validated = &metadata
	c.Receipt.State = "copying"
	c.Receipt.Error = nil
	f.d.captures[c.Request.CaptureID] = c
	if _, e = call("query", map[string]any{"captureId": c.Request.CaptureID}); e != nil {
		t.Fatal(e)
	}
	if len(tx.op.committed) != 1 {
		t.Fatal("query did not schedule original copying attempt")
	}
	if _, e = call("failed", failure); e == nil {
		t.Fatal("late failure rewound copying attempt")
	}
	changed := metadata
	changed.Width = 3
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: changed}); e == nil {
		t.Fatal("changed validation metadata accepted")
	}
	c.Receipt.State = "committed"
	resource := uuid.NewString()
	media, size, digest := metadata.MediaType, metadata.ByteLength, metadata.SHA256
	width, height, frames := metadata.Width, metadata.Height, metadata.FrameCount
	c.Receipt.ResourceID = &resource
	c.Receipt.Resource = &sp.Resource{Revision: "1", ResourceID: resource, Status: "available", Name: "original.png", MediaType: &media, ByteLength: &size, SHA256: &digest, Width: &width, Height: &height, FrameCount: &frames}
	f.d.captures[c.Request.CaptureID] = c
	if _, e = call("commit", sp.ImageCaptureCommit{CaptureID: c.Request.CaptureID, AttemptID: c.Receipt.AttemptID, Validated: metadata}); e != nil {
		t.Fatal("same committed attempt could not reconcile", e)
	}
}
func TestImageCaptureCheckpointBindsCallAndMarkdownSourceRevision(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	c := registerOccurrenceFixture(t, f)
	call, part, revision, digest := "original-call", uuid.NewString(), "2", imageBytesHash([]byte("original markdown"))
	occurrence := c.Request.Occurrence
	occurrence.Container = "tool_output"
	occurrence.CallID = &call
	occurrence.PartID = &part
	occurrence.SourceRevision = &revision
	occurrence.SourceTextSHA256 = &digest
	f.d.bundle.Ledger = encode(archiveLedger{Occurrences: []archiveLedgerOccurrence{{EntryID: occurrence.EntryID, ImageID: occurrence.ImageID, Container: occurrence.Container, CallIDSHA256: archiveCallIDSHA256(&call), PartID: &part, SourceRevision: &revision, SourceTextSHA256: &digest}}})
	tx := &operationTx{dao: f.d, op: &Operation{}}
	if e := verifyImageOccurrence(t.Context(), tx, f.r, occurrence); e != nil {
		t.Fatal(e)
	}
	changed := occurrence
	other := "other-call"
	changed.CallID = &other
	if e := verifyImageOccurrence(t.Context(), tx, f.r, changed); e == nil {
		t.Fatal("different tool source reused original image")
	}
	changed = occurrence
	other = "3"
	changed.SourceRevision = &other
	if e := verifyImageOccurrence(t.Context(), tx, f.r, changed); e == nil {
		t.Fatal("different markdown revision reused original image")
	}
	f.d.bundle.Ledger = []byte(`{bad`)
	if e := verifyImageOccurrence(t.Context(), tx, f.r, occurrence); e == nil {
		t.Fatal("corrupt ledger established original occurrence")
	}
	if _, e := f.s.captureMessage(t.Context(), &operationTx{dao: &mediaRateMissingDAO{}, op: &Operation{}}, f.r, sp.ControllerMessage{}); e == nil {
		t.Fatal("old store accepted image captures")
	}
}

var _ store.SessionResourceDAO = (*captureFailureDAO)(nil)
