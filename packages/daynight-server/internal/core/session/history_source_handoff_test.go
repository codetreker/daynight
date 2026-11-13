package session

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type sourceResetDAO struct{ *archiveFlowDAO }

func (d *sourceResetDAO) TouchSession(context.Context, string, time.Time) error  { return nil }
func (d *sourceResetDAO) SaveSession(context.Context, store.SessionRecord) error { return nil }

func TestSourceResetRetiresOldRoundAndAcceptsNewCheckpointOrFinalArchive(t *testing.T) {
	for _, syncFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "final without new checkpoint", true: "new checkpoint then final"}[syncFirst], func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			oldEpoch, newEpoch := uuid.NewString(), uuid.NewString()
			r.SourceEpoch, r.SourceEpochs = &oldEpoch, []string{oldEpoch}
			entry := localEntry(t, "1")
			body, completedID := activeHistoryBytes(r, entry), uuid.NewString()
			if _, err := op.PutHistoryLedger(t.Context(), writer, completedID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
				t.Fatal(err)
			}
			partialID, half := uuid.NewString(), len(body)/2
			if _, err := op.PutHistoryLedger(t.Context(), writer, partialID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); err != nil {
				t.Fatal(err)
			}
			actualDAO := &sourceResetDAO{d}
			op.execution.controllerRun = func(_ context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				if fence != r.Snapshot.ControllerFence {
					return conflict()
				}
				return work(&Access{tx: &operationTx{dao: actualDAO}, record: r})
			}
			reset := sp.ControllerMessage{Type: "source_reset", ControllerFence: r.Snapshot.ControllerFence, PreviousSourceEpoch: oldEpoch, NewSourceEpoch: newEpoch, Reason: "source resumed"}
			if _, err := op.execution.Handle(t.Context(), reset); err != nil {
				t.Fatal(err)
			}
			if r.SourceSeq != 0 || *r.SourceEpoch != newEpoch || d.files[partialID].State != "failed" {
				t.Fatalf("reset did not retire original source: %+v", d.files[partialID])
			}
			newBody := activeHistoryBytes(r, entry)
			if syncFirst {
				if _, err := op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(newBody)), archiveDigest(newBody), archiveDigest(newBody), newBody); err != nil {
					t.Fatal("new source checkpoint rejected", err)
				}
				var ledger archiveLedger
				if json.Unmarshal(d.bundle.Ledger, &ledger) != nil || ledger.SourceEpoch != newEpoch || ledger.SourceThrough != "0" {
					t.Fatalf("wrong checkpoint source: %+v", ledger)
				}
			}
			if _, err := op.PutHistoryLedger(t.Context(), writer, partialID, int64(half), int64(len(body)), archiveDigest(body), archiveDigest(body[half:]), body[half:]); err == nil {
				t.Fatal("old epoch completed after reset")
			}
			stopped := stoppedHistoryOperation(op, r)
			if _, err := stopped.PrepareArchive(t.Context(), sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}); err != nil {
				t.Fatal(err)
			}
			if _, err := stopped.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(newBody)), archiveDigest(newBody), archiveDigest(newBody), newBody); err != nil {
				t.Fatal("new source final history rejected", err)
			}
			if _, err := stopped.SealArchive(t.Context()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestHistoryCapacityFailureRetainsOriginalReceipt(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	length := decimal(MaxSessionContentBytes)
	id := uuid.NewString()
	d.resources[id] = store.SessionResourceRecord{SessionID: op.id, Resource: sp.Resource{ResourceID: id, Status: "available", Name: "existing", ByteLength: &length}}
	body, fileID := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
	_, err := op.PutHistoryLedger(t.Context(), writer, fileID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
	var failure *model.Fault
	if !errors.As(err, &failure) || failure.Code != "quota_exceeded" {
		t.Fatal("capacity refusal lost", err)
	}
	receipt, err := op.HistoryLedgerStatus(t.Context(), writer, fileID)
	if err != nil || receipt.State != "failed" || receipt.Error == nil || receipt.Error.Code != "quota_exceeded" || receipt.FileID != fileID {
		t.Fatalf("original failure receipt: %+v %v", receipt, err)
	}
	invalid := invalidArchiveFile(fault("quota_exceeded", "full"))
	unknown := &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: invalid}
	if definiteArchiveValidation(unknown) != nil {
		t.Fatal("unknown commit was treated as definite refusal")
	}
}

type blockedHistoryStorage struct {
	*imageRuleStorage
	entered    chan struct{}
	resume     chan struct{}
	block      bool
	blockOpen  bool
	failDelete bool
	failure    error
}

func (s *blockedHistoryStorage) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	if s.blockOpen && strings.Contains(path, "/chunks/") {
		s.blockOpen = false
		close(s.entered)
		select {
		case <-s.resume:
		case <-ctx.Done():
			return filestorage.Object{}, ctx.Err()
		}
	}
	return s.imageRuleStorage.Open(ctx, bucket, path)
}

func (s *blockedHistoryStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	if s.block && strings.Contains(path, "/chunks/") {
		s.block = false
		close(s.entered)
		select {
		case <-s.resume:
		case <-ctx.Done():
			return filestorage.FileInfo{}, ctx.Err()
		}
	}
	return s.imageRuleStorage.Put(ctx, bucket, path, body)
}
func (s *blockedHistoryStorage) Delete(ctx context.Context, bucket, path string) error {
	if s.failDelete && strings.Contains(path, "/chunks/") {
		return s.failure
	}
	return s.imageRuleStorage.Delete(ctx, bucket, path)
}

func TestSourceResetReclaimsLatePublishedChunkAfterWriterExits(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	oldEpoch, newEpoch := uuid.NewString(), uuid.NewString()
	r.SourceEpoch, r.SourceEpochs = &oldEpoch, []string{oldEpoch}
	body := activeHistoryBytes(r, localEntry(t, "1"))
	failure := errors.New("chunk deletion failed")
	storage := &blockedHistoryStorage{imageRuleStorage: op.execution.files.(*imageRuleStorage), entered: make(chan struct{}), resume: make(chan struct{}), block: true, failDelete: true, failure: failure}
	op.execution.files = storage
	fileID := uuid.NewString()
	result := make(chan error, 1)
	go func() {
		_, err := op.PutHistoryLedger(t.Context(), writer, fileID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
		result <- err
	}()
	select {
	case <-storage.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("writer did not reach actual storage")
	}
	file := d.files[fileID]
	actualDAO := &sourceResetDAO{d}
	op.execution.controllerRun = func(_ context.Context, _ sp.ControllerFence, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: actualDAO}, record: r})
	}
	if _, err := op.execution.Handle(t.Context(), sp.ControllerMessage{Type: "source_reset", ControllerFence: r.Snapshot.ControllerFence, PreviousSourceEpoch: oldEpoch, NewSourceEpoch: newEpoch, Reason: "source resumed"}); err != nil {
		t.Fatal(err)
	}
	if d.files[fileID].State != "failed" {
		t.Fatal("old writer not retired")
	}
	close(storage.resume)
	if err := <-result; !errors.Is(err, failure) {
		t.Fatalf("cleanup failure missing from writer result: %v", err)
	}
	if d.files[fileID].StagingReleased {
		t.Fatal("failed deletion marked as cleaned")
	}
	object, err := storage.Open(t.Context(), archiveBucket, file.Path+"/chunks/0")
	if err != nil {
		t.Fatal("late published chunk was lost before recovery", err)
	}
	if err = object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	storage.failDelete = false
	newBody := activeHistoryBytes(r, localEntry(t, "1"))
	if _, err = op.PutHistoryLedger(t.Context(), writer, uuid.NewString(), 0, int64(len(newBody)), archiveDigest(newBody), archiveDigest(newBody), newBody); err != nil {
		t.Fatal("new checkpoint did not recover cleanup", err)
	}
	if _, err = storage.Open(t.Context(), archiveBucket, file.Path+"/chunks/0"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("late chunk still present after recovery", err)
	}
	if !d.files[fileID].StagingReleased || d.leases != 0 {
		t.Fatal("retired file cleanup or leases not settled", d.files[fileID], d.leases)
	}
}

func TestSourceResetCleansRetiredHistoryWithoutLaterUpload(t *testing.T) {
	for _, failFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "unrelated media lease", true: "retry cleanup under original reset"}[failFirst], func(t *testing.T) {
			op, d, r, writer := activeHistoryFixture(t)
			oldEpoch, newEpoch := uuid.NewString(), uuid.NewString()
			r.SourceEpoch, r.SourceEpochs = &oldEpoch, []string{oldEpoch}
			body, fileID := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
			half := len(body) / 2
			if _, err := op.PutHistoryLedger(t.Context(), writer, fileID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); err != nil {
				t.Fatal(err)
			}
			file := d.files[fileID]
			other := store.SessionResourceLease{ID: uuid.NewString(), SessionID: op.id, Kind: "read"}
			if err := d.AcquireSessionResourceLease(t.Context(), other); err != nil {
				t.Fatal(err)
			}
			storage := &blockedHistoryStorage{imageRuleStorage: op.execution.files.(*imageRuleStorage), failure: errors.New("cleanup failed"), failDelete: failFirst}
			op.execution.files = storage
			op.execution.controllerRun = func(_ context.Context, _ sp.ControllerFence, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: &sourceResetDAO{d}}, record: r})
			}
			reset := sp.ControllerMessage{Type: "source_reset", ControllerFence: r.Snapshot.ControllerFence, PreviousSourceEpoch: oldEpoch, NewSourceEpoch: newEpoch, Reason: "source resumed"}
			if _, err := op.execution.Handle(t.Context(), reset); err != nil {
				t.Fatal("reset failed due to cleanup", err)
			}
			if failFirst {
				if d.files[fileID].StagingReleased {
					t.Fatal("failed cleanup recorded as successful")
				}
				storage.failDelete = false
				if _, err := op.execution.Handle(t.Context(), reset); err != nil {
					t.Fatal("original reset retry", err)
				}
			}
			if !d.files[fileID].StagingReleased {
				t.Fatal("retired history not settled")
			}
			if _, err := storage.Open(t.Context(), archiveBucket, file.Path+"/chunks/0"); !errors.Is(err, fs.ErrNotExist) {
				t.Fatal("retired chunk still present", err)
			}
			if len(d.leaseRows) != 1 || d.leaseRows[other.ID].Kind != "read" {
				t.Fatal("unrelated media lease changed")
			}
		})
	}
}

func TestSourceResetRejectsLateDuplicateChunkReceipt(t *testing.T) {
	op, d, r, writer := activeHistoryFixture(t)
	oldEpoch, newEpoch := uuid.NewString(), uuid.NewString()
	r.SourceEpoch, r.SourceEpochs = &oldEpoch, []string{oldEpoch}
	body, fileID := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
	half := len(body) / 2
	if _, err := op.PutHistoryLedger(t.Context(), writer, fileID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); err != nil {
		t.Fatal(err)
	}
	file := d.files[fileID]
	storage := &blockedHistoryStorage{imageRuleStorage: op.execution.files.(*imageRuleStorage), entered: make(chan struct{}), resume: make(chan struct{}), blockOpen: true}
	op.execution.files = storage
	result := make(chan error, 1)
	go func() {
		_, err := op.PutHistoryLedger(t.Context(), writer, fileID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half])
		result <- err
	}()
	select {
	case <-storage.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("duplicate reader did not reach storage")
	}
	op.execution.controllerRun = func(_ context.Context, _ sp.ControllerFence, work func(*Access) error) error {
		return work(&Access{tx: &operationTx{dao: &sourceResetDAO{d}}, record: r})
	}
	if _, err := op.execution.Handle(t.Context(), sp.ControllerMessage{Type: "source_reset", ControllerFence: r.Snapshot.ControllerFence, PreviousSourceEpoch: oldEpoch, NewSourceEpoch: newEpoch, Reason: "source resumed"}); err != nil {
		t.Fatal(err)
	}
	close(storage.resume)
	if err := <-result; err == nil {
		t.Fatal("old duplicate returned receiving after reset")
	}
	if !d.files[fileID].StagingReleased {
		t.Fatal("last archive lease did not settle retired staging")
	}
	if _, err := storage.Open(t.Context(), archiveBucket, file.Path+"/chunks/0"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("retired duplicate chunk remained", err)
	}
}

func TestHistoryDuplicateObservesConcurrentForwardProgress(t *testing.T) {
	op, _, r, writer := activeHistoryFixture(t)
	body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
	part := len(body) / 3
	if _, err := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:part]), body[:part]); err != nil {
		t.Fatal(err)
	}
	storage := &blockedHistoryStorage{imageRuleStorage: op.execution.files.(*imageRuleStorage), entered: make(chan struct{}), resume: make(chan struct{}), blockOpen: true}
	op.execution.files = storage
	type reply struct {
		receipt sp.ArchiveFileReceipt
		err     error
	}
	result := make(chan reply, 1)
	go func() {
		receipt, err := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:part]), body[:part])
		result <- reply{receipt, err}
	}()
	select {
	case <-storage.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("duplicate reader did not reach storage")
	}
	other := &ArchiveOperation{execution: op.execution, principal: op.principal, project: op.project, task: op.task, id: op.id, owner: op.owner, mode: op.mode}
	if receipt, err := other.PutHistoryLedger(t.Context(), writer, id, int64(part), int64(len(body)), archiveDigest(body), archiveDigest(body[part:2*part]), body[part:2*part]); err != nil || receipt.AcceptedOffset != decimal(int64(2*part)) {
		t.Fatal("concurrent progress", receipt, err)
	}
	close(storage.resume)
	got := <-result
	if got.err != nil || got.receipt.AcceptedOffset != decimal(int64(2*part)) || got.receipt.State != "receiving" {
		t.Fatalf("duplicate lost current progress: %+v %v", got.receipt, got.err)
	}
}

type historyReadFailureDAO struct {
	*archiveFlowDAO
	failure error
}

func (d *historyReadFailureDAO) ListSessionResources(ctx context.Context, id string) ([]store.SessionResourceRecord, error) {
	if d.failure != nil {
		return nil, d.failure
	}
	return d.archiveFlowDAO.ListSessionResources(ctx, id)
}

func TestHistoryCapacityReadFailureRetainsOriginalForRetry(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "read failure", true: "unknown transaction"}[unknown], func(t *testing.T) {
			op, base, r, writer := activeHistoryFixture(t)
			cause := errors.New("inventory read unavailable")
			failure := error(cause)
			if unknown {
				failure = &store.TransactionError{Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: cause}
			}
			d := &historyReadFailureDAO{archiveFlowDAO: base, failure: failure}
			op.execution.archiveRun = func(_ context.Context, _ model.Principal, _, _, _ string, _ bool, work func(*Access) error) error {
				return work(&Access{tx: &operationTx{dao: d}, record: r})
			}
			body, id := activeHistoryBytes(r, localEntry(t, "1")), uuid.NewString()
			if _, err := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); !errors.Is(err, cause) {
				t.Fatal("read failure lost", err)
			}
			file := base.files[id]
			if file.State != "receiving" || file.StagingReleased || file.AcceptedOffset != int64(len(body)) {
				t.Fatal("read failure became a definite rejection", file)
			}
			d.failure = nil
			receipt, err := op.PutHistoryLedger(t.Context(), writer, id, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body)
			if err != nil || receipt.State != "complete" || receipt.FileID != id {
				t.Fatal("original identity could not recover", receipt, err)
			}
		})
	}
}
