package session

import (
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

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
