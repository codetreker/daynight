package session

import (
	"reflect"
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestOfflineImageReleasePreservesConfirmedOffsetAndIdentity(t *testing.T) {
	for _, state := range []string{"receiving", "verifying"} {
		before := store.SessionUploadRecord{SessionID: "session", BlobID: "blob", Receipt: sp.ImageUploadReceipt{UploadID: "upload", State: state, AcceptedOffset: "1048576"}}
		after, err := ReleaseOfflineImageUpload(before)
		if err != nil || !after.StorageReleased || after.Receipt.State != "released" || after.Receipt.AcceptedOffset != before.Receipt.AcceptedOffset || after.Receipt.UploadID != before.Receipt.UploadID || before.StorageReleased || before.Receipt.State != state {
			t.Fatalf("release: %+v, original %+v, error %v", after, before, err)
		}
	}
	if _, err := ReleaseOfflineImageUpload(store.SessionUploadRecord{Receipt: sp.ImageUploadReceipt{State: "complete"}}); err == nil {
		t.Fatal("completed original was released")
	}
}

func TestOfflineStateValidationRejectsUnownedCleanupPath(t *testing.T) {
	id, owner, file := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	path := n.Directory() + "/files/" + file
	item := store.OfflineArchiveFile{OwnerID: owner, File: store.ArchiveBundleFile{SessionID: id, FileID: file, Purpose: "history", Path: path, State: "receiving", SHA256: strings.Repeat("a", 64), ByteLength: 7, UploadVersion: 2, TimelineRevision: 2}, Bundle: &store.ArchiveBundle{SessionID: id, Phase: "settling", Revision: 2, HistoryID: file}, Chunks: []store.StorageObject{{Bucket: "session-archives", Path: path + "/chunks/0", ByteLength: 7, SHA256: strings.Repeat("a", 64)}}}
	state := store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}}
	if err := ValidateOfflineStorageState(state); err != nil {
		t.Fatal(err)
	}
	state.ArchiveFiles[0].Chunks[0].Path = path + "/chunks/../other"
	if err := ValidateOfflineStorageState(state); err == nil {
		t.Fatal("unowned cleanup path accepted")
	}
}

func TestOfflineProjectionPreservesCompletedHistoryLedgerAndRevision(t *testing.T) {
	bundle := store.ArchiveBundle{SessionID: "session", Revision: 7, HistoryID: "replacement", TimelineID: "other", Ledger: []byte(`{"HistoryID":"completed"}`)}
	inventory := store.StorageInventory{SessionID: "session", ArchiveBundle: &bundle, Objects: []store.StorageObject{{Bucket: "session-archives", Path: "discard"}, {Bucket: "session-resources", Path: "retained"}}, ArchiveFilesV2: []store.StorageArchiveFileV2{{FileID: "replacement", State: "receiving"}, {FileID: "completed", State: "complete"}}}
	state := store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{{File: store.ArchiveBundleFile{SessionID: "session", FileID: "replacement", State: "receiving"}, Chunks: []store.StorageObject{{Bucket: "session-archives", Path: "discard"}}}}}
	projected, err := ProjectOfflineStorageInventory(inventory, state)
	if err != nil || projected.ArchiveBundle.Revision != 7 || projected.ArchiveBundle.HistoryID != "" || projected.ArchiveBundle.TimelineID != "other" || !reflect.DeepEqual(projected.ArchiveBundle.Ledger, bundle.Ledger) || len(projected.ArchiveFilesV2) != 1 || projected.ArchiveFilesV2[0].FileID != "completed" || len(projected.Objects) != 1 || projected.Objects[0].Path != "retained" {
		t.Fatalf("projection: %+v, %v", projected, err)
	}
	if inventory.ArchiveBundle.HistoryID != "replacement" || len(inventory.ArchiveFilesV2) != 2 || len(inventory.Objects) != 2 {
		t.Fatal("projection mutated source snapshot")
	}
	state.ArchiveFiles[0].File.State = "complete"
	if _, err := ProjectOfflineStorageInventory(inventory, state); err == nil {
		t.Fatal("projection revoked completed receipt")
	}
}
