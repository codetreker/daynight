package session

import (
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestOfflineValidationResetsV1ActiveHistoryWithoutChangingCompletedLedger(t *testing.T) {
	op, dao, record, writer := activeHistoryFixture(t)
	body := activeHistoryBytes(record, localEntry(t, "1"))
	completedID, replacementID := uuid.NewString(), uuid.NewString()
	if _, err := op.PutHistoryLedger(t.Context(), writer, completedID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); err != nil {
		t.Fatal(err)
	}
	ledger := append([]byte(nil), dao.bundle.Ledger...)
	completed := dao.files[completedID]
	half := len(body) / 2
	if _, err := op.PutHistoryLedger(t.Context(), writer, replacementID, 0, int64(len(body)), archiveDigest(body), archiveDigest(body[:half]), body[:half]); err != nil {
		t.Fatal(err)
	}
	file, bundle := dao.files[replacementID], *dao.bundle
	originalFile := file
	// The v1 DAO insert persists upload_version=1 through the database default.
	file.UploadVersion = 1
	if bundle.Phase != "active" || bundle.HistoryID != replacementID || bundle.Revision != 2 || file.State != "receiving" || file.AcceptedOffset != int64(half) || file.TimelineRevision != bundle.Revision || !jsonEqual(ledger, bundle.Ledger) {
		t.Fatal("online history replacement fixture lost its previous ledger", file, bundle)
	}
	item := store.OfflineArchiveFile{ProjectID: op.project, OwnerID: op.owner, File: file, Bundle: &bundle}
	for _, chunk := range dao.chunks[replacementID] {
		item.Chunks = append(item.Chunks, store.StorageObject{Bucket: archiveBucket, Path: chunk.Path, SHA256: chunk.SHA256, ByteLength: chunk.ByteLength})
	}
	state := store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}}
	if err := ValidateOfflineStorageState(state); err != nil {
		t.Fatal("valid v1 online history rejected", err)
	}
	inventory := store.StorageInventory{SessionID: op.id, ProjectID: op.project, OwnerID: op.owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{archiveRevocationFile(completed), archiveRevocationFile(file)}, Objects: item.Chunks}
	projected, err := ProjectOfflineStorageInventory(inventory, state)
	expected := bundle
	expected.HistoryID = ""
	if err != nil || !reflect.DeepEqual(projected.ArchiveBundle, &expected) || len(projected.ArchiveFilesV2) != 1 || !reflect.DeepEqual(projected.ArchiveFilesV2[0], archiveRevocationFile(completed)) || len(projected.Objects) != 0 {
		t.Fatal("revocation changed completed receipt, ledger, identity or revision", projected, err)
	}
	if !reflect.DeepEqual(*dao.bundle, bundle) || !reflect.DeepEqual(dao.files[replacementID], originalFile) || !reflect.DeepEqual(dao.files[completedID], completed) || inventory.ArchiveBundle.HistoryID != replacementID || len(inventory.Objects) != len(item.Chunks) {
		t.Fatal("offline projection mutated the source snapshot")
	}
}

func TestOfflineValidationKeepsHistoryPhaseAndCurrentIdentityRestrictions(t *testing.T) {
	for _, version := range []int{1, 2} {
		for _, phase := range []string{"active", "settling", "sealed", "complete"} {
			item := offlineArchiveValidationFixture(t, "history")
			item.File.UploadVersion, item.Bundle.Phase = version, phase
			err := ValidateOfflineStorageState(store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}})
			valid := phase == "settling" || version == 1 && phase == "active"
			if (err == nil) != valid {
				t.Fatal(version, phase, err)
			}
		}
	}
	for _, change := range []func(*store.OfflineArchiveFile){
		func(v *store.OfflineArchiveFile) { v.Bundle.HistoryID = uuid.NewString() },
		func(v *store.OfflineArchiveFile) { v.Bundle.SessionID = uuid.NewString() },
		func(v *store.OfflineArchiveFile) { v.Bundle.Revision++ },
	} {
		item := offlineArchiveValidationFixture(t, "history")
		item.File.UploadVersion, item.Bundle.Phase = 1, "active"
		change(&item)
		if err := ValidateOfflineStorageState(store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}}); err == nil {
			t.Fatal("active history accepted a mismatched current identity")
		}
	}
}

func offlineArchiveValidationFixture(t *testing.T, purpose string) store.OfflineArchiveFile {
	t.Helper()
	id, owner, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	file := store.ArchiveBundleFile{SessionID: id, FileID: fileID, Purpose: purpose, State: "receiving", UploadVersion: 2, ByteLength: 7, SHA256: strings.Repeat("a", 64), TimelineRevision: 2, Path: n.Directory() + "/files/" + fileID}
	bundle := &store.ArchiveBundle{SessionID: id, Phase: "settling", Revision: 2, HistoryID: fileID}
	if purpose == "timeline" {
		bundle.Phase, bundle.HistoryID, bundle.TimelineID = "sealed", "", fileID
	}
	if purpose == "resource" {
		file.Path, err = BlobAddress("", owner, id, fileID)
		if err != nil {
			t.Fatal(err)
		}
		length, digest, mediaType := "7", file.SHA256, "text/plain"
		file.Resource = encode(sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "artifact.txt", MediaType: &mediaType, ByteLength: &length, SHA256: &digest})
	}
	return store.OfflineArchiveFile{OwnerID: owner, File: file, Bundle: bundle}
}

func TestOfflineValidationRejectsUnownedOrInconsistentArchiveRegistration(t *testing.T) {
	for _, purpose := range []string{"history", "timeline", "resource"} {
		item := offlineArchiveValidationFixture(t, purpose)
		if err := ValidateOfflineStorageState(store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}}); err != nil {
			t.Fatal(purpose, err)
		}
	}
	cases := []struct {
		name, purpose string
		change        func(*store.OfflineArchiveFile)
	}{
		{"invalid owner", "history", func(v *store.OfflineArchiveFile) { v.OwnerID = "invalid" }},
		{"invalid file identity", "history", func(v *store.OfflineArchiveFile) { v.File.FileID = "invalid" }},
		{"completed receipt", "history", func(v *store.OfflineArchiveFile) { v.File.State = "complete" }},
		{"history length exceeds budget", "history", func(v *store.OfflineArchiveFile) { v.File.ByteLength = sp.MaxArchiveHistoryBytes + 1 }},
		{"timeline length exceeds budget", "timeline", func(v *store.OfflineArchiveFile) { v.File.ByteLength = sp.MaxArchiveTimelineBytes + 1 }},
		{"resource descriptor differs", "resource", func(v *store.OfflineArchiveFile) { v.File.Resource = encode(sp.Resource{}) }},
		{"unsupported purpose", "history", func(v *store.OfflineArchiveFile) { v.File.Purpose = "other" }},
		{"unowned formal path", "history", func(v *store.OfflineArchiveFile) { v.File.Path = "other" }},
		{"missing bundle", "history", func(v *store.OfflineArchiveFile) { v.Bundle = nil }},
		{"current pointer differs", "history", func(v *store.OfflineArchiveFile) { v.Bundle.HistoryID = uuid.NewString() }},
		{"current revision differs", "timeline", func(v *store.OfflineArchiveFile) { v.Bundle.Revision++ }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			item := offlineArchiveValidationFixture(t, test.purpose)
			test.change(&item)
			if err := ValidateOfflineStorageState(store.OfflineStorageState{ArchiveFiles: []store.OfflineArchiveFile{item}}); err == nil {
				t.Fatal("unsafe registration accepted")
			}
		})
	}
}

func offlineImageValidationFixture(t *testing.T) store.OfflineImageUpload {
	t.Helper()
	id, actor, uploadID, imageID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	spec := sp.ImageUploadSpec{UploadID: uploadID, ImageID: imageID, Target: sp.ImageTarget{ServerOrigin: "https://daynight.cc", ActorUserID: actor, Fence: sp.Fence{SessionID: id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}}, Name: "image.png", MediaType: "image/png", ByteLength: "7", SHA256: strings.Repeat("a", 64)}
	upload := store.SessionUploadRecord{SessionID: id, ActorID: actor, BlobID: uuid.NewString(), Spec: spec, Receipt: sp.ImageUploadReceipt{UploadID: uploadID, ImageID: imageID, Target: spec.Target, State: "receiving", AcceptedOffset: "7", Spec: sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}}}
	n, err := sessionresource.NewNamespace("", actor, id)
	if err != nil {
		t.Fatal(err)
	}
	path, err := n.ChunkPath(uploadID, 0)
	if err != nil {
		t.Fatal(err)
	}
	return store.OfflineImageUpload{OwnerID: actor, Upload: upload, Chunks: []store.StorageObject{{Bucket: sessionresource.Bucket, Path: path, ByteLength: 7, SHA256: spec.SHA256}}}
}

func TestOfflineValidationRejectsImageIdentityReceiptAndChunkChanges(t *testing.T) {
	valid := offlineImageValidationFixture(t)
	if err := ValidateOfflineStorageState(store.OfflineStorageState{Uploads: []store.OfflineImageUpload{valid}}); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		change func(*store.OfflineImageUpload)
	}{
		{"invalid namespace", func(v *store.OfflineImageUpload) { v.OwnerID = "invalid" }},
		{"actor mismatch", func(v *store.OfflineImageUpload) { v.Upload.ActorID = uuid.NewString() }},
		{"confirmed offset outside original", func(v *store.OfflineImageUpload) { v.Upload.Receipt.AcceptedOffset = "8" }},
		{"invalid formal blob identity", func(v *store.OfflineImageUpload) { v.Upload.BlobID = "invalid" }},
		{"chunk outside original upload", func(v *store.OfflineImageUpload) { v.Chunks[0].Path = "other" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			item := offlineImageValidationFixture(t)
			test.change(&item)
			if err := ValidateOfflineStorageState(store.OfflineStorageState{Uploads: []store.OfflineImageUpload{item}}); err == nil {
				t.Fatal("unsafe image settlement accepted")
			}
		})
	}
}
