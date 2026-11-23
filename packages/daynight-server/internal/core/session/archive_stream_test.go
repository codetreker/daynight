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
}

func (d *streamTestDAO) ArchiveStagingRecord(_ context.Context, _, id string) (store.ArchiveStagingRecord, error) {
	if d.next != nil && id == d.next.FileID {
		return *d.next, nil
	}
	if id != d.row.FileID {
		return store.ArchiveStagingRecord{}, model.ErrNotFound
	}
	return d.row, nil
}
func (d *streamTestDAO) ArchiveStagingRecords(context.Context, string) ([]store.ArchiveStagingRecord, error) {
	if d.exposeTerminal {
		return []store.ArchiveStagingRecord{d.row}, nil
	}
	return nil, nil
}
func (d *streamTestDAO) InsertArchiveStaging(_ context.Context, row store.ArchiveStagingRecord) (bool, error) {
	if !d.allowInsert || d.next != nil {
		return false, errors.New("unexpected registration")
	}
	d.next = &row
	return true, nil
}
func (d *streamTestDAO) FinishArchiveStaging(_ context.Context, row store.ArchiveStagingRecord, state string, offset int64, terminal json.RawMessage) (bool, error) {
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
	if !d.exposeTerminal || !sameStreamRecord(row, d.row) || d.row.StagingReleased {
		return false, errors.New("unexpected release")
	}
	d.releases++
	d.row.StagingReleased = true
	return true, nil
}

type streamTestStorage struct {
	filestorage.Storage
	h *streamTestHandle
}

func (s *streamTestStorage) AcquireArchiveStaging(context.Context, sessionarchive.Namespace, bool) (filestorage.ArchiveStaging, error) {
	return s.h, nil
}

type streamTestHandle struct {
	offset         int64
	corrupt        bool
	observeErr     error
	appends        int
	closed         int
	deleteFailures int
	data           []byte
	publications   int
	allowCreate    bool
	creates        int
}

func (h *streamTestHandle) Create(context.Context, string) error {
	if !h.allowCreate {
		return errors.New("unexpected create")
	}
	h.creates++
	return nil
}
func (*streamTestHandle) AdoptEmpty(context.Context, string) error {
	return errors.New("unexpected adoption")
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
	if int64(len(h.data)) != total {
		return filestorage.FileInfo{}, io.ErrUnexpectedEOF
	}
	h.publications++
	return filestorage.FileInfo{Size: total}, nil
}
func (h *streamTestHandle) Delete(ctx context.Context, _ string) error {
	if err := filestorage.VerifyGates(ctx); err != nil {
		return err
	}
	if h.deleteFailures > 0 {
		h.deleteFailures--
		return errors.New("injected delete failure")
	}
	return nil
}
func (h *streamTestHandle) Close() error { h.closed++; return nil }

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
	d := &streamTestDAO{archiveFlowDAO: base, row: row}
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
	h.deleteFailures = 1
	receipt, err := op.CompleteArchiveFile(t.Context(), "timeline", d.row.FileID)
	if err != nil || receipt.State != "complete" || d.row.StagingReleased || d.releases != 0 {
		t.Fatalf("terminal receipt after cleanup failure: %+v row=%+v err=%v", receipt, d.row, err)
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
