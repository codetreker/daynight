package session

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestBackupV2CompletedTimelineRequiresSealedResourceClosure(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"valid", true},
		{"missing descriptor", false},
		{"missing original", false},
		{"bundle descriptor mismatch", false},
		{"ledger entry mismatch", false},
		{"committed without ready archive", false},
		{"published valid", true},
		{"published different timeline", false},
		{"published mixed versions", true},
		{"published v1 timeline mismatch", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, fileID, historyID, resourceID, blobID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			namespace, err := archiveNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			original := []byte("sealed original")
			length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Name: "original", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"original"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			timeline := sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}}
			body := encode(timeline)
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: timeline.Entries, Resources: []sp.Resource{resource}}, "epoch", 1)
			if err != nil {
				t.Fatal(err)
			}
			ledger.HistoryID = historyID
			refs := []sp.ArchiveResourceReference{{Resource: resource, BlobID: &blobID}}
			blobPath, err := BlobAddress("", owner, id, blobID)
			if err != nil {
				t.Fatal(err)
			}
			filePath := namespace.Directory() + "/files/" + fileID
			put := func(bucket, path string, body []byte) {
				t.Helper()
				if _, err := files.Put(t.Context(), bucket, path, bytes.NewReader(body)); err != nil {
					t.Fatal(err)
				}
			}
			put(archiveBucket, filePath+"/content", body)
			put("session-resources", blobPath, original)
			bundle := store.ArchiveBundle{SessionID: id, Phase: "sealed", Revision: 1, HistoryID: historyID, TimelineID: fileID, Ledger: encode(ledger), Resources: encode(refs)}
			file := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "timeline", State: "complete", SHA256: archiveDigest(body), ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1, Path: filePath, StagingReleased: true}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{file}, Resources: []store.SessionResourceRecord{{SessionID: id, Resource: resource, BlobID: blobID, BlobPath: blobPath}}}
			inventory.ArchiveTimeline = &store.StorageArchiveTimeline{FileID: fileID, State: "complete", Path: filePath, SHA256: archiveDigest(body), UploadVersion: 2, ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1}
			switch tc.name {
			case "missing descriptor":
				inventory.Resources = nil
			case "missing original":
				if err := files.Delete(t.Context(), "session-resources", blobPath); err != nil {
					t.Fatal(err)
				}
			case "bundle descriptor mismatch":
				refs[0].Resource.Name = "different"
				bundle.Resources = encode(refs)
			case "ledger entry mismatch":
				ledger.Entries[0].Revision = "2"
				bundle.Ledger = encode(ledger)
			case "committed without ready archive":
				bundle.Phase = "committed"
			case "published valid", "published different timeline", "published mixed versions", "published v1 timeline mismatch":
				manifestFileID := fileID
				if tc.name == "published different timeline" {
					manifestFileID = uuid.NewString()
					put(archiveBucket, namespace.Directory()+"/files/"+manifestFileID+"/content", body)
				}
				manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: id, Fence: sp.Fence{SessionID: id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}, Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Timeline: sp.ArchiveFileReference{FileID: manifestFileID, SHA256: archiveDigest(body), ByteLength: decimal(int64(len(body)))}, Resources: refs, Completeness: "complete"}
				manifestBytes := encode(manifest)
				manifestHash := archiveDigest(manifestBytes)
				manifestPath, err := namespace.ObjectPath(manifestHash)
				if err != nil {
					t.Fatal(err)
				}
				put(archiveBucket, manifestPath, manifestBytes)
				bundle.Phase, bundle.ManifestPath, bundle.ManifestHash, bundle.ManifestLength = "committed", manifestPath, manifestHash, decimal(int64(len(manifestBytes)))
				inventory.Archive = &store.StorageArchive{SchemaVersion: 3, Path: manifestPath, SHA256: manifestHash, ByteLength: int64(len(manifestBytes))}
				inventory.ArchiveTimeline = &store.StorageArchiveTimeline{FileID: fileID, State: "complete", Path: filePath, SHA256: archiveDigest(body), UploadVersion: 2, ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1}
				if tc.name == "published mixed versions" || tc.name == "published v1 timeline mismatch" {
					inventory.ArchiveTimeline.UploadVersion = 1
					history := file
					history.FileID, history.Purpose, history.Path = historyID, "history", namespace.Directory()+"/files/"+historyID
					inventory.ArchiveFilesV2 = []store.StorageArchiveFileV2{history}
					if tc.name == "published v1 timeline mismatch" {
						inventory.ArchiveTimeline.SHA256 = strings.Repeat("a", 64)
					}
				}
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}

func TestBackupV2RestartSuccessorIdentity(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"valid", true},
		{"missing successor", false},
		{"different digest", false},
		{"different revision", false},
		{"different purpose", false},
		{"wrong terminal error", false},
		{"wrong bundle pointer", false},
		{"successor cycle", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, oldID, newID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			n, err := archiveNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			stage, err := filestorage.ArchiveStagingPath(n, newID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = files.Put(t.Context(), archiveBucket, stage, bytes.NewReader(nil)); err != nil {
				t.Fatal(err)
			}
			current := store.StorageArchiveFileV2{UploadVersion: 2, FileID: newID, Purpose: "history", State: "receiving", SHA256: archiveDigest([]byte("history")), ByteLength: 7, TimelineRevision: 1, Path: n.Directory() + "/files/" + newID, Resource: json.RawMessage(`null`)}
			old := current
			old.FileID, old.Path, old.State, old.SuccessorFileID = oldID, n.Directory()+"/files/"+oldID, "failed", newID
			old.TerminalError = json.RawMessage(`{"code":"staging_corrupt"}`)
			bundle := store.ArchiveBundle{SessionID: id, Phase: "settling", Revision: 1, HistoryID: newID, Ledger: json.RawMessage(`{}`)}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{old, current}}
			switch tc.name {
			case "missing successor":
				inventory.ArchiveFilesV2 = inventory.ArchiveFilesV2[:1]
			case "different digest":
				inventory.ArchiveFilesV2[1].SHA256 = strings.Repeat("a", 64)
			case "different revision":
				inventory.ArchiveFilesV2[0].TimelineRevision++
			case "different purpose":
				inventory.ArchiveFilesV2[0].Purpose = "timeline"
			case "wrong terminal error":
				inventory.ArchiveFilesV2[0].TerminalError = json.RawMessage(`{"code":"invalid_content"}`)
			case "wrong bundle pointer":
				bundle.HistoryID = uuid.NewString()
			case "successor cycle":
				inventory.ArchiveFilesV2[1].State = "failed"
				inventory.ArchiveFilesV2[1].TerminalError = json.RawMessage(`{"code":"staging_corrupt"}`)
				inventory.ArchiveFilesV2[1].SuccessorFileID = oldID
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}

func TestBackupV2ReceivingResourceIdentity(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"valid", true}, {"prior revision", true}, {"future revision", false}, {"resource removed from newer history", true}, {"missing descriptor", false}, {"different length", false}, {"different hash", false}, {"invalid status", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, fileID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			blobPath, err := BlobAddress("", owner, id, fileID)
			if err != nil {
				t.Fatal(err)
			}
			body := []byte("pending bytes")
			length, hash, mime := decimal(int64(len(body))), archiveDigest(body), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Name: "original", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			n, err := archiveNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			stage, err := filestorage.ArchiveStagingPath(n, fileID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = files.Put(t.Context(), archiveBucket, stage, bytes.NewReader(nil)); err != nil {
				t.Fatal(err)
			}
			file := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "resource", State: "receiving", SHA256: hash, ByteLength: int64(len(body)), TimelineRevision: 1, Path: blobPath, Resource: encode(resource)}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"original"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{resource}}, "epoch", 1)
			if err != nil {
				t.Fatal(err)
			}
			ledger.HistoryID = uuid.NewString()
			bundle := store.ArchiveBundle{SessionID: id, Phase: "settling", Revision: 1, HistoryID: ledger.HistoryID, Ledger: encode(ledger)}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{file}}
			switch tc.name {
			case "prior revision":
				bundle.Revision = 2
			case "future revision":
				inventory.ArchiveFilesV2[0].TimelineRevision = 2
			case "resource removed from newer history":
				ledger.Resources = []sp.Resource{}
				bundle.Revision = 2
				bundle.Ledger = encode(ledger)
			case "missing descriptor":
				inventory.ArchiveFilesV2[0].Resource = json.RawMessage(`null`)
			case "different length":
				wrong := "1"
				resource.ByteLength = &wrong
				inventory.ArchiveFilesV2[0].Resource = encode(resource)
			case "different hash":
				wrong := strings.Repeat("a", 64)
				resource.SHA256 = &wrong
				inventory.ArchiveFilesV2[0].Resource = encode(resource)
			case "invalid status":
				resource.Status = "failed"
				inventory.ArchiveFilesV2[0].Resource = encode(resource)
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}

func TestBackupV2CompletedResourceRequiresPublishedOriginal(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"published", true}, {"missing metadata", false}, {"wrong blob identity", false}, {"missing original", false}, {"changed original", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, fileID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			body := []byte("original resource")
			length, hash, mime := decimal(int64(len(body))), archiveDigest(body), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Name: "resource", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			path, err := BlobAddress("", owner, id, fileID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = files.Put(t.Context(), "session-resources", path, bytes.NewReader(body)); err != nil {
				t.Fatal(err)
			}
			file := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "resource", State: "complete", SHA256: hash, ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1, Path: path, Resource: encode(resource), StagingReleased: true}
			bundle := store.ArchiveBundle{SessionID: id, Phase: "settling", Revision: 1}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{file}, Resources: []store.SessionResourceRecord{{SessionID: id, Resource: resource, BlobID: fileID, BlobPath: path}}}
			switch tc.name {
			case "missing metadata":
				inventory.Resources = nil
			case "wrong blob identity":
				inventory.Resources[0].BlobID = uuid.NewString()
			case "missing original":
				if err := files.Delete(t.Context(), "session-resources", path); err != nil {
					t.Fatal(err)
				}
			case "changed original":
				if _, err := files.Put(t.Context(), "session-resources", path, bytes.NewReader([]byte("changed resource!"))); err != nil {
					t.Fatal(err)
				}
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}

func TestBackupV2SealedUnavailableResource(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{{"unavailable original", true}, {"unavailable with blob", false}} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, fileID, historyID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			reason := "not retained"
			resource := sp.Resource{ResourceID: resourceID, Name: "unavailable", Status: "unavailable", Error: &reason}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"unavailable"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			timeline := sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}}
			body := encode(timeline)
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: timeline.Entries, Resources: []sp.Resource{resource}}, "epoch", 1)
			if err != nil {
				t.Fatal(err)
			}
			ledger.HistoryID = historyID
			refs := []sp.ArchiveResourceReference{{Resource: resource}}
			n, err := archiveNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			path := n.Directory() + "/files/" + fileID
			if _, err := files.Put(t.Context(), archiveBucket, path+"/content", bytes.NewReader(body)); err != nil {
				t.Fatal(err)
			}
			file := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "timeline", State: "complete", SHA256: archiveDigest(body), ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1, Path: path}
			saved := store.SessionResourceRecord{SessionID: id, Resource: resource}
			if tc.name == "unavailable with blob" {
				value := uuid.NewString()
				refs[0].BlobID = &value
			}
			bundle := store.ArchiveBundle{SessionID: id, Phase: "sealed", Revision: 1, HistoryID: historyID, TimelineID: fileID, Ledger: encode(ledger), Resources: encode(refs)}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{file}, Resources: []store.SessionResourceRecord{saved}}
			inventory.ArchiveTimeline = &store.StorageArchiveTimeline{FileID: fileID, State: "complete", Path: path, SHA256: archiveDigest(body), UploadVersion: 2, ByteLength: int64(len(body)), AcceptedOffset: int64(len(body)), TimelineRevision: 1}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}

// A later history may no longer reference a migration resource while its
// already confirmed upload is still a recoverable receipt.
func TestBackupV2ReceivingResourceAfterHistoryRevision(t *testing.T) {
	for _, tc := range []struct {
		phase, damage string
		want          bool
	}{
		{"sealed", "", true}, {"failed", "", true},
		{"sealed", "corrupt", true}, {"failed", "missing", false},
	} {
		t.Run(tc.phase+"/"+tc.damage, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			id, owner, fileID, historyID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			namespace, err := archiveNamespace("", owner, id)
			if err != nil {
				t.Fatal(err)
			}
			block := bytes.Repeat([]byte("a"), 512*1024)
			full := append(append([]byte(nil), block...), 'z')
			length, hash, mime := decimal(int64(len(full))), archiveDigest(full), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Name: "original", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			path, err := BlobAddress("", owner, id, fileID)
			if err != nil {
				t.Fatal(err)
			}
			blockPath, err := filestorage.ArchiveStagingPath(namespace, fileID)
			if err != nil {
				t.Fatal(err)
			}
			if tc.damage != "missing" {
				if tc.damage == "corrupt" {
					block[0] = 'b'
				}
				if _, err := files.Put(t.Context(), archiveBucket, blockPath, bytes.NewReader(block)); err != nil {
					t.Fatal(err)
				}
			}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"2","kind":"assistant_message","content":[]}`))
			if err != nil {
				t.Fatal(err)
			}
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}, "epoch", 1)
			if err != nil {
				t.Fatal(err)
			}
			ledger.HistoryID = historyID
			bundle := store.ArchiveBundle{SessionID: id, Phase: tc.phase, Revision: 2, HistoryID: historyID, Ledger: encode(ledger), Resources: json.RawMessage(`[]`)}
			file := store.StorageArchiveFileV2{UploadVersion: 2, FileID: fileID, Purpose: "resource", State: "receiving", SHA256: hash, ByteLength: int64(len(full)), AcceptedOffset: int64(len(block)), TimelineRevision: 1, Path: path, Resource: encode(resource)}
			err = VerifyStorageBackup(t.Context(), files, store.StorageInventory{SessionID: id, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{file}})
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}
