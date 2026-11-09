package session

import (
	"bytes"
	"encoding/base64"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestRestoredMigrationVerifiesRetainedSourceAndDurableTargetPhases(t *testing.T) {
	for _, damage := range []string{"none", "prepared-no-target", "missing-source", "corrupt-source", "missing-target", "corrupt-target", "missing-timeline", "missing-unused-original", "foreign-source", "foreign-target", "replacement-migration", "unknown-phase", "unpublished-commit"} {
		t.Run(damage, func(t *testing.T) {
			files, e := local.New(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer files.Close()
			owner, session := uuid.NewString(), uuid.NewString()
			original := []byte("retained original")
			length, digest, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			encoded := base64.StdEncoding.EncodeToString(original)
			resources := []sp.ArchiveResource{}
			for i := 0; i < 2; i++ {
				resources = append(resources, sp.ArchiveResource{Resource: sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &digest}, Data: &encoded})
			}
			entry, e := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resources[0].Resource.ResourceID + `","label":"legacy"}]}`))
			if e != nil {
				t.Fatal(e)
			}
			doc := sp.ArchiveDocument{SchemaVersion: 1, Fence: sp.Fence{SessionID: session, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: resources}
			source := encode(doc)
			sourceHash := archiveDigest(source)
			migrationID := uuid.NewSHA1(uuid.MustParse(session), []byte(sourceHash))
			plan, e := convertLegacyArchive(source, migrationID)
			if e != nil {
				t.Fatal(e)
			}
			namespace, e := archiveNamespace("", owner, session)
			if e != nil {
				t.Fatal(e)
			}
			sourcePath, _ := namespace.ObjectPath(sourceHash)
			targetHash := archiveDigest(plan.ManifestBytes)
			targetPath, _ := namespace.ObjectPath(targetHash)
			timelinePath := namespace.Directory() + "/files/" + plan.Manifest.Timeline.FileID + "/content"
			put := func(bucket, path string, data []byte) {
				t.Helper()
				if _, e := files.Put(t.Context(), bucket, path, bytes.NewReader(data)); e != nil {
					t.Fatal(e)
				}
			}
			put(archiveBucket, sourcePath, source)
			put(archiveBucket, targetPath, plan.ManifestBytes)
			put(archiveBucket, timelinePath, plan.TimelineBytes)
			paths := []string{}
			for _, r := range plan.Resources {
				path, e := BlobAddress("", owner, session, r.BlobID)
				if e != nil {
					t.Fatal(e)
				}
				paths = append(paths, path)
				put("session-resources", path, original)
			}
			migration := store.ArchiveMigration{SessionID: session, MigrationID: migrationID.String(), SourcePath: sourcePath, SourceHash: sourceHash, SourceLength: int64(len(source)), TargetPath: targetPath, TargetHash: targetHash, Phase: "files_durable"}
			inventory := store.StorageInventory{SessionID: session, OwnerID: owner, Migration: &migration}
			switch damage {
			case "prepared-no-target":
				migration.Phase = "prepared"
				e = files.Delete(t.Context(), archiveBucket, targetPath)
			case "missing-source":
				e = files.Delete(t.Context(), archiveBucket, sourcePath)
			case "corrupt-source":
				put(archiveBucket, sourcePath, []byte("changed"))
			case "missing-target":
				e = files.Delete(t.Context(), archiveBucket, targetPath)
			case "corrupt-target":
				put(archiveBucket, targetPath, []byte("changed"))
			case "missing-timeline":
				e = files.Delete(t.Context(), archiveBucket, timelinePath)
			case "missing-unused-original":
				e = files.Delete(t.Context(), "session-resources", paths[1])
			case "foreign-source":
				migration.SourcePath = "foreign/source"
			case "foreign-target":
				migration.TargetPath = "foreign/target"
			case "replacement-migration":
				migration.MigrationID = uuid.NewString()
			case "unknown-phase":
				migration.Phase = "unknown"
			case "unpublished-commit":
				migration.Phase = "committed"
			}
			if e != nil {
				t.Fatal(e)
			}
			e = VerifyStorageBackup(t.Context(), files, inventory)
			if (e == nil) != (damage == "none" || damage == "prepared-no-target") {
				t.Fatal(damage, e)
			}
		})
	}
}

func TestRestoredStorageRequiresExactExternalArchiveClosure(t *testing.T) {
	for _, damage := range []string{"none", "missing-original", "corrupt-original", "missing-timeline", "corrupt-manifest", "foreign-namespace", "different-descriptor", "missing-descriptor"} {
		t.Run(damage, func(t *testing.T) {
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer files.Close()
			session, owner, claim, controller, instance, resourceID, blobID, fileID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			original := []byte("original")
			length, hash, mime := "8", archiveDigest(original), "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Status: "available", Name: "original", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"original"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			timeline := encode(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
			manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: session, Fence: sp.Fence{SessionID: session, ClaimID: claim, ExecutionGeneration: "1"}, Provider: "codex", ControllerID: controller, ControllerInstanceID: instance, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: archiveDigest(timeline), ByteLength: decimal(int64(len(timeline)))}, Resources: []sp.ArchiveResourceReference{{Resource: resource, BlobID: &blobID}}, Completeness: "complete"}
			namespace, err := archiveNamespace("", owner, session)
			if err != nil {
				t.Fatal(err)
			}
			blobPath, err := BlobAddress("", owner, session, blobID)
			if err != nil {
				t.Fatal(err)
			}
			data := encode(manifest)
			manifestPath, err := namespace.ObjectPath(archiveDigest(data))
			if err != nil {
				t.Fatal(err)
			}
			timelinePath := namespace.Directory() + "/files/" + fileID + "/content"
			put := func(bucket, path string, data []byte) {
				t.Helper()
				if _, err := files.Put(t.Context(), bucket, path, bytes.NewReader(data)); err != nil {
					t.Fatal(err)
				}
			}
			put("session-resources", blobPath, original)
			put(archiveBucket, timelinePath, timeline)
			put(archiveBucket, manifestPath, data)
			inventory := store.StorageInventory{SessionID: session, OwnerID: owner, Archive: &store.StorageArchive{SchemaVersion: 3, Path: manifestPath, SHA256: archiveDigest(data), ByteLength: int64(len(data))}, Resources: []store.SessionResourceRecord{{SessionID: session, Resource: resource, BlobID: blobID, BlobPath: blobPath}}}
			switch damage {
			case "missing-original":
				err = files.Delete(t.Context(), "session-resources", blobPath)
			case "corrupt-original":
				put("session-resources", blobPath, []byte("changed!"))
			case "missing-timeline":
				err = files.Delete(t.Context(), archiveBucket, timelinePath)
			case "corrupt-manifest":
				put(archiveBucket, manifestPath, []byte("changed"))
			case "foreign-namespace":
				inventory.OwnerID = uuid.NewString()
			case "different-descriptor":
				inventory.Resources[0].Resource.Name = "different"
			case "missing-descriptor":
				inventory.Resources = nil
			}
			if err != nil {
				t.Fatal(err)
			}
			err = VerifyStorageBackup(t.Context(), files, inventory)
			if (err == nil) != (damage == "none") {
				t.Fatalf("damage %s: %v", damage, err)
			}
		})
	}
}

func TestBackupReaderNeverInitializesOrMutatesVolume(t *testing.T) {
	root := t.TempDir()
	writer, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Put(t.Context(), "sample", "original", bytes.NewReader([]byte("original"))); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	reader, err := local.OpenReadOnly(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	object, err := reader.Open(t.Context(), "sample", "original")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err = object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Fatal(string(got))
	}
	if _, err = reader.Put(t.Context(), "sample", "new", bytes.NewReader(nil)); err == nil {
		t.Fatal("read-only storage accepted put")
	}
	if err = reader.Delete(t.Context(), "sample", "original"); err == nil {
		t.Fatal("read-only storage accepted delete")
	}
	if _, err = local.OpenReadOnly(root + "/missing"); err == nil {
		t.Fatal("missing backup root was initialized")
	}
}
