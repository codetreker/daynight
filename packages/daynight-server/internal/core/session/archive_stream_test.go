package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type streamTestDAO struct {
	*archiveFlowDAO
	row            store.ArchiveStagingRecord
	finishes       int
	exposeTerminal bool
	releases       int
	allowInsert    bool
	next           *store.ArchiveStagingRecord
	readCalls      int
	changeOnRead   int
	insertErr      error
	readErr        error
	listErr        error
	record         *record
	releaseErr     error
	finishErr      error
	declineFinish  bool
	captures       []store.SessionCaptureRecord
	removed        []store.SessionResourceReference
	resourcesErr   error
}

func (d *streamTestDAO) SessionCaptures(context.Context, string, string, int) ([]store.SessionCaptureRecord, error) {
	return d.captures, nil
}
func (d *streamTestDAO) SessionCaptureByImage(_ context.Context, _ string, image string) (store.SessionCaptureRecord, error) {
	for _, capture := range d.captures {
		if capture.Request.Occurrence.ImageID == image {
			return capture, nil
		}
	}
	return store.SessionCaptureRecord{}, model.ErrNotFound
}
func (d *streamTestDAO) RemoveSessionResourceReference(_ context.Context, ref store.SessionResourceReference) error {
	d.removed = append(d.removed, ref)
	return nil
}
func (d *streamTestDAO) SessionResourceReferenceCount(context.Context, string, string) (int, error) {
	return 1, nil
}
func (d *streamTestDAO) ListSessionResources(ctx context.Context, id string) ([]store.SessionResourceRecord, error) {
	if d.resourcesErr != nil {
		return nil, d.resourcesErr
	}
	return d.archiveFlowDAO.ListSessionResources(ctx, id)
}

func (d *streamTestDAO) ArchiveStagingRecord(_ context.Context, _, id string) (store.ArchiveStagingRecord, error) {
	if d.readErr != nil {
		return store.ArchiveStagingRecord{}, d.readErr
	}
	d.readCalls++
	if d.changeOnRead != 0 && d.readCalls == d.changeOnRead {
		d.row.SHA256 = archiveDigest([]byte("changed"))
	}
	if d.next != nil && id == d.next.FileID {
		return *d.next, nil
	}
	if id != d.row.FileID {
		return store.ArchiveStagingRecord{}, model.ErrNotFound
	}
	return d.row, nil
}
func (d *streamTestDAO) ArchiveStagingRecords(context.Context, string) ([]store.ArchiveStagingRecord, error) {
	if d.listErr != nil {
		return nil, d.listErr
	}
	if d.exposeTerminal {
		return []store.ArchiveStagingRecord{d.row}, nil
	}
	return nil, nil
}
func (d *streamTestDAO) InsertArchiveStaging(_ context.Context, row store.ArchiveStagingRecord) (bool, error) {
	if d.insertErr != nil {
		return false, d.insertErr
	}
	if !d.allowInsert || d.next != nil {
		return false, errors.New("unexpected registration")
	}
	d.next = &row
	return true, nil
}
func (d *streamTestDAO) FinishArchiveStaging(_ context.Context, row store.ArchiveStagingRecord, state string, offset int64, terminal json.RawMessage) (bool, error) {
	if d.finishErr != nil {
		return false, d.finishErr
	}
	if d.declineFinish {
		return false, nil
	}
	if !sameStreamRecord(row, d.row) || d.row.State != "receiving" {
		return false, nil
	}
	d.finishes++
	d.row.State = state
	d.row.TerminalOffset = offset
	d.row.TerminalError = terminal
	return true, nil
}
func (d *streamTestDAO) SetArchiveStagingSuccessor(_ context.Context, row store.ArchiveStagingRecord, id string) (bool, error) {
	if !d.allowInsert || !sameStreamRecord(row, d.row) || d.row.State != "failed" || d.row.SuccessorFileID != "" {
		return false, errors.New("unexpected successor")
	}
	d.row.SuccessorFileID = id
	return true, nil
}
func (d *streamTestDAO) ReleaseArchiveStaging(_ context.Context, row store.ArchiveStagingRecord) (bool, error) {
	if d.releaseErr != nil {
		return false, d.releaseErr
	}
	if !d.exposeTerminal || !sameStreamRecord(row, d.row) || d.row.StagingReleased {
		return false, errors.New("unexpected release")
	}
	d.releases++
	d.row.StagingReleased = true
	return true, nil
}

type streamTestStorage struct {
	filestorage.Storage
	h          *streamTestHandle
	acquireErr error
}

func (s *streamTestStorage) AcquireArchiveStaging(context.Context, sessionarchive.Namespace, bool) (filestorage.ArchiveStaging, error) {
	if s.acquireErr != nil {
		return nil, s.acquireErr
	}
	return s.h, nil
}

type streamTestHandle struct {
	offset         int64
	corrupt        bool
	observeErr     error
	appends        int
	closed         int
	closeErr       error
	deleteFailures int
	deletes        int
	data           []byte
	publications   int
	allowCreate    bool
	creates        int
	createErr      error
	adoptErr       error
	adoptions      int
	publishErr     error
	appendErr      error
	afterDelete    func()
}

func (h *streamTestHandle) Create(context.Context, string) error {
	if h.createErr != nil {
		return h.createErr
	}
	if !h.allowCreate {
		return errors.New("unexpected create")
	}
	h.creates++
	return nil
}
func (h *streamTestHandle) AdoptEmpty(context.Context, string) error {
	if !h.allowCreate {
		return errors.New("unexpected adoption")
	}
	h.adoptions++
	return h.adoptErr
}
func (h *streamTestHandle) Observe(_ context.Context, _ string, _ int64) (int64, error) {
	if h.observeErr != nil {
		return 0, h.observeErr
	}
	if h.corrupt {
		return 0, filestorage.ErrArchiveStagingCorrupt
	}
	return h.offset, nil
}
func (h *streamTestHandle) Append(ctx context.Context, _ string, _ int64, expected int64, b []byte) (int64, error) {
	if h.appendErr != nil {
		return h.offset, h.appendErr
	}
	if err := ctx.Err(); err != nil {
		return h.offset, err
	}
	if expected != h.offset {
		return h.offset, filestorage.ErrArchiveStagingOffset
	}
	h.appends++
	h.data = append(h.data, b...)
	h.offset += int64(len(b))
	return h.offset, nil
}
func (h *streamTestHandle) Open(context.Context, string, int64) (filestorage.Object, error) {
	return filestorage.Object{Body: io.NopCloser(bytes.NewReader(h.data)), Info: filestorage.FileInfo{Size: int64(len(h.data))}}, nil
}
func (h *streamTestHandle) Publish(_ context.Context, _ string, total int64, _, _ string) (filestorage.FileInfo, error) {
	if h.publishErr != nil {
		return filestorage.FileInfo{}, h.publishErr
	}
	if int64(len(h.data)) != total {
		return filestorage.FileInfo{}, io.ErrUnexpectedEOF
	}
	h.publications++
	return filestorage.FileInfo{Size: total}, nil
}
func (h *streamTestHandle) Delete(ctx context.Context, _ string) error {
	h.deletes++
	if err := filestorage.VerifyGates(ctx); err != nil {
		return err
	}
	if h.deleteFailures > 0 {
		h.deleteFailures--
		return errors.New("injected delete failure")
	}
	if h.afterDelete != nil {
		h.afterDelete()
	}
	return nil
}
func (h *streamTestHandle) Close() error { h.closed++; return h.closeErr }

func streamTestFixture(t *testing.T, length int64) (*ArchiveOperation, *streamTestDAO, *streamTestHandle) {
	t.Helper()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	h := &streamTestHandle{}
	engine := NewEngine(&streamTestStorage{Storage: files, h: h})
	owner, id, claim, controller, instance := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	p := model.Principal{Kind: model.PATCredential, UserID: owner}
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	r := &record{Owner: owner, Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Identity: sp.Identity{ControllerID: controller, ControllerInstanceID: instance, Provider: "codex"}, Lifecycle: "archived", HistoryEpoch: "history"}}
	fileID := uuid.NewString()
	row := store.ArchiveStagingRecord{SessionID: id, FileID: fileID, Purpose: "history", SHA256: archiveDigest(bytes.Repeat([]byte("x"), int(length))), ByteLength: length, State: "receiving", Path: "object", TimelineRevision: 1, Resource: json.RawMessage(`null`)}
	base := &archiveFlowDAO{files: map[string]store.ArchiveBundleFile{}, chunks: map[string][]store.ArchiveBundleChunk{}, resources: map[string]store.SessionResourceRecord{}, bundle: &store.ArchiveBundle{SessionID: id, Phase: "settling", HistoryID: fileID, Revision: 1, Identity: encode(sp.ArchivePrepareRequest{Fence: fence, ControllerID: controller, ControllerInstanceID: instance}), Ledger: json.RawMessage(`{}`)}}
	d := &streamTestDAO{archiveFlowDAO: base, row: row, record: r}
	execution := &Execution{Engine: engine}
	execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: d}, record: r})
	}
	engine.SetMediaLeaseCleanup(func(ctx context.Context, id, lease string) error {
		return d.ReleaseSessionResourceLease(ctx, id, lease)
	})
	return &ArchiveOperation{execution: execution, principal: p, id: id, owner: owner, mode: ArchiveV1Upload}, d, h
}

func TestArchiveStreamRetainsOnlyCompleteBlocksOnShortRead(t *testing.T) {
	length := 2*sessionarchive.BlockSize + 100
	op, d, h := streamTestFixture(t, length)
	input := bytes.NewReader(bytes.Repeat([]byte("x"), int(sessionarchive.BlockSize+sessionarchive.BlockSize/2)))
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, length, d.row.SHA256, input)
	if !errors.Is(err, io.ErrUnexpectedEOF) || h.offset != sessionarchive.BlockSize || h.appends != 1 || d.finishes != 0 || d.leases != 0 {
		t.Fatalf("short read: offset=%d appends=%d finishes=%d leases=%d err=%v", h.offset, h.appends, d.finishes, d.leases, err)
	}
}
func TestArchiveStreamRejectsDifferentImmutableIdentityBeforeWriting(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 10, archiveDigest([]byte("different")), bytes.NewReader([]byte("0123456789")))
	if err == nil || h.appends != 0 || d.finishes != 0 || d.leases != 0 {
		t.Fatalf("identity mismatch: %v appends=%d finishes=%d", err, h.appends, d.finishes)
	}
}
func TestArchiveStreamCompleteRecordsCorruptionAndReplaysTerminalReceipt(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	h.corrupt = true
	receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || receipt.State != "failed" || receipt.UploadVersion != 2 || receipt.Error == nil || receipt.Error.Code != "staging_corrupt" || d.finishes != 1 {
		t.Fatalf("complete: %+v finishes=%d err=%v", receipt, d.finishes, err)
	}
	again, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || again.State != "failed" || again.Error == nil || again.Error.Code != "staging_corrupt" || d.finishes != 1 {
		t.Fatalf("replay: %+v finishes=%d err=%v", again, d.finishes, err)
	}
}

type cancelAfterFirstBlock struct {
	cancel context.CancelFunc
	sent   bool
}

func (r *cancelAfterFirstBlock) Read(p []byte) (int, error) {
	if r.sent {
		r.cancel()
		return 0, context.Canceled
	}
	r.sent = true
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func TestArchiveStreamCancellationPreservesConfirmedPrefix(t *testing.T) {
	length := 2 * sessionarchive.BlockSize
	op, d, h := streamTestFixture(t, length)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	_, err := op.PutArchiveFileV2(ctx, "history", d.row.FileID, 0, length, d.row.SHA256, &cancelAfterFirstBlock{cancel: cancel})
	if !errors.Is(err, context.Canceled) || h.offset != sessionarchive.BlockSize || h.appends != 1 || d.finishes != 0 || d.leases != 0 {
		t.Fatalf("cancel: offset=%d appends=%d finishes=%d leases=%d err=%v", h.offset, h.appends, d.finishes, d.leases, err)
	}
}
func TestArchiveStreamStatusReportsCorruptionWithoutWriting(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	h.corrupt = true
	_, err := op.execution.ArchiveFileStatus(t.Context(), op.principal, "", "", op.id, d.row.FileID)
	var corrupt *ArchiveStagingCorruptError
	if !errors.As(err, &corrupt) || corrupt.Receipt.FileID != d.row.FileID || corrupt.Receipt.ByteLength != "10" || corrupt.Receipt.SHA256 != d.row.SHA256 || corrupt.Receipt.UploadVersion != 2 || d.finishes != 0 || d.row.State != "receiving" {
		t.Fatalf("status: error=%v row=%+v", err, d.row)
	}
	if corrupt.Error() != "archive staging is corrupt" {
		t.Fatalf("unexpected corruption diagnostic: %v", corrupt)
	}
}
func TestArchiveStreamRejectsLateWriterAtOldOffset(t *testing.T) {
	op, d, h := streamTestFixture(t, sessionarchive.BlockSize)
	h.offset = sessionarchive.BlockSize
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, d.row.ByteLength, d.row.SHA256, bytes.NewReader(make([]byte, sessionarchive.BlockSize)))
	if err == nil || h.appends != 0 || h.offset != sessionarchive.BlockSize || d.finishes != 0 {
		t.Fatalf("stale offset accepted: offset=%d appends=%d err=%v", h.offset, h.appends, err)
	}
}

func TestArchiveStreamCleanupRetriesOnFollowingSeal(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	d.row.Purpose = "timeline"
	d.row.State = "complete"
	d.row.TerminalOffset = 10
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	d.exposeTerminal = true
	h.deleteFailures = 2
	receipt, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err != nil || receipt.State != "complete" || d.row.StagingReleased || d.releases != 0 {
		t.Fatalf("terminal receipt after cleanup failure: %+v row=%+v err=%v", receipt, d.row, err)
	}
	_, err = op.SealArchive(t.Context())
	if err != nil || d.row.StagingReleased || d.releases != 0 {
		t.Fatalf("failed cleanup changed receipt: row=%+v err=%v", d.row, err)
	}
	_, err = op.SealArchive(t.Context())
	if err != nil || !d.row.StagingReleased || d.releases != 1 {
		t.Fatalf("seal did not retry cleanup: row=%+v releases=%d err=%v", d.row, d.releases, err)
	}
}

func TestArchiveStreamValidatesAndPublishesHistoryOnce(t *testing.T) {
	history := encode(sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	op, d, h := streamTestFixture(t, int64(len(history)))
	d.row.SHA256 = archiveDigest(history)
	receipt, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, int64(len(history)), d.row.SHA256, bytes.NewReader(history))
	if err != nil || receipt.State != "receiving" || receipt.AcceptedOffset != decimal(int64(len(history))) || h.appends != 1 {
		t.Fatalf("put: %+v appends=%d err=%v", receipt, h.appends, err)
	}
	receipt, err = op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || receipt.State != "complete" || d.finishes != 1 || h.publications != 1 {
		t.Fatalf("complete: %+v finishes=%d publications=%d err=%v", receipt, d.finishes, h.publications, err)
	}
	again, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || again.State != "complete" || d.finishes != 1 || h.publications != 1 {
		t.Fatalf("replay: %+v finishes=%d publications=%d err=%v", again, d.finishes, h.publications, err)
	}
}

func TestArchiveStreamCleanupRetriesOnManifestWithOriginalPermit(t *testing.T) {
	timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{}})
	op, d, h := streamTestFixture(t, int64(len(timeline)))
	namespace, err := archiveNamespace("", op.owner, op.id)
	if err != nil {
		t.Fatal(err)
	}
	d.row.Purpose = "timeline"
	d.row.State = "complete"
	d.row.TerminalOffset = int64(len(timeline))
	d.row.ByteLength = int64(len(timeline))
	d.row.SHA256 = archiveDigest(timeline)
	d.row.Path = namespace.Directory() + "/files/" + d.row.FileID
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	d.bundle.Resources = json.RawMessage(`[]`)
	d.exposeTerminal = true
	h.deleteFailures = 1
	if _, err = op.execution.files.Put(t.Context(), archiveBucket, d.row.Path+"/content", bytes.NewReader(timeline)); err != nil {
		t.Fatal(err)
	}
	permit, err := op.execution.files.TryAcquireArchive(t.Context(), op.owner, op.id, 1, false)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	op.permit = permit
	receipt, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err != nil || receipt.State != "complete" || d.row.StagingReleased {
		t.Fatalf("complete: %+v row=%+v err=%v", receipt, d.row, err)
	}
	var identity sp.ArchivePrepareRequest
	if err = json.Unmarshal(d.bundle.Identity, &identity); err != nil {
		t.Fatal(err)
	}
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: op.id, Fence: identity.Fence, Provider: "codex", ControllerID: identity.ControllerID, ControllerInstanceID: identity.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: d.row.FileID, SHA256: d.row.SHA256, ByteLength: decimal(d.row.ByteLength)}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
	status, err := op.PutArchiveManifest(t.Context(), encode(manifest))
	if err != nil || status.State != "ready" || !d.row.StagingReleased || d.releases != 1 {
		t.Fatalf("manifest cleanup retry: status=%+v row=%+v releases=%d err=%v", status, d.row, d.releases, err)
	}
}

func TestArchiveStreamCompleteDoesNotTerminalizeUncertainStorageErrors(t *testing.T) {
	for _, cause := range []error{fs.ErrNotExist, filestorage.ErrPathConflict, filestorage.ErrNotRegular, errors.Join(fs.ErrNotExist, errors.New("volume unavailable"))} {
		t.Run(cause.Error(), func(t *testing.T) {
			op, d, h := streamTestFixture(t, 10)
			h.observeErr = cause
			_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
			if !errors.Is(err, cause) || d.finishes != 0 || d.row.State != "receiving" {
				t.Fatalf("transient error terminalized: err=%v row=%+v finishes=%d", err, d.row, d.finishes)
			}
		})
	}
}
func TestArchiveStreamCompleteRecordsConfirmedMissing(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	h.observeErr = filestorage.ErrArchiveStagingMissing
	receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || receipt.State != "failed" || receipt.Error == nil || receipt.Error.Code != "staging_corrupt" || d.finishes != 1 {
		t.Fatalf("missing: %+v finishes=%d err=%v", receipt, d.finishes, err)
	}
}

func TestArchiveStreamRegistersAfterCreatingStorageAndRejectsDisabledCreation(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(decimal(int64(map[bool]int{false: 0, true: 1}[enabled])), func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			op.execution.SetArchiveV2RegistrationEnabled(enabled)
			d.allowInsert = true
			h.allowCreate = true
			d.bundle.HistoryID = ""
			id := uuid.NewString()
			data := []byte("data")
			receipt, err := op.PutArchiveFileV2(t.Context(), "history", id, 0, 4, archiveDigest(data), bytes.NewReader(data))
			if !enabled {
				if err == nil || h.creates != 0 || d.next != nil {
					t.Fatalf("disabled registration: err=%v creates=%d", err, h.creates)
				}
				return
			}
			if err != nil || h.creates != 1 || d.next == nil || d.next.FileID != id || d.bundle.HistoryID != id || receipt.AcceptedOffset != "4" || h.appends != 1 {
				t.Fatalf("registration: receipt=%+v next=%+v creates=%d err=%v", receipt, d.next, h.creates, err)
			}
		})
	}
}
func TestArchiveStreamRestartPreservesOriginalReceiptAndIdentity(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	d.row.State = "failed"
	d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt", Message: "Archive staging is corrupt."})
	d.allowInsert = true
	h.allowCreate = true
	replacement := uuid.NewString()
	receipt, err := op.RestartArchiveFile(t.Context(), "history", d.row.FileID, replacement)
	if err != nil || receipt.State != "failed" || receipt.SuccessorFileID == nil || *receipt.SuccessorFileID != replacement || d.next == nil || d.next.SHA256 != d.row.SHA256 || d.next.TimelineRevision != d.row.TimelineRevision || d.bundle.HistoryID != replacement || h.creates != 1 {
		t.Fatalf("restart: receipt=%+v next=%+v err=%v", receipt, d.next, err)
	}
	receipt, err = op.RestartArchiveFile(t.Context(), "history", d.row.FileID, replacement)
	if err != nil || receipt.SuccessorFileID == nil || *receipt.SuccessorFileID != replacement || h.creates != 1 {
		t.Fatalf("restart replay: %+v creates=%d err=%v", receipt, h.creates, err)
	}
	if _, err = op.RestartArchiveFile(t.Context(), "history", d.row.FileID, uuid.NewString()); err == nil {
		t.Fatal("accepted different successor")
	}
}
func TestArchiveStreamRejectsHashMismatchBeforePublication(t *testing.T) {
	op, d, h := streamTestFixture(t, 10)
	h.offset = 10
	h.data = []byte("0123456789")
	receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || receipt.State != "failed" || receipt.Error == nil || receipt.Error.Code != "staging_corrupt" || h.publications != 0 || d.finishes != 1 {
		t.Fatalf("hash mismatch: %+v publications=%d err=%v", receipt, h.publications, err)
	}
}
func TestArchiveStreamRejectsInvalidBusinessContentBeforePublication(t *testing.T) {
	data := []byte("invalid")
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.SHA256 = archiveDigest(data)
	h.offset = int64(len(data))
	h.data = data
	_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err == nil || d.row.State != "failed" || h.publications != 0 || d.finishes != 1 {
		t.Fatalf("invalid content: state=%s publications=%d finishes=%d err=%v", d.row.State, h.publications, d.finishes, err)
	}
}

func TestArchiveStreamResourceCannotBypassCorruptSuccessor(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	d.exposeTerminal = true
	length, hash, mime := "4", archiveDigest([]byte("data")), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.row.Purpose = "resource"
	d.row.State = "failed"
	d.row.SHA256 = hash
	d.row.Resource = encode(resource)
	d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	if _, err := op.PutArchiveResourceV2(t.Context(), uuid.NewString(), 0, 4, hash, bytes.NewReader([]byte("data")), resource); err == nil {
		t.Fatal("v2 bypassed original successor")
	}
	if _, err := op.PutArchiveResource(t.Context(), uuid.NewString(), 0, 4, hash, hash, []byte("data"), resource); err == nil {
		t.Fatal("v1 bypassed original successor")
	}
	if h.creates != 0 || d.next != nil || d.leases != 0 {
		t.Fatalf("unexpected registration: creates=%d next=%+v leases=%d", h.creates, d.next, d.leases)
	}
}

func TestArchiveStreamResourceAllowsRetryAfterBusinessFailure(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	d.exposeTerminal = true
	length, hash, mime := "4", archiveDigest([]byte("data")), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.row.Purpose = "resource"
	d.row.State = "failed"
	d.row.Resource = encode(resource)
	d.row.TerminalError = encode(sp.ImageError{Code: "quota_exceeded"})
	d.row.TimelineRevision = 1
	d.bundle.Revision = 2
	if err := archiveStreamResourceUnregistered(t.Context(), d, op.id, &resource, false); err != nil {
		t.Fatalf("business failure blocked later revision: %v", err)
	}
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	receipt, err := op.PutArchiveResource(t.Context(), uuid.NewString(), 0, 4, hash, hash, []byte("data"), resource)
	if err != nil || receipt.State != "complete" {
		t.Fatalf("v1 retry after business failure: %+v %v", receipt, err)
	}
	d.row.State = "receiving"
	if err := archiveStreamResourceUnregistered(t.Context(), d, op.id, &resource, false); err == nil {
		t.Fatal("concurrent receiving identity accepted")
	}
	d.row.State = "failed"
	d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
	d.row.SuccessorFileID = uuid.NewString()
	if err := archiveStreamResourceUnregistered(t.Context(), d, op.id, &resource, false); err != nil {
		t.Fatalf("settled corrupt predecessor blocked later retry: %v", err)
	}
}

func TestArchiveStreamResourcePreservesCompletedIdentity(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	d.exposeTerminal = true
	length, hash, mime := "4", archiveDigest([]byte("data")), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.row.Purpose = "resource"
	d.row.State = "complete"
	d.row.SHA256 = hash
	d.row.Resource = encode(resource)
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	if _, err := op.PutArchiveResourceV2(t.Context(), uuid.NewString(), 0, 4, hash, bytes.NewReader([]byte("data")), resource); err == nil {
		t.Fatal("v2 replaced completed identity")
	}
	if _, err := op.PutArchiveResource(t.Context(), uuid.NewString(), 0, 4, hash, hash, []byte("data"), resource); err == nil {
		t.Fatal("v1 replaced completed identity")
	}
	if h.creates != 0 || d.next != nil {
		t.Fatalf("unexpected registration: creates=%d next=%+v", h.creates, d.next)
	}
}
func TestArchiveStreamResourcePreservesInflightV1Identity(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	length, hash, mime := "4", archiveDigest([]byte("data")), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	id := uuid.NewString()
	path, err := BlobAddress("", op.owner, op.id, id)
	if err != nil {
		t.Fatal(err)
	}
	d.files[id] = store.ArchiveBundleFile{SessionID: op.id, FileID: id, Purpose: "resource", SHA256: hash, ByteLength: 4, State: "receiving", Path: path, TimelineRevision: d.bundle.Revision, Resource: encode(resource)}
	if _, err = op.PutArchiveResourceV2(t.Context(), uuid.NewString(), 0, 4, hash, bytes.NewReader([]byte("data")), resource); err == nil {
		t.Fatal("v2 replaced in-flight v1 identity")
	}
	receipt, err := op.PutArchiveResource(t.Context(), id, 0, 4, hash, hash, []byte("data"), resource)
	if err != nil || receipt.State != "complete" {
		t.Fatalf("original v1 resume: %+v %v", receipt, err)
	}
}

func TestArchiveStreamPreservesLegacyResourceRegistration(t *testing.T) {
	op, d, _ := streamTestFixture(t, 6)
	length, hash, mime := "6", archiveDigest([]byte("abcdef")), "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	oldID := uuid.NewString()
	path, err := BlobAddress("", op.owner, op.id, oldID)
	if err != nil {
		t.Fatal(err)
	}
	d.files[oldID] = store.ArchiveBundleFile{SessionID: op.id, FileID: oldID, Purpose: "resource", SHA256: hash, ByteLength: 6, State: "receiving", Path: path, TimelineRevision: d.bundle.Revision, Resource: encode(resource)}
	newID := uuid.NewString()
	receipt, err := op.PutArchiveResource(t.Context(), newID, 0, 6, hash, archiveDigest([]byte("abc")), []byte("abc"), resource)
	if err != nil || receipt.State != "receiving" || receipt.AcceptedOffset != "3" || d.files[oldID].State != "receiving" {
		t.Fatalf("legacy registration changed: %+v err=%v", receipt, err)
	}
}

func TestArchiveStreamCorruptionAndCloseFailureRetainCleanupUnknown(t *testing.T) {
	for _, operation := range []string{"status", "put"} {
		t.Run(operation, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			h.corrupt = true
			h.closeErr = errors.New("staging close failed")
			var err error
			if operation == "status" {
				_, err = op.execution.ArchiveFileStatus(t.Context(), op.principal, "", "", op.id, d.row.FileID)
			} else {
				_, err = op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx")))
			}
			var fault *model.Fault
			var observed *ArchiveStagingCorruptError
			if !errors.As(err, &fault) || fault.Code != "cleanup_unknown" || !errors.Is(err, h.closeErr) || !errors.As(err, &observed) || d.finishes != 0 {
				t.Fatalf("cleanup failure lost: %v", err)
			}
		})
	}
}

func TestArchiveStreamCompleteDoesNotCleanAfterUncertainClose(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	h.corrupt = true
	h.closeErr = errors.New("staging close failed")
	d.exposeTerminal = true
	_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "cleanup_unknown" || !errors.Is(err, h.closeErr) || d.row.State != "failed" || d.row.StagingReleased || h.deletes != 0 {
		t.Fatalf("close failure cleanup: err=%v row=%+v deletes=%d", err, d.row, h.deletes)
	}
}

func TestArchiveStreamPublishesMigrationResourceAndReplays(t *testing.T) {
	for _, data := range [][]byte{[]byte("data"), {}} {
		t.Run(decimal(int64(len(data))), func(t *testing.T) {
			op, d, h := streamTestFixture(t, int64(len(data)))
			hash := archiveDigest(data)
			length := decimal(int64(len(data)))
			mime := "text/plain"
			resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			d.row.Purpose = "resource"
			d.row.SHA256 = hash
			d.row.Resource = encode(resource)
			path, err := BlobAddress("", op.owner, op.id, d.row.FileID)
			if err != nil {
				t.Fatal(err)
			}
			d.row.Path = path
			d.bundle.HistoryID = uuid.NewString()
			d.bundle.Ledger = encode(archiveLedger{HistoryID: d.bundle.HistoryID, Resources: []sp.Resource{resource}})
			receipt, err := op.PutArchiveResourceV2(t.Context(), d.row.FileID, 0, int64(len(data)), hash, bytes.NewReader(data), resource)
			if err != nil || receipt.State != "receiving" || receipt.AcceptedOffset != length {
				t.Fatalf("put: %+v %v", receipt, err)
			}
			receipt, err = op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
			if err != nil || receipt.State != "complete" || d.finishes != 1 || h.publications != 1 || d.resources[resource.ResourceID].BlobID != d.row.FileID {
				t.Fatalf("complete: %+v finishes=%d publications=%d err=%v", receipt, d.finishes, h.publications, err)
			}
		})
	}
}
func TestArchiveStreamPublishesTimelineOnlyWhenLedgerMatches(t *testing.T) {
	timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{}})
	op, d, h := streamTestFixture(t, int64(len(timeline)))
	d.row.Purpose = "timeline"
	d.row.SHA256 = archiveDigest(timeline)
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}}, "history", 0)
	if err != nil {
		t.Fatal(err)
	}
	d.bundle.Ledger = encode(ledger)
	receipt, err := op.PutArchiveFileV2(t.Context(), "timeline", d.row.FileID, 0, d.row.ByteLength, d.row.SHA256, bytes.NewReader(timeline))
	if err != nil || receipt.State != "receiving" {
		t.Fatalf("put: %+v %v", receipt, err)
	}
	receipt, err = op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err != nil || receipt.State != "complete" || h.publications != 1 || d.finishes != 1 {
		t.Fatalf("complete: %+v publications=%d err=%v", receipt, h.publications, err)
	}
}

func TestArchiveStreamRechecksIdentityAfterPhysicalExclusion(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	d.changeOnRead = 2
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx")))
	if err == nil || h.appends != 0 || d.finishes != 0 || d.leases != 0 {
		t.Fatalf("changed identity accepted: err=%v appends=%d leases=%d", err, h.appends, d.leases)
	}
}
func TestArchiveStreamAdoptsOnlyAnEmptyUnregisteredObject(t *testing.T) {
	for _, adoptError := range []error{nil, filestorage.ErrArchiveStagingOffset} {
		t.Run(decimal(int64(map[bool]int{false: 0, true: 1}[adoptError != nil])), func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			op.execution.SetArchiveV2RegistrationEnabled(true)
			d.allowInsert = true
			h.allowCreate = true
			h.createErr = fs.ErrExist
			h.adoptErr = adoptError
			d.bundle.HistoryID = ""
			_, err := op.PutArchiveFileV2(t.Context(), "history", uuid.NewString(), 0, 4, archiveDigest([]byte("data")), bytes.NewReader([]byte("data")))
			if adoptError != nil {
				if !errors.Is(err, adoptError) || d.next != nil || h.appends != 0 {
					t.Fatalf("nonempty adoption: err=%v next=%+v", err, d.next)
				}
				return
			}
			if err != nil || h.adoptions != 1 || d.next == nil || h.appends != 1 {
				t.Fatalf("empty adoption: err=%v adoptions=%d next=%+v", err, h.adoptions, d.next)
			}
		})
	}
}
func TestArchiveStreamUnknownRegistrationDoesNotWriteBytes(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	d.bundle.HistoryID = ""
	failure := errors.New("registration outcome unknown")
	d.insertErr = failure
	_, err := op.PutArchiveFileV2(t.Context(), "history", uuid.NewString(), 0, 4, archiveDigest([]byte("data")), bytes.NewReader([]byte("data")))
	if !errors.Is(err, failure) || h.creates != 1 || h.appends != 0 || d.next != nil {
		t.Fatalf("unknown registration: err=%v creates=%d appends=%d", err, h.creates, h.appends)
	}
}
func TestArchiveStreamUnknownPublicationKeepsOriginalIntent(t *testing.T) {
	history := encode(sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	op, d, h := streamTestFixture(t, int64(len(history)))
	d.row.SHA256 = archiveDigest(history)
	h.data = history
	h.offset = int64(len(history))
	failure := errors.New("publication result unknown")
	h.publishErr = &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: failure}
	_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if !errors.Is(err, failure) || d.row.State != "receiving" || d.finishes != 0 {
		t.Fatalf("unknown publication: err=%v row=%+v", err, d.row)
	}
	h.publishErr = nil
	receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err != nil || receipt.State != "complete" || d.finishes != 1 {
		t.Fatalf("reconciled completion: %+v %v", receipt, err)
	}
}

func TestArchiveStreamBusyPhysicalLockIsRetryableAndDoesNotMutate(t *testing.T) {
	for _, operation := range []string{"status", "put", "complete", "restart"} {
		t.Run(operation, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			op.execution.files.(*streamTestStorage).acquireErr = filestorage.ErrGateBusy
			var err error
			switch operation {
			case "status":
				_, err = op.execution.ArchiveFileStatus(t.Context(), op.principal, "", "", op.id, d.row.FileID)
			case "put":
				_, err = op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx")))
			case "complete":
				_, err = op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
			case "restart":
				d.row.State = "failed"
				d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
				_, err = op.RestartArchiveFile(t.Context(), "history", d.row.FileID, uuid.NewString())
			}
			var capacity *ArchiveCapacityError
			if !errors.As(err, &capacity) || !errors.Is(err, filestorage.ErrGateBusy) || d.finishes != 0 || h.appends != 0 || d.leases != 0 {
				t.Fatalf("busy lock: error=%v finishes=%d appends=%d leases=%d", err, d.finishes, h.appends, d.leases)
			}
		})
	}
}
func TestArchiveStreamRejectsInvalidFrozenIdentityBeforeIO(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	for _, test := range []struct {
		name, purpose, id, digest string
		offset, length            int64
	}{
		{"wrong purpose", "other", d.row.FileID, d.row.SHA256, 0, 4},
		{"noncanonical file", "history", "bad-id", d.row.SHA256, 0, 4},
		{"malformed hash", "history", d.row.FileID, "BAD", 0, 4},
		{"negative offset", "history", d.row.FileID, d.row.SHA256, -1, 4},
		{"offset beyond total", "history", d.row.FileID, d.row.SHA256, 5, 4},
		{"empty history", "history", d.row.FileID, archiveDigest(nil), 0, 0},
		{"incomplete block boundary", "history", d.row.FileID, d.row.SHA256, 1, 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := op.PutArchiveFileV2(t.Context(), test.purpose, test.id, test.offset, test.length, test.digest, bytes.NewReader([]byte("xxxx"))); err == nil {
				t.Fatal("invalid identity accepted")
			}
			if h.appends != 0 || d.leases != 0 || d.finishes != 0 {
				t.Fatalf("invalid request reached I/O: appends=%d leases=%d", h.appends, d.leases)
			}
		})
	}
}

func TestArchiveStreamResetRetainsCorruptIdentityAndAcceptsBusinessFailure(t *testing.T) {
	for _, code := range []string{"staging_corrupt", "archive_incomplete"} {
		t.Run(code, func(t *testing.T) {
			_, d, _ := streamTestFixture(t, 4)
			d.row.Purpose = "timeline"
			d.row.State = "failed"
			d.row.TerminalError = encode(sp.ImageError{Code: code})
			d.exposeTerminal = true
			d.bundle.TimelineID = d.row.FileID
			d.bundle.Phase = "failed"
			d.bundle.Resources = json.RawMessage(`[]`)
			err := resetArchivePreparation(t.Context(), &operationTx{dao: d}, d, d.bundle, sp.ArchivePrepareRequest{ExpectedTimelineRevision: "1", FailedFileID: d.row.FileID})
			if code == "staging_corrupt" {
				if err == nil || d.bundle.Revision != 1 || d.bundle.TimelineID != d.row.FileID {
					t.Fatalf("corrupt reset: bundle=%+v err=%v", d.bundle, err)
				}
				return
			}
			if err != nil || d.bundle.Revision != 2 || d.bundle.TimelineID != "" || d.bundle.Phase != "settling" {
				t.Fatalf("business reset: bundle=%+v err=%v", d.bundle, err)
			}
		})
	}
}
func TestArchiveStreamRegistrationReadErrorsAreNotTreatedAsAbsence(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	failure := errors.New("staging query unavailable")
	d.readErr = failure
	_, err := archiveFileAny(t.Context(), d, op.id, d.row.FileID)
	if !errors.Is(err, failure) {
		t.Fatalf("file query: %v", err)
	}
	d.readErr = nil
	d.listErr = failure
	_, err = archiveFilesAny(t.Context(), d, op.id)
	if !errors.Is(err, failure) {
		t.Fatalf("list query: %v", err)
	}
	if _, err = archiveStagingDAO(d.archiveFlowDAO); err == nil {
		t.Fatal("legacy DAO falsely claimed staging capability")
	}
}
func TestArchiveStreamResourceMustMatchLedger(t *testing.T) {
	_, d, _ := streamTestFixture(t, 4)
	raw := encode(sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable"})
	for _, tc := range []struct {
		name   string
		ledger json.RawMessage
		want   bool
	}{
		{"matching", encode(archiveLedger{Resources: []sp.Resource{{ResourceID: uuid.NewString(), Status: "unavailable"}}}), false},
		{"missing", encode(archiveLedger{}), false},
		{"malformed", json.RawMessage(`{`), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d.bundle.Ledger = tc.ledger
			if got := archiveResourceInLedger(*d.bundle, raw); got != tc.want {
				t.Fatalf("match=%t", got)
			}
		})
	}
	var resource sp.Resource
	if err := json.Unmarshal(raw, &resource); err != nil {
		t.Fatal(err)
	}
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
	if !archiveResourceInLedger(*d.bundle, raw) {
		t.Fatal("matching descriptor not recognized")
	}
}

func TestArchiveStreamRestartPreservesTimelineAndResourceClosure(t *testing.T) {
	for _, purpose := range []string{"timeline", "resource"} {
		t.Run(purpose, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			d.row.State = "failed"
			d.row.Purpose = purpose
			d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
			d.allowInsert = true
			h.allowCreate = true
			if purpose == "timeline" {
				d.bundle.Phase = "sealed"
				d.bundle.TimelineID = d.row.FileID
			} else {
				length, hash, mime := "4", d.row.SHA256, "text/plain"
				resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
				d.row.Resource = encode(resource)
				d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
			}
			replacement := uuid.NewString()
			receipt, err := op.RestartArchiveFile(t.Context(), "timeline", d.row.FileID, replacement)
			if err != nil || receipt.SuccessorFileID == nil || *receipt.SuccessorFileID != replacement || d.next == nil || d.next.Purpose != purpose || d.next.TimelineRevision != d.row.TimelineRevision || !jsonEqual(d.next.Resource, d.row.Resource) {
				t.Fatalf("restart: receipt=%+v next=%+v err=%v", receipt, d.next, err)
			}
			if purpose == "timeline" && d.bundle.TimelineID != replacement {
				t.Fatalf("timeline not switched: %+v", d.bundle)
			}
			if purpose == "resource" {
				want, e := BlobAddress("", op.owner, op.id, replacement)
				if e != nil || d.next.Path != want {
					t.Fatalf("resource successor path %q, want %q (%v)", d.next.Path, want, e)
				}
			}
		})
	}
}
func TestArchiveStreamRestartRejectsChangedOrUnsettledOriginal(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*streamTestDAO, *streamTestHandle)
	}{
		{"receiving", func(d *streamTestDAO, _ *streamTestHandle) { d.row.State = "receiving" }},
		{"wrong failure", func(d *streamTestDAO, _ *streamTestHandle) {
			d.row.TerminalError = encode(sp.ImageError{Code: "archive_incomplete"})
		}},
		{"changed after lock", func(d *streamTestDAO, _ *streamTestHandle) { d.changeOnRead = 2 }},
		{"creation fails", func(_ *streamTestDAO, h *streamTestHandle) { h.createErr = errors.New("create unavailable") }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			d.row.State = "failed"
			d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
			d.allowInsert = true
			h.allowCreate = true
			tc.mutate(d, h)
			if _, err := op.RestartArchiveFile(t.Context(), "history", d.row.FileID, uuid.NewString()); err == nil {
				t.Fatal("invalid successor accepted")
			}
			if d.next != nil || d.row.SuccessorFileID != "" || d.leases != 0 {
				t.Fatalf("restart mutated identity: row=%+v next=%+v leases=%d", d.row, d.next, d.leases)
			}
		})
	}
}
func TestArchiveStreamReturnsNonBusyStorageFailure(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	failure := errors.New("storage unavailable")
	op.execution.files.(*streamTestStorage).acquireErr = failure
	_, err := op.execution.ArchiveFileStatus(t.Context(), op.principal, "", "", op.id, d.row.FileID)
	if !errors.Is(err, failure) {
		t.Fatalf("storage error lost: %v", err)
	}
}
func TestArchiveStreamRejectsMissingLedgerResource(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	length, hash, mime := "4", d.row.SHA256, "text/plain"
	resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
	d.row.Purpose = "resource"
	d.row.Resource = encode(resource)
	d.bundle.HistoryID = uuid.NewString()
	d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{}})
	if _, err := op.PutArchiveResourceV2(t.Context(), d.row.FileID, 0, 4, hash, bytes.NewReader([]byte("xxxx")), resource); err == nil || h.appends != 0 {
		t.Fatalf("unlisted resource accepted: %v", err)
	}
}

func TestArchiveStreamTimelineBusinessFailureRetainsOriginalFailurePath(t *testing.T) {
	data := []byte("invalid")
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.Purpose = "timeline"
	d.row.SHA256 = archiveDigest(data)
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	h.data = data
	h.offset = int64(len(data))
	_, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err == nil || d.row.State != "failed" || d.bundle.Phase != "failed" || h.publications != 0 || d.finishes != 1 {
		t.Fatalf("invalid timeline: err=%v row=%+v phase=%s", err, d.row, d.bundle.Phase)
	}
	var reason sp.ImageError
	if e := json.Unmarshal(d.row.TerminalError, &reason); e != nil || reason.Code != "archive_incomplete" {
		t.Fatalf("wrong terminal error: %+v %v", reason, e)
	}
}
func TestArchiveStreamFailureDoesNotReplaceChangedIdentity(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	original := d.row
	d.row.SHA256 = archiveDigest([]byte("changed"))
	if err := op.failArchiveStream(t.Context(), original, "staging_corrupt", "Archive staging is corrupt.", 0); err == nil || d.finishes != 0 || d.row.State != "receiving" {
		t.Fatalf("changed identity terminalized: err=%v row=%+v", err, d.row)
	}
}

func TestArchiveStreamHistoryChecksFrozenSourceAndPolicy(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*streamTestDAO, *sp.ArchiveHistoryContent)
	}{
		{"source epoch changed", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) {
			d.row.Resource = encode(historySourceIdentity{SourceEpoch: "stale"})
		}},
		{"history epoch changed", func(_ *streamTestDAO, h *sp.ArchiveHistoryContent) { h.HistoryEpoch = "different" }},
		{"source offset changed", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) { d.record.SourceSeq = 2 }},
		{"content policy changed", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) {
			policy := "task_body"
			d.record.HistoryContentPolicy = &policy
		}},
		{"prior target source epoch", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) {
			d.bundle.Ledger = encode(archiveLedger{TargetSourceEpoch: "changed"})
		}},
		{"previous policy mismatch", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) {
			d.bundle.Ledger = encode(archiveLedger{HistoryID: uuid.NewString(), ContentPolicy: "task_body"})
		}},
		{"previous revision not advanced", func(d *streamTestDAO, _ *sp.ArchiveHistoryContent) {
			d.bundle.Revision = 2
			d.row.TimelineRevision = 2
			d.bundle.Ledger = encode(archiveLedger{HistoryID: uuid.NewString(), HistoryEpoch: "history", SourceThrough: "0", Entries: []archiveLedgerEntry{}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content := sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}}
			op, d, h := streamTestFixture(t, 1)
			tc.mutate(d, &content)
			data := encode(content)
			d.row.ByteLength = int64(len(data))
			d.row.SHA256 = archiveDigest(data)
			h.offset = int64(len(data))
			h.data = data
			_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
			if err == nil || d.row.State != "failed" || h.publications != 0 || d.finishes != 1 {
				t.Fatalf("history identity accepted: err=%v state=%s publications=%d", err, d.row.State, h.publications)
			}
		})
	}
}

func TestArchiveStreamRegistersAfterCompletedHistory(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	oldID := uuid.NewString()
	d.bundle.HistoryID = oldID
	d.files[oldID] = store.ArchiveBundleFile{SessionID: op.id, FileID: oldID, Purpose: "history", State: "complete", TimelineRevision: 1}
	id := uuid.NewString()
	receipt, err := op.PutArchiveFileV2(t.Context(), "history", id, 0, 4, archiveDigest([]byte("data")), bytes.NewReader([]byte("data")))
	if err != nil || receipt.State != "receiving" || d.bundle.Revision != 2 || d.bundle.HistoryID != id || d.next == nil || d.next.TimelineRevision != 2 {
		t.Fatalf("history registration: receipt=%+v bundle=%+v err=%v", receipt, d.bundle, err)
	}
}
func TestArchiveStreamRegistersTimelineAndResourceIdentities(t *testing.T) {
	for _, purpose := range []string{"timeline", "resource"} {
		t.Run(purpose, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			op.execution.SetArchiveV2RegistrationEnabled(true)
			d.allowInsert = true
			h.allowCreate = true
			id := uuid.NewString()
			data := []byte("data")
			hash := archiveDigest(data)
			var receipt sp.ArchiveFileReceipt
			var err error
			if purpose == "timeline" {
				d.bundle.Phase = "sealed"
				d.bundle.TimelineID = ""
				receipt, err = op.PutArchiveFileV2(t.Context(), purpose, id, 0, 4, hash, bytes.NewReader(data))
			} else {
				length, mime := "4", "text/plain"
				resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
				d.bundle.Ledger = encode(archiveLedger{Resources: []sp.Resource{resource}})
				receipt, err = op.PutArchiveResourceV2(t.Context(), id, 0, 4, hash, bytes.NewReader(data), resource)
			}
			if err != nil || receipt.State != "receiving" || d.next == nil || d.next.Purpose != purpose || h.appends != 1 {
				t.Fatalf("registration: receipt=%+v next=%+v err=%v", receipt, d.next, err)
			}
			if purpose == "timeline" && d.bundle.TimelineID != id {
				t.Fatal("timeline identity was not attached")
			}
			if purpose == "resource" {
				want, e := BlobAddress("", op.owner, op.id, id)
				if e != nil || d.next.Path != want {
					t.Fatalf("resource path=%q want=%q err=%v", d.next.Path, want, e)
				}
			}
		})
	}
}
func TestArchiveStreamKeepsRecoverablePrefixAfterAppendFailureOrExcess(t *testing.T) {
	t.Run("append failure", func(t *testing.T) {
		op, d, h := streamTestFixture(t, 4)
		failure := errors.New("sync failed")
		h.appendErr = failure
		if _, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx"))); !errors.Is(err, failure) || d.finishes != 0 || h.offset != 0 {
			t.Fatalf("append failure: err=%v offset=%d", err, h.offset)
		}
	})
	t.Run("excess body", func(t *testing.T) {
		op, d, h := streamTestFixture(t, 4)
		if _, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxxx"))); err == nil || d.finishes != 0 || h.offset != 4 {
			t.Fatalf("excess body: err=%v offset=%d", err, h.offset)
		}
	})
}

func TestArchiveStreamCleanupPreservesPendingResponsibilityOnFailure(t *testing.T) {
	for _, tc := range []struct {
		name      string
		configure func(*ArchiveOperation, *streamTestDAO, *streamTestHandle)
	}{
		{"registration list", func(_ *ArchiveOperation, d *streamTestDAO, _ *streamTestHandle) {
			d.listErr = errors.New("list unavailable")
		}},
		{"physical lock", func(op *ArchiveOperation, _ *streamTestDAO, _ *streamTestHandle) {
			op.execution.files.(*streamTestStorage).acquireErr = filestorage.ErrGateBusy
		}},
		{"active writer", func(_ *ArchiveOperation, d *streamTestDAO, _ *streamTestHandle) {
			d.leaseRows = map[string]store.SessionResourceLease{"active": {Kind: "archive"}}
		}},
		{"delete", func(_ *ArchiveOperation, _ *streamTestDAO, h *streamTestHandle) { h.deleteFailures = 1 }},
		{"identity changed", func(_ *ArchiveOperation, d *streamTestDAO, h *streamTestHandle) {
			h.afterDelete = func() { d.row.SHA256 = archiveDigest([]byte("different")) }
		}},
		{"release receipt", func(_ *ArchiveOperation, d *streamTestDAO, _ *streamTestHandle) {
			d.releaseErr = errors.New("release unavailable")
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			d.row.Purpose = "timeline"
			d.row.State = "complete"
			d.row.TerminalOffset = 4
			d.exposeTerminal = true
			d.bundle.Phase = "sealed"
			d.bundle.TimelineID = d.row.FileID
			tc.configure(op, d, h)
			if err := op.cleanupArchiveStreamTerminal(t.Context()); err == nil || d.row.StagingReleased || d.releases != 0 {
				t.Fatalf("cleanup lost obligation: err=%v row=%+v releases=%d", err, d.row, d.releases)
			}
		})
	}
}

func TestArchiveStreamCorruptionDoesNotInventTerminalReceipt(t *testing.T) {
	for _, decline := range []bool{false, true} {
		t.Run(decimal(int64(map[bool]int{false: 0, true: 1}[decline])), func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			h.corrupt = true
			failure := errors.New("terminal write unavailable")
			if decline {
				d.declineFinish = true
			} else {
				d.finishErr = failure
			}
			receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
			if err == nil || (!decline && !errors.Is(err, failure)) || receipt.State == "failed" || d.row.State != "receiving" || d.finishes != 0 {
				t.Fatalf("terminal receipt invented: receipt=%+v row=%+v err=%v", receipt, d.row, err)
			}
		})
	}
}

func TestArchiveStreamRestartAdoptionAndUnknownRegistration(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(decimal(int64(map[bool]int{false: 0, true: 1}[unknown])), func(t *testing.T) {
			op, d, h := streamTestFixture(t, 4)
			d.row.State = "failed"
			d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
			d.allowInsert = true
			h.allowCreate = true
			h.createErr = fs.ErrExist
			failure := errors.New("successor registration result unknown")
			if unknown {
				d.insertErr = failure
			}
			replacement := uuid.NewString()
			receipt, err := op.RestartArchiveFile(t.Context(), "history", d.row.FileID, replacement)
			if unknown {
				if !errors.Is(err, failure) || d.next != nil || d.row.SuccessorFileID != "" {
					t.Fatalf("unknown registration: err=%v row=%+v", err, d.row)
				}
				return
			}
			if err != nil || h.adoptions != 1 || d.next == nil || receipt.SuccessorFileID == nil || *receipt.SuccessorFileID != replacement {
				t.Fatalf("adopted successor: receipt=%+v err=%v", receipt, err)
			}
		})
	}
}

func TestArchiveStreamPrevalidationPreservesOnlinePinsUntilPublication(t *testing.T) {
	for _, outcome := range []string{"not-published", "unknown", "published"} {
		t.Run(outcome, func(t *testing.T) {
			content := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}}
			data := encode(content)
			op, d, h := streamTestFixture(t, int64(len(data)))
			d.row.SHA256 = archiveDigest(data)
			h.data = data
			h.offset = int64(len(data))
			policy := "task_body"
			d.record.HistoryContentPolicy = &policy
			d.bundle.Ledger = encode(archiveLedger{StoppedContentPolicy: policy, WithoutActiveBundle: true})
			originalLedger := append([]byte(nil), d.bundle.Ledger...)
			resource := uuid.NewString()
			position := sp.ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "reasoning", SourceKey: "image"}
			d.captures = []store.SessionCaptureRecord{{Request: sp.ImageCaptureRequest{CaptureID: uuid.NewString(), Occurrence: position}, Receipt: sp.ImageCaptureReceipt{State: "committed", ResourceID: &resource}}}
			failure := errors.New("publication failed")
			if outcome != "published" {
				publication := filestorage.NotPublished
				if outcome == "unknown" {
					publication = filestorage.PublicationUnknown
				}
				h.publishErr = &filestorage.PublicationError{Outcome: publication, Cause: failure}
			}
			_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
			if outcome != "published" {
				if !errors.Is(err, failure) || len(d.removed) != 0 || d.row.State != "receiving" || !bytes.Equal(d.bundle.Ledger, originalLedger) {
					t.Fatalf("publication failure lost pin: err=%v removed=%+v row=%+v", err, d.removed, d.row)
				}
				return
			}
			if err != nil || len(d.removed) != 1 || d.removed[0].ResourceID != resource || d.row.State != "complete" {
				t.Fatalf("commit did not retire pin: err=%v removed=%+v row=%+v", err, d.removed, d.row)
			}
		})
	}
}

func TestArchiveStreamRejectsRegistrationWhilePreviousHistoryHasWriter(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	oldID := uuid.NewString()
	d.bundle.HistoryID = oldID
	d.files[oldID] = store.ArchiveBundleFile{SessionID: op.id, FileID: oldID, Purpose: "history", State: "complete", TimelineRevision: 1}
	d.leases = 1
	_, err := op.PutArchiveFileV2(t.Context(), "history", uuid.NewString(), 0, 4, archiveDigest([]byte("data")), bytes.NewReader([]byte("data")))
	if err == nil || h.creates != 0 || d.next != nil || d.bundle.Revision != 1 {
		t.Fatalf("writer race: err=%v bundle=%+v", err, d.bundle)
	}
}
func TestArchiveStreamPutReportsMissingObjectWithoutTerminalizing(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	op.execution.files.(*streamTestStorage).acquireErr = filestorage.ErrArchiveStagingMissing
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx")))
	var observation *ArchiveStagingCorruptError
	if !errors.As(err, &observation) || observation.Receipt.FileID != d.row.FileID || d.row.State != "receiving" || d.finishes != 0 {
		t.Fatalf("missing observation: err=%v row=%+v", err, d.row)
	}
}
func TestArchiveStreamRejectsInvalidRestartIdentityBeforeIO(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	d.row.State = "failed"
	d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
	for _, id := range []string{"invalid", d.row.FileID} {
		if _, err := op.RestartArchiveFile(t.Context(), "history", d.row.FileID, id); err == nil {
			t.Fatalf("invalid successor %q accepted", id)
		}
	}
	if h.creates != 0 || d.next != nil || d.leases != 0 {
		t.Fatal("invalid successor reached I/O")
	}
}
func TestArchiveStreamPrevalidationFailureDoesNotPublish(t *testing.T) {
	data := encode(sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.SHA256 = archiveDigest(data)
	h.data = data
	h.offset = int64(len(data))
	failure := errors.New("resource inventory unavailable")
	d.resourcesErr = failure
	_, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if !errors.Is(err, failure) || h.publications != 0 || d.finishes != 0 || d.row.State != "receiving" {
		t.Fatalf("inventory failure: err=%v row=%+v", err, d.row)
	}
}
func TestArchiveStreamTimelineRejectsIncompleteLedger(t *testing.T) {
	data := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{}})
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.Purpose = "timeline"
	d.row.SHA256 = archiveDigest(data)
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	d.bundle.Ledger = encode(archiveLedger{Entries: []archiveLedgerEntry{{ID: uuid.NewString()}}})
	h.data = data
	h.offset = int64(len(data))
	_, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err == nil || h.publications != 0 || d.row.State != "failed" || d.bundle.Phase != "failed" {
		t.Fatalf("ledger mismatch: err=%v row=%+v phase=%s", err, d.row, d.bundle.Phase)
	}
}

func TestArchiveStreamRequiresStagingCapabilityForRegisteredUpload(t *testing.T) {
	op, d, _ := streamTestFixture(t, 4)
	files := op.execution.files
	op.execution.files = struct{ filestorage.Storage }{Storage: files}
	_, err := op.PutArchiveFileV2(t.Context(), "history", d.row.FileID, 0, 4, d.row.SHA256, bytes.NewReader([]byte("xxxx")))
	if err == nil || d.row.State != "receiving" || d.finishes != 0 || d.leases != 0 {
		t.Fatalf("missing backend: err=%v row=%+v leases=%d", err, d.row, d.leases)
	}
}
func TestArchiveStreamTimelineRejectsUnreadablePersistedLedger(t *testing.T) {
	data := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{}})
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.Purpose = "timeline"
	d.row.SHA256 = archiveDigest(data)
	d.bundle.Phase = "sealed"
	d.bundle.TimelineID = d.row.FileID
	d.bundle.Ledger = json.RawMessage(`{`)
	h.data = data
	h.offset = int64(len(data))
	_, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err == nil || h.publications != 0 || d.row.State != "receiving" || d.finishes != 0 {
		t.Fatalf("invalid ledger: err=%v row=%+v", err, d.row)
	}
}
func TestArchiveStreamCompletionDeclinedDoesNotInventReceipt(t *testing.T) {
	data := encode(sp.ArchiveHistoryContent{HistoryEpoch: "history", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}})
	op, d, h := streamTestFixture(t, int64(len(data)))
	d.row.SHA256 = archiveDigest(data)
	h.data = data
	h.offset = int64(len(data))
	d.declineFinish = true
	receipt, err := op.CompleteArchiveFile(t.Context(), "history", d.row.FileID)
	if err == nil || receipt.State == "complete" || d.row.State != "receiving" || h.publications != 1 || d.finishes != 0 {
		t.Fatalf("declined completion: receipt=%+v row=%+v err=%v", receipt, d.row, err)
	}
}

func TestArchiveStreamHistoryCannotBypassCorruptSuccessor(t *testing.T) {
	op, d, h := streamTestFixture(t, 4)
	op.execution.SetArchiveV2RegistrationEnabled(true)
	d.allowInsert = true
	h.allowCreate = true
	d.row.State = "failed"
	d.row.TerminalError = encode(sp.ImageError{Code: "staging_corrupt"})
	_, err := op.PutArchiveFileV2(t.Context(), "history", uuid.NewString(), 0, 4, archiveDigest([]byte("data")), bytes.NewReader([]byte("data")))
	if err == nil || h.creates != 0 || d.next != nil || d.bundle.HistoryID != d.row.FileID || d.row.SuccessorFileID != "" {
		t.Fatalf("history successor bypass: err=%v row=%+v", err, d.row)
	}
}
