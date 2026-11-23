package session

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// A legacy archive migration can replace a bundle while retaining a failed v2
// upload receipt. The migrated bundle has no history file or history ID.
func TestBackupV2FailedReceiptWithCommittedLegacyMigration(t *testing.T) {
	for _, tc := range []struct {
		name string
		want bool
	}{
		{"complete migration", true},
		{"missing legacy source", false},
		{"missing migrated timeline", false},
		{"missing resource", false},
		{"wrong ledger digest", false},
		{"wrong ledger revision", false},
		{"wrong migration identity", false},
		{"wrong published manifest", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			owner, sessionID := uuid.NewString(), uuid.NewString()
			original := []byte("legacy original")
			length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			encoded := base64.StdEncoding.EncodeToString(original)
			resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resource.ResourceID + `","label":"legacy"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			doc := sp.ArchiveDocument{SchemaVersion: 1, Fence: sp.Fence{SessionID: sessionID, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{{Resource: resource, Data: &encoded}}}
			source := encode(doc)
			sourceHash := archiveDigest(source)
			migrationID := uuid.NewSHA1(uuid.MustParse(sessionID), []byte(sourceHash))
			plan, err := convertLegacyArchive(source, migrationID)
			if err != nil {
				t.Fatal(err)
			}
			n, err := archiveNamespace("", owner, sessionID)
			if err != nil {
				t.Fatal(err)
			}
			sourcePath, err := n.ObjectPath(sourceHash)
			if err != nil {
				t.Fatal(err)
			}
			targetHash := archiveDigest(plan.ManifestBytes)
			targetPath, err := n.ObjectPath(targetHash)
			if err != nil {
				t.Fatal(err)
			}
			timelinePath := n.Directory() + "/files/" + plan.Manifest.Timeline.FileID
			put := func(bucket, path string, body []byte) {
				t.Helper()
				if _, err := files.Put(t.Context(), bucket, path, bytes.NewReader(body)); err != nil {
					t.Fatal(err)
				}
			}
			if tc.name != "missing legacy source" {
				put(archiveBucket, sourcePath, source)
			}
			put(archiveBucket, targetPath, plan.ManifestBytes)
			if tc.name != "missing migrated timeline" {
				put(archiveBucket, timelinePath+"/content", plan.TimelineBytes)
			}
			for i := range plan.Resources {
				plan.Resources[i].BlobPath, err = BlobAddress("", owner, sessionID, plan.Resources[i].BlobID)
				if err != nil {
					t.Fatal(err)
				}
				if tc.name != "missing resource" {
					put("session-resources", plan.Resources[i].BlobPath, original)
				}
			}
			// migrateLegacyArchive builds its ledger directly from the restored
			// snapshot, including an empty history epoch in old records.
			ledger, err := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "", SourceThrough: "0", Entries: plan.Original.Entries, Resources: resourceDescriptors(plan.Manifest.Resources)}, "", 0)
			if err != nil {
				t.Fatal(err)
			}
			bundle := store.ArchiveBundle{SessionID: sessionID, PrepareID: doc.ControllerInstanceID, Phase: "committed", Revision: 1, Resources: encode(plan.Manifest.Resources), Ledger: encode(ledger), TimelineID: plan.Manifest.Timeline.FileID, ManifestPath: targetPath, ManifestHash: targetHash, ManifestLength: decimal(int64(len(plan.ManifestBytes)))}
			migration := store.ArchiveMigration{SessionID: sessionID, MigrationID: migrationID.String(), SourcePath: sourcePath, SourceHash: sourceHash, SourceLength: int64(len(source)), TargetPath: targetPath, TargetHash: targetHash, Phase: "committed"}
			proof := sha256.Sum256([]byte("daynight-archive-prefix-v2"))
			failedID := uuid.NewString()
			failed := store.StorageArchiveFileV2{UploadVersion: 2, FileID: failedID, Purpose: "history", State: "failed", SHA256: archiveDigest([]byte("history")), ByteLength: 7, Path: n.Directory() + "/files/" + failedID, TimelineRevision: 1, PrefixProof: proof[:], Resource: json.RawMessage(`null`), TerminalError: json.RawMessage(`{"code":"staging_corrupt"}`)}
			timeline := store.StorageArchiveTimeline{UploadVersion: 1, FileID: plan.Manifest.Timeline.FileID, State: "complete", Path: timelinePath, SHA256: plan.Manifest.Timeline.SHA256, ByteLength: int64(len(plan.TimelineBytes)), AcceptedOffset: int64(len(plan.TimelineBytes)), TimelineRevision: 1}
			archive := store.StorageArchive{SchemaVersion: 3, Path: targetPath, SHA256: targetHash, ByteLength: int64(len(plan.ManifestBytes))}
			inventory := store.StorageInventory{SessionID: sessionID, OwnerID: owner, Archive: &archive, Migration: &migration, Resources: plan.Resources, ArchiveBundle: &bundle, ArchiveTimeline: &timeline, ArchiveFilesV2: []store.StorageArchiveFileV2{failed}}
			switch tc.name {
			case "wrong ledger digest":
				ledger.Entries[0].SHA256 = archiveDigest([]byte("different"))
				bundle.Ledger = encode(ledger)
			case "wrong ledger revision":
				ledger.Entries[0].Revision = "2"
				bundle.Ledger = encode(ledger)
			case "wrong migration identity":
				migration.MigrationID = uuid.NewString()
			case "wrong published manifest":
				archive.SHA256 = archiveDigest([]byte("other"))
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != tc.want {
				t.Fatalf("verification error = %v, want success %t", err, tc.want)
			}
		})
	}
}
