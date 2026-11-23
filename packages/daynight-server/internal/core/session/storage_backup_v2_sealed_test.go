package session

import (
	"bytes"
	"crypto/sha256"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// A sealed bundle already protects its descriptors, even before a timeline
// upload is complete. A v1 timeline can coexist with a v2 history row.
func TestBackupV2SealedBundleBeforeManifest(t *testing.T) {
	for _, tc := range []struct {
		name, timeline, damage string
		want                   bool
	}{
		{"no timeline", "none", "", true},
		{"no timeline missing descriptor", "none", "descriptor", false},
		{"no timeline resource list mismatch", "none", "bundle", false},
		{"no timeline missing original", "none", "original", false},
		{"receiving timeline", "receiving", "", true},
		{"receiving timeline missing descriptor", "receiving", "descriptor", false},
		{"v1 complete timeline", "v1", "", true},
		{"v1 complete timeline differs from ledger", "v1", "timeline", false},
		{"v1 complete timeline missing descriptor", "v1", "descriptor", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			sessionID, owner, historyID, timelineID, resourceID, blobID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			n, err := archiveNamespace("", owner, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			original := []byte("original image")
			length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Name: "original", Status: "available", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"original"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			timeline := sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}}
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "epoch", SourceThrough: "1", Entries: timeline.Entries, Resources: []sp.Resource{resource}}, "epoch", 1)
			if err != nil {
				t.Fatal(err)
			}
			ledger.HistoryID = historyID
			blobPath, err := BlobAddress("", owner, sessionID, blobID)
			if err != nil {
				t.Fatal(err)
			}
			if tc.damage != "original" {
				if _, err = files.Put(t.Context(), "session-resources", blobPath, bytes.NewReader(original)); err != nil {
					t.Fatal(err)
				}
			}
			refs := []sp.ArchiveResourceReference{{Resource: resource, BlobID: &blobID}}
			if tc.damage == "bundle" {
				refs = nil
			}
			bundle := store.ArchiveBundle{SessionID: sessionID, Phase: "sealed", Revision: 1, HistoryID: historyID, Ledger: encode(ledger), Resources: encode(refs)}
			proof := sha256.Sum256([]byte("daynight-archive-prefix-v2"))
			history := store.StorageArchiveFileV2{UploadVersion: 2, FileID: historyID, Purpose: "history", State: "complete", SHA256: archiveDigest([]byte("h")), ByteLength: 1, AcceptedOffset: 1, TimelineRevision: 1, Path: n.Directory() + "/files/" + historyID, PrefixProof: proof[:]}
			inventory := store.StorageInventory{SessionID: sessionID, OwnerID: owner, ArchiveBundle: &bundle, ArchiveFilesV2: []store.StorageArchiveFileV2{history}, Resources: []store.SessionResourceRecord{{SessionID: sessionID, Resource: resource, BlobID: blobID, BlobPath: blobPath}}}
			if tc.damage == "descriptor" {
				inventory.Resources = nil
			}
			if tc.timeline != "none" {
				bundle.TimelineID = timelineID
				path := n.Directory() + "/files/" + timelineID
				if tc.damage == "timeline" {
					entry.Revision = "2"
					timeline.Entries = []sp.TimelineEntry{entry}
				}
				body := encode(timeline)
				tline := &store.StorageArchiveTimeline{FileID: timelineID, Path: path, SHA256: archiveDigest(body), ByteLength: int64(len(body)), TimelineRevision: 1}
				if tc.timeline == "receiving" {
					tline.UploadVersion, tline.State = 2, "receiving"
					f := store.StorageArchiveFileV2{UploadVersion: 2, FileID: timelineID, Purpose: "timeline", State: "receiving", SHA256: tline.SHA256, ByteLength: tline.ByteLength, TimelineRevision: 1, Path: path, PrefixProof: proof[:]}
					inventory.ArchiveFilesV2 = append(inventory.ArchiveFilesV2, f)
				} else {
					tline.UploadVersion, tline.State, tline.AcceptedOffset = 1, "complete", int64(len(body))
					if _, err = files.Put(t.Context(), archiveBucket, path+"/content", bytes.NewReader(body)); err != nil {
						t.Fatal(err)
					}
					inventory.Objects = append(inventory.Objects, store.StorageObject{Bucket: archiveBucket, Path: path + "/content", SHA256: tline.SHA256, ByteLength: tline.ByteLength})
				}
				inventory.ArchiveTimeline = tline
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %v", err, tc.want)
			}
		})
	}
}
