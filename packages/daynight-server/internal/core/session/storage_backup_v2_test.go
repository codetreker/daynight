package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBackupV2StagingRecoveryAndIdentity(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer files.Close()
	id, owner, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	path, err := filestorage.ArchiveStagingPath(n, fileID)
	if err != nil {
		t.Fatal(err)
	}
	full := bytes.Repeat([]byte("a"), int(sessionarchive.BlockSize)+3)
	base := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "history", State: "receiving", SHA256: archiveDigest(full), ByteLength: int64(len(full)), AcceptedOffset: 17, TimelineRevision: 1, Path: n.Directory() + "/files/" + fileID}
	ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}}, "epoch", 0)
	if err != nil {
		t.Fatal(err)
	}
	ledger.HistoryID = fileID
	bundle := store.ArchiveBundle{SessionID: id, HistoryID: fileID, Phase: "settling", Revision: 1, Ledger: encode(ledger)}
	verify := func(f store.StorageArchiveFileV2, b store.ArchiveBundle) ([]ArchiveRecoveryOffset, error) {
		var observations []ArchiveRecoveryOffset
		err := VerifyStorageBackupWithReport(t.Context(), files, store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveFilesV2: []store.StorageArchiveFileV2{f}, ArchiveBundle: &b}, func(o ArchiveRecoveryOffset) error { observations = append(observations, o); return nil })
		return observations, err
	}
	cases := []struct {
		name   string
		data   []byte
		offset int64
		want   bool
	}{
		{"empty", []byte{}, 0, true}, {"partial block", full[:17], 0, true}, {"trailing partial", full[:len(full)-1], sessionarchive.BlockSize, true},
		{"complete", full, int64(len(full)), true}, {"corrupt complete", bytes.Repeat([]byte("b"), len(full)), 0, false}, {"overlong", append(bytes.Clone(full), 'x'), 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := files.Put(t.Context(), archiveBucket, path, bytes.NewReader(tc.data)); err != nil {
				t.Fatal(err)
			}
			observations, err := verify(base, bundle)
			if (err == nil) != tc.want {
				t.Fatalf("verification=%v, want success %t", err, tc.want)
			}
			if tc.want && (len(observations) != 1 || observations[0] != (ArchiveRecoveryOffset{SessionID: id, FileID: fileID, Offset: tc.offset})) {
				t.Fatalf("observations=%+v", observations)
			}
			if !tc.want && len(observations) != 0 {
				t.Fatal("reported failed inventory")
			}
		})
	}
	if _, err := files.Put(t.Context(), archiveBucket, path, bytes.NewReader(full)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(*store.StorageArchiveFileV2, *store.ArchiveBundle)
	}{
		{"wrong phase", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.Phase = "sealed" }},
		{"wrong revision", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.Revision++ }},
		{"wrong file", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.HistoryID = uuid.NewString() }},
		{"wrong path", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.Path += "/wrong" }},
		{"unknown version", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.UploadVersion = 3 }},
		{"released receiving", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.StagingReleased = true }},
		{"failed missing error", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.State = "failed" }},
		{"complete wrong ledger", func(f *store.StorageArchiveFileV2, b *store.ArchiveBundle) {
			f.State = "complete"
			f.AcceptedOffset = f.ByteLength
			b.Ledger = json.RawMessage(`{}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, b := base, bundle
			tc.mutate(&f, &b)
			if _, err := verify(f, b); err == nil {
				t.Fatal("invalid inventory accepted")
			}
		})
	}
	if err := files.Delete(t.Context(), archiveBucket, path); err != nil {
		t.Fatal(err)
	}
	if _, err := verify(base, bundle); err == nil {
		t.Fatal("missing staging accepted")
	}
	complete := base
	complete.State = "complete"
	complete.AcceptedOffset = complete.ByteLength
	complete.StagingReleased = true
	bundle.Revision++
	if _, err := verify(complete, bundle); err != nil {
		t.Fatalf("completed history needs only its ledger: %v", err)
	}
	failed := base
	failed.State = "failed"
	failed.TerminalError = json.RawMessage(`{"code":"staging_corrupt"}`)
	if _, err := verify(failed, bundle); err != nil {
		t.Fatalf("failed staging required: %v", err)
	}
}

func TestBackupCompletedHistoryLedgerRetainsActualEntries(t *testing.T) {
	entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.Nil.String() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	history := sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}
	ledger, err := makeArchiveLedger(history, history.HistoryEpoch, 1)
	if err != nil {
		t.Fatal(err)
	}
	ledger.HistoryID = uuid.NewString()
	if err := validateBackupLedger(encode(ledger), ledger.HistoryID); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*archiveLedger){
		func(l *archiveLedger) { l.HistoryEpoch = "" },
		func(l *archiveLedger) { l.SourceThrough = "invalid" },
		func(l *archiveLedger) { l.Entries[0].SHA256 = "bad" },
		func(l *archiveLedger) { l.HistoryID = uuid.NewString() },
	} {
		var broken archiveLedger
		if err := json.Unmarshal(encode(ledger), &broken); err != nil {
			t.Fatal(err)
		}
		mutate(&broken)
		if err := validateBackupLedger(encode(broken), ledger.HistoryID); err == nil {
			t.Fatal("damaged history ledger accepted")
		}
	}
	if err := validateBackupLedger(json.RawMessage(`{"HistoryID":"`+ledger.HistoryID+`"}`), ledger.HistoryID); err == nil {
		t.Fatal("incomplete ledger accepted")
	}
}

type stagingReadFailure struct{ optionalBackupFailure }

func (f stagingReadFailure) OpenArchiveStaging(ctx context.Context, _ sessionarchive.Namespace, _ string) (filestorage.Object, error) {
	object, err := f.Open(ctx, "", "")
	object.Info.Size = int64(len("original"))
	return object, err
}

func TestBackupV2StagingReadFailures(t *testing.T) {
	id, owner, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	file := store.StorageArchiveFileV2{FileID: fileID, ByteLength: 8, SHA256: archiveDigest([]byte("original"))}
	readFailure, closeFailure := errors.New("read failed"), errors.New("close failed")
	for _, tc := range []struct {
		name  string
		files stagingReadFailure
		want  error
	}{
		{"missing", stagingReadFailure{optionalBackupFailure{openErr: fs.ErrNotExist}}, fs.ErrNotExist},
		{"read", stagingReadFailure{optionalBackupFailure{readErr: readFailure}}, readFailure},
		{"close", stagingReadFailure{optionalBackupFailure{closeErr: closeFailure}}, closeFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := observeArchiveV2Staging(t.Context(), tc.files, n, file); !errors.Is(err, tc.want) {
				t.Fatalf("error=%v, want %v", err, tc.want)
			}
		})
	}
	if _, err := observeArchiveV2Staging(t.Context(), optionalBackupFailure{}, n, file); err == nil {
		t.Fatal("accepted storage without isolated staging reader")
	}
}
