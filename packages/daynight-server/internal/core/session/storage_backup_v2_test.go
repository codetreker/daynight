package session

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBackupV2ReceiptAndPrefixBoundaries(t *testing.T) {
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
	block := []byte("abc")
	digest := sha256.Sum256(block)
	proof := sessionarchive.AdvancePrefixProof(sessionarchive.InitialPrefixProof(), 0, uint32(len(block)), digest)
	path, err := n.BlockPath(fileID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.Put(t.Context(), archiveBucket, path, bytes.NewReader(block)); err != nil {
		t.Fatal(err)
	}
	base := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "history", State: "receiving", SHA256: archiveDigest(block), ByteLength: 3, AcceptedOffset: 3, TimelineRevision: 1, Path: n.Directory() + "/files/" + fileID, PrefixProof: proof[:]}
	ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "0", Entries: []sp.TimelineEntry{}, Resources: []sp.Resource{}}, "epoch", 0)
	if err != nil {
		t.Fatal(err)
	}
	ledger.HistoryID = fileID
	bundle := store.ArchiveBundle{SessionID: id, HistoryID: fileID, Phase: "settling", Revision: 1, Ledger: encode(ledger)}
	verify := func(f store.StorageArchiveFileV2, b store.ArchiveBundle) error {
		return VerifyStorageBackup(t.Context(), files, store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveFilesV2: []store.StorageArchiveFileV2{f}, ArchiveBundle: &b})
	}
	if err := verify(base, bundle); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		mutate func(*store.StorageArchiveFileV2, *store.ArchiveBundle)
	}{
		{"wrong proof", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.PrefixProof = make([]byte, 32) }},
		{"partial block", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.AcceptedOffset = 1 }},
		{"wrong phase", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.Phase = "sealed" }},
		{"wrong revision", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.Revision++ }},
		{"wrong file", func(_ *store.StorageArchiveFileV2, b *store.ArchiveBundle) { b.HistoryID = uuid.NewString() }},
		{"wrong path", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.Path += "/wrong" }},
		{"unknown version", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.UploadVersion = 3 }},
		{"released receiving", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.StagingReleased = true }},
		{"failed missing error", func(f *store.StorageArchiveFileV2, _ *store.ArchiveBundle) { f.State = "failed" }},
		{"complete wrong ledger", func(f *store.StorageArchiveFileV2, b *store.ArchiveBundle) {
			f.State = "complete"
			b.Ledger = json.RawMessage(`{}`)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f, b := base, bundle
			tc.mutate(&f, &b)
			if err := verify(f, b); err == nil {
				t.Fatal("invalid inventory accepted")
			}
		})
	}
	complete := base
	complete.State = "complete"
	complete.StagingReleased = true
	if err := files.Delete(t.Context(), archiveBucket, path); err != nil {
		t.Fatal(err)
	}
	bundle.Revision++ // Resetting a failed timeline preserves the earlier history.
	if err := verify(complete, bundle); err != nil {
		t.Fatalf("completed history needs only its ledger: %v", err)
	}
	failed := base
	failed.State = "failed"
	failed.TerminalError = json.RawMessage(`{"code":"staging_corrupt"}`)
	if err := verify(failed, bundle); err != nil {
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

func TestBackupV2ConfirmedBlockIOFailuresAreNotIgnored(t *testing.T) {
	id, owner, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("original")
	digest := sha256.Sum256(data)
	proof := sessionarchive.AdvancePrefixProof(sessionarchive.InitialPrefixProof(), 0, uint32(len(data)), digest)
	file := store.StorageArchiveFileV2{FileID: fileID, ByteLength: int64(len(data)), AcceptedOffset: int64(len(data)), PrefixProof: proof[:]}
	readFailure, closeFailure := errors.New("read failed"), errors.New("close failed")
	for _, tc := range []struct {
		name  string
		files optionalBackupFailure
		want  error
	}{
		{"missing confirmed block", optionalBackupFailure{openErr: fs.ErrNotExist}, fs.ErrNotExist},
		{"read failure", optionalBackupFailure{readErr: readFailure}, readFailure},
		{"close failure", optionalBackupFailure{closeErr: closeFailure}, closeFailure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := verifyArchiveV2Prefix(t.Context(), tc.files, n, file); !errors.Is(err, tc.want) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}
