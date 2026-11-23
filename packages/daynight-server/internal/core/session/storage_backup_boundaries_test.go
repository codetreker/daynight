package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type optionalBackupFailure struct {
	openErr, readErr, closeErr error
}

func (f optionalBackupFailure) Open(context.Context, string, string) (filestorage.Object, error) {
	if f.openErr != nil {
		return filestorage.Object{}, f.openErr
	}
	return filestorage.Object{Body: optionalBackupBody{Reader: bytes.NewReader([]byte("original")), readErr: f.readErr, closeErr: f.closeErr}}, nil
}

type optionalBackupBody struct {
	io.Reader
	readErr, closeErr error
}

func (b optionalBackupBody) Read(p []byte) (int, error) {
	if b.readErr != nil {
		return 0, b.readErr
	}
	return b.Reader.Read(p)
}
func (b optionalBackupBody) Close() error { return b.closeErr }

func TestOptionalBackupObjectOnlyAllowsMissingOpen(t *testing.T) {
	id, owner := uuid.NewString(), uuid.NewString()
	namespace, err := archiveNamespace("", owner, id)
	if err != nil {
		t.Fatal(err)
	}
	inventory := store.StorageInventory{SessionID: id, OwnerID: owner, Objects: []store.StorageObject{{Bucket: "session-resources", Path: namespace.Directory() + "/uploads/original/0", ByteLength: 8, SHA256: archiveDigest([]byte("original")), Optional: true}}}
	for _, tc := range []struct {
		name  string
		files optionalBackupFailure
		want  error
	}{
		{"missing at open", optionalBackupFailure{openErr: fs.ErrNotExist}, nil},
		{"only missing causes at open", optionalBackupFailure{openErr: errors.Join(fs.ErrNotExist, fs.ErrNotExist)}, nil},
		{"missing and permission denied at open", optionalBackupFailure{openErr: errors.Join(fs.ErrNotExist, fs.ErrPermission)}, fs.ErrPermission},
		{"permission denied at open", optionalBackupFailure{openErr: fs.ErrPermission}, fs.ErrPermission},
		{"missing during read", optionalBackupFailure{readErr: fs.ErrNotExist}, fs.ErrNotExist},
		{"missing during close", optionalBackupFailure{closeErr: fs.ErrNotExist}, fs.ErrNotExist},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := VerifyStorageBackup(t.Context(), tc.files, inventory)
			if tc.want == nil && err != nil || tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("optional object failure = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestBackupClosureRejectsInvalidMetadataAndRetainsInlineOriginals(t *testing.T) {
	for _, kind := range []string{"inline-original", "inline-corrupt", "blob-identity", "object-bucket", "object-owner", "object-missing", "archive-hash", "archive-length", "archive-missing", "legacy-original", "legacy-terminal-invalid", "unknown-reader", "wrong-record"} {
		t.Run(kind, func(t *testing.T) {
			files, e := local.New(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer files.Close()
			id, owner := uuid.NewString(), uuid.NewString()
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner}
			namespace, e := archiveNamespace("", owner, id)
			if e != nil {
				t.Fatal(e)
			}
			body := []byte("x")
			length, hash, mime := "1", archiveDigest(body), "text/plain"
			resource := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime}
			switch kind {
			case "inline-original", "inline-corrupt":
				inventory.InlineResources = []store.StorageInlineResource{{Resource: resource, Content: body}}
				inventory.Resources = []store.SessionResourceRecord{{Resource: resource}}
				if kind == "inline-corrupt" {
					inventory.InlineResources[0].Content = []byte("changed")
				}
			case "blob-identity":
				inventory.Resources = []store.SessionResourceRecord{{Resource: resource, BlobID: "foreign"}}
			case "object-bucket":
				inventory.Objects = []store.StorageObject{{Bucket: "unknown", Path: namespace.Directory() + "/original"}}
			case "object-owner":
				inventory.Objects = []store.StorageObject{{Bucket: archiveBucket, Path: "foreign/original"}}
			case "object-missing":
				inventory.Objects = []store.StorageObject{{Bucket: archiveBucket, Path: namespace.Directory() + "/missing", ByteLength: 1, SHA256: hash}}
			default:
				data := []byte(`{}`)
				version := 1
				if kind == "legacy-original" {
					data = encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{localEntry(t, "1")}, Resources: []sp.ArchiveResource{}})
				}
				if kind == "legacy-terminal-invalid" {
					version = 2
				}
				if kind == "unknown-reader" {
					version = 9
				}
				if kind == "wrong-record" {
					version = 3
					other := uuid.NewString()
					data = encode(sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: other, Fence: sp.Fence{SessionID: other, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Timeline: sp.ArchiveFileReference{FileID: uuid.NewString(), SHA256: archiveDigest([]byte("x")), ByteLength: "1"}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"})
				}
				digest := archiveDigest(data)
				path, _ := namespace.ObjectPath(digest)
				inventory.Archive = &store.StorageArchive{SchemaVersion: version, Path: path, SHA256: digest, ByteLength: int64(len(data))}
				if kind != "archive-missing" {
					if _, e = files.Put(t.Context(), archiveBucket, path, bytes.NewReader(data)); e != nil {
						t.Fatal(e)
					}
				}
				if kind == "archive-hash" {
					inventory.Archive.SHA256 = "invalid"
				}
				if kind == "archive-length" {
					inventory.Archive.ByteLength = 0
				}
			}
			e = VerifyStorageBackup(t.Context(), files, inventory)
			if (e == nil) != (kind == "inline-original" || kind == "legacy-original") {
				t.Fatal("backup closure changed known-original semantics", kind, e)
			}
		})
	}
}

func TestBackupMigrationReconcilesOriginalAndReusedBlobIdentities(t *testing.T) {
	for _, kind := range []string{"durable", "verified", "invalid-source-hash", "invalid-source-length", "invalid-target-hash", "invalid-source", "invalid-target", "resource-count", "descriptor", "foreign-blob", "reused-blob", "manifest-identity"} {
		t.Run(kind, func(t *testing.T) {
			files, e := local.New(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer files.Close()
			id, owner := uuid.NewString(), uuid.NewString()
			namespace, e := archiveNamespace("", owner, id)
			if e != nil {
				t.Fatal(e)
			}
			original := []byte("retained original")
			length, hash, mime := decimal(int64(len(original))), archiveDigest(original), "text/plain"
			encoded := base64.StdEncoding.EncodeToString(original)
			message := "not captured"
			available := sp.Resource{ResourceID: uuid.NewString(), Status: "available", Name: "original", ByteLength: &length, SHA256: &hash, MediaType: &mime}
			unavailable := sp.Resource{ResourceID: uuid.NewString(), Status: "failed", Name: "unavailable", Error: &message}
			entry, e := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + available.ResourceID + `","label":"original"},{"type":"resource","resourceId":"` + unavailable.ResourceID + `","label":"not captured"}]}`))
			if e != nil {
				t.Fatal(e)
			}
			source := encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{{Resource: available, Data: &encoded}, {Resource: unavailable}}})
			if kind == "invalid-source" {
				source = []byte(`{}`)
			}
			sourceHash := archiveDigest(source)
			migrationID := uuid.NewSHA1(uuid.MustParse(id), []byte(sourceHash))
			sourcePath, _ := namespace.ObjectPath(sourceHash)
			// The target always derives from a valid original; malformed retained sources
			// must fail before target metadata can be trusted.
			validSource := source
			if kind == "invalid-source" {
				validSource = encode(sp.ArchiveDocument{SchemaVersion: 1, Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}})
			}
			plan, e := convertLegacyArchive(validSource, migrationID)
			if e != nil {
				t.Fatal(e)
			}
			manifest := plan.Manifest
			switch kind {
			case "resource-count":
				manifest.Resources = nil
			case "descriptor":
				manifest.Resources[0].Resource.Name = "replacement"
			case "foreign-blob", "reused-blob":
				blob := uuid.NewString()
				manifest.Resources[0].BlobID = &blob
			case "manifest-identity":
				manifest.ControllerInstanceID = uuid.NewString()
			}
			target := encode(manifest)
			if kind == "invalid-target" {
				target = []byte(`{}`)
			}
			targetHash := archiveDigest(target)
			targetPath, _ := namespace.ObjectPath(targetHash)
			migration := store.ArchiveMigration{SessionID: id, MigrationID: migrationID.String(), SourcePath: sourcePath, SourceHash: sourceHash, SourceLength: int64(len(source)), TargetPath: targetPath, TargetHash: targetHash, Phase: "files_durable"}
			inventory := store.StorageInventory{SessionID: id, OwnerID: owner, Migration: &migration}
			put := func(path string, data []byte) {
				t.Helper()
				if _, e := files.Put(t.Context(), archiveBucket, path, bytes.NewReader(data)); e != nil {
					t.Fatal(e)
				}
			}
			put(sourcePath, source)
			put(targetPath, target)
			put(namespace.Directory()+"/files/"+plan.Manifest.Timeline.FileID+"/content", plan.TimelineBytes)
			for _, record := range plan.Resources {
				if record.Resource.Status != "available" {
					continue
				}
				if kind == "reused-blob" {
					record.BlobID = *manifest.Resources[0].BlobID
					inventory.Resources = append(inventory.Resources, record)
				}
				path, e := BlobAddress("", owner, id, record.BlobID)
				if e != nil {
					t.Fatal(e)
				}
				if _, e = files.Put(t.Context(), "session-resources", path, bytes.NewReader(original)); e != nil {
					t.Fatal(e)
				}
			}
			if kind == "verified" {
				migration.Phase = "verified"
				inventory.Archive = &store.StorageArchive{SchemaVersion: 3, Path: targetPath, SHA256: targetHash}
			}
			if kind == "invalid-source-hash" {
				migration.SourceHash = "invalid"
			}
			if kind == "invalid-source-length" {
				migration.SourceLength++
			}
			if kind == "invalid-target-hash" {
				migration.TargetHash = "invalid"
			}
			e = verifyBackupMigration(t.Context(), files, inventory)
			if (e == nil) != (kind == "durable" || kind == "verified" || kind == "reused-blob") {
				t.Fatal("migration backup accepted changed identity or refused original reuse", kind, e)
			}
		})
	}
}

type sourceReadFailureDAO struct{ *sourceCheckpointDAO }

func (d sourceReadFailureDAO) SessionSourceHash(context.Context, store.SessionSourceHash) ([]byte, error) {
	return nil, archiveDependencyFailure
}
func TestStoppedSourceCheckpointRetainsAcknowledgementReadFailure(t *testing.T) {
	f, d, in := stoppedCheckpointFixture(t)
	before := encode(f.r.Snapshot)
	_, e := f.s.applyStoppedSourceTail(t.Context(), &operationTx{dao: sourceReadFailureDAO{d}}, f.r, in)
	if !errors.Is(e, archiveDependencyFailure) || f.r.SourceSeq != 0 || !bytes.Equal(before, encode(f.r.Snapshot)) {
		t.Fatal("source hash read failure changed original checkpoint", e)
	}
}

func TestArchiveLedgerRejectsSameCountForeignDescriptor(t *testing.T) {
	id := uuid.NewString()
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"resource","resourceId":"` + id + `","label":"original"}]`)}}
	_, e := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: "original", SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{{ResourceID: uuid.NewString()}}}, "original", 1)
	if e == nil {
		t.Fatal("matching descriptor count concealed replacement resource identity")
	}
}

func TestClosedArchiveCannotAcceptAnotherFile(t *testing.T) {
	op, _, r := archiveFlowFixture(t)
	op.closed = true
	body := activeHistoryBytes(r, localEntry(t, "1"))
	if _, e := op.PutArchiveFile(t.Context(), "history", uuid.NewString(), 0, int64(len(body)), archiveDigest(body), archiveDigest(body), body); e == nil {
		t.Fatal("closed archive accepted a source file")
	}
}
