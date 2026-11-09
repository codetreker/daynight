package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type legacyArchiveConversion struct {
	Manifest                     sp.ArchiveManifest
	ManifestBytes, TimelineBytes []byte
	Original                     sp.ArchiveDocument
	Resources                    []store.SessionResourceRecord
}

// convertLegacyArchive is shared by the runtime migration and offline closure
// verification. All identities derive from the original immutable source.
func convertLegacyArchive(data []byte, migrationID uuid.UUID) (legacyArchiveConversion, error) {
	original, err := sp.DecodeArchive(data)
	if err != nil {
		return legacyArchiveConversion{}, err
	}
	refs, missing, err := sp.ArchiveReferences(original.Entries)
	if err != nil {
		return legacyArchiveConversion{}, err
	}
	timeline := encode(sp.ArchiveTimeline{Entries: original.Entries})
	fileID := uuid.NewSHA1(migrationID, []byte("timeline")).String()
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: original.SessionID, Fence: original.Fence, Provider: original.Provider, NativeSessionID: original.NativeSessionID, ControllerID: original.ControllerID, ControllerInstanceID: original.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: fileID, ByteLength: decimal(int64(len(timeline))), SHA256: archiveDigest(timeline)}, Resources: []sp.ArchiveResourceReference{}, Completeness: "complete"}
	result := legacyArchiveConversion{Original: original, TimelineBytes: timeline, Resources: []store.SessionResourceRecord{}}
	for _, value := range original.Resources {
		// Old archives may carry unreferenced saved artifacts. Keep their originals
		// in the resource store; only actual timeline references enter the manifest.
		record := store.SessionResourceRecord{SessionID: original.SessionID, Resource: value.Resource, MigrationID: migrationID.String()}
		ref := sp.ArchiveResourceReference{Resource: value.Resource}
		if value.Resource.Status == "available" {
			id := uuid.NewSHA1(migrationID, []byte(value.Resource.ResourceID)).String()
			record.BlobID = id
			ref.BlobID = &id
		} else if refs[value.Resource.ResourceID] {
			missing = true
		}
		result.Resources = append(result.Resources, record)
		if refs[value.Resource.ResourceID] {
			manifest.Resources = append(manifest.Resources, ref)
		}
	}
	if missing {
		manifest.Completeness = "partial"
	}
	result.Manifest = manifest
	result.ManifestBytes = encode(manifest)
	if _, err = sp.DecodeArchiveManifest(result.ManifestBytes); err != nil {
		return legacyArchiveConversion{}, err
	}
	if _, err = sp.VerifyArchiveClosure(manifest, timeline, func(ref sp.ArchiveResourceReference) ([]byte, error) {
		for _, value := range original.Resources {
			if value.Resource.ResourceID == ref.Resource.ResourceID && value.Data != nil {
				return base64.StdEncoding.Strict().DecodeString(*value.Data)
			}
		}
		return nil, model.ErrNotFound
	}); err != nil {
		return legacyArchiveConversion{}, err
	}
	return result, nil
}

func (s *Execution) migrateLegacyArchive(ctx context.Context, op *ArchiveOperation, source []byte, sourcePath string) (out []byte, result error) {
	sourceHash := archiveDigest(source)
	namespaceID, err := uuid.Parse(op.id)
	if err != nil {
		return nil, err
	}
	migrationID := uuid.NewSHA1(namespaceID, []byte(sourceHash))
	plan, err := convertLegacyArchive(source, migrationID)
	if err != nil {
		return nil, err
	}
	if plan.Manifest.RecordID != op.id {
		return nil, archiveConflict()
	}

	reused := map[string]bool{}
	originals := map[string]store.SessionResourceRecord{}
	err = s.archiveAccess(ctx, op.principal, op.project, op.task, op.id, op.finalizeMigration, func(tx *operationTx, r *record, _ task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		media, e := archiveMediaDAO(tx)
		if e != nil {
			return e
		}
		for i, record := range plan.Resources {
			existing, e := media.SavedSessionResource(ctx, op.id, record.Resource.ResourceID)
			if errors.Is(e, model.ErrNotFound) {
				continue
			}
			if e != nil {
				return e
			}
			if !jsonEqual(encode(existing.Resource), encode(record.Resource)) || existing.GCPending || (existing.BlobID == "") != (existing.BlobPath == "") {
				return archiveConflict()
			}
			originals[record.Resource.ResourceID] = existing
			if existing.Resource.Status == "available" && existing.BlobID != "" {
				path, e := BlobAddress(op.project, op.owner, op.id, existing.BlobID)
				if e != nil || path != existing.BlobPath {
					return archiveConflict()
				}
				plan.Resources[i] = existing
				reused[record.Resource.ResourceID] = true
				for j, ref := range plan.Manifest.Resources {
					if ref.Resource.ResourceID == record.Resource.ResourceID {
						blob := existing.BlobID
						plan.Manifest.Resources[j].BlobID = &blob
					}
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	plan.ManifestBytes = encode(plan.Manifest)
	manifestHash := archiveDigest(plan.ManifestBytes)
	manifestPath, err := archiveObjectPath(op.project, op.owner, op.id, manifestHash)
	if err != nil {
		return nil, err
	}
	namespace, err := archiveNamespace(op.project, op.owner, op.id)
	if err != nil {
		return nil, err
	}
	file := store.ArchiveBundleFile{SessionID: op.id, FileID: plan.Manifest.Timeline.FileID, Purpose: "timeline", SHA256: plan.Manifest.Timeline.SHA256, ByteLength: number(plan.Manifest.Timeline.ByteLength), AcceptedOffset: number(plan.Manifest.Timeline.ByteLength), State: "complete", Path: namespace.Directory() + "/files/" + plan.Manifest.Timeline.FileID}
	leaseID := uuid.NewString()
	ctx, finish, err := s.beginImageIO(ctx, op.id, leaseID)
	if err != nil {
		return nil, err
	}
	leased := false
	defer func() {
		result = joinImageCleanup(result, finish)
		if leased {
			result = errors.Join(result, s.releaseImageLease(context.WithoutCancel(ctx), op.principal, op.project, op.task, op.id, leaseID))
		}
	}()
	migration := store.ArchiveMigration{SessionID: op.id, MigrationID: migrationID.String(), SourcePath: sourcePath, SourceHash: sourceHash, SourceLength: int64(len(source)), TargetPath: manifestPath, TargetHash: manifestHash, Phase: "prepared"}
	access := func(work func(*operationTx, *record, store.SessionArchiveDAO, store.SessionResourceDAO) error) error {
		return s.archiveAccess(ctx, op.principal, op.project, op.task, op.id, op.finalizeMigration, func(tx *operationTx, r *record, _ task) error {
			if r.Owner != op.owner {
				return conflict()
			}
			dao, e := archiveDAO(tx)
			if e != nil {
				return e
			}
			media, e := archiveMediaDAO(tx)
			if e != nil {
				return e
			}
			return work(tx, r, dao, media)
		})
	}
	err = access(func(tx *operationTx, r *record, dao store.SessionArchiveDAO, media store.SessionResourceDAO) error {
		existing, e := dao.SessionArchiveMigration(ctx, op.id)
		if e == nil {
			if existing.MigrationID != migration.MigrationID || existing.SourcePath != sourcePath || existing.SourceHash != sourceHash || existing.SourceLength != migration.SourceLength || existing.TargetHash != manifestHash {
				return archiveConflict()
			}
			migration = existing
		} else if !errors.Is(e, model.ErrNotFound) {
			return e
		} else if e = dao.SaveSessionArchiveMigration(ctx, migration); e != nil {
			return e
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting {
			return conflict()
		}
		return acquireImageResourceLease(ctx, media, store.SessionResourceLease{SessionID: op.id, ID: leaseID, Kind: "archive", OwnerID: op.owner, DeleteEpoch: usage.DeleteEpoch})
	})
	if err != nil {
		return nil, err
	}
	leased = true
	for i, value := range plan.Original.Resources {
		record := &plan.Resources[i]
		if value.Data == nil {
			continue
		}
		path, e := BlobAddress(op.project, op.owner, op.id, record.BlobID)
		if e != nil {
			return nil, e
		}
		record.BlobPath = path
		if reused[record.Resource.ResourceID] {
			if e = verifyStorageObject(ctx, s.files, store.StorageObject{Bucket: sessionresource.Bucket, Path: path, ByteLength: number(*record.Resource.ByteLength), SHA256: *record.Resource.SHA256}); e != nil {
				return nil, e
			}
			continue
		}
		reader := base64.NewDecoder(base64.StdEncoding.Strict(), bytes.NewBufferString(*value.Data))
		info, e := s.files.Put(ctx, sessionresource.Bucket, path, reader)
		if e != nil {
			return nil, e
		}
		if decimal(info.Size) != *value.Resource.ByteLength {
			return nil, errors.New("legacy archive resource length mismatch")
		}
	}
	if _, err = s.files.Put(ctx, archiveBucket, file.Path+"/content", bytes.NewReader(plan.TimelineBytes)); err != nil {
		return nil, err
	}
	if _, err = s.files.Put(ctx, archiveBucket, manifestPath, bytes.NewReader(plan.ManifestBytes)); err != nil {
		return nil, err
	}
	migration.Phase = "files_durable"
	if err = access(func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.SessionResourceDAO) error {
		return dao.SaveSessionArchiveMigration(ctx, migration)
	}); err != nil {
		return nil, err
	}
	err = access(func(tx *operationTx, r *record, dao store.SessionArchiveDAO, media store.SessionResourceDAO) error {
		status, path, e := archiveStatus(ctx, tx, op.id)
		if e != nil {
			return e
		}
		if status.State != "ready" {
			return archiveConflict()
		}
		if status.SchemaVersion == 3 {
			if status.SHA256 == nil || *status.SHA256 != manifestHash {
				return archiveConflict()
			}
		} else if path != sourcePath || status.SHA256 == nil || *status.SHA256 != sourceHash {
			return archiveConflict()
		}
		usage, e := media.SessionResourceUsage(ctx, op.id)
		if e != nil {
			return e
		}
		if usage.Deleting {
			return conflict()
		}
		for _, record := range plan.Resources {
			existing, lookupErr := media.SavedSessionResource(ctx, op.id, record.Resource.ResourceID)
			original, existed := originals[record.Resource.ResourceID]
			if existed {
				if lookupErr != nil {
					return errors.Join(archiveConflict(), lookupErr)
				}
				if !jsonEqual(encode(existing), encode(original)) {
					return archiveConflict()
				}
				if original.Resource.Status == "available" && original.BlobID == "" {
					migrationDAO, capable := tx.dao.(store.SessionArchiveResourceMigrationDAO)
					if !capable {
						return archiveConflict()
					}
					e = migrationDAO.MigrateSessionArchiveResource(ctx, original, record)
				}
			} else if errors.Is(lookupErr, model.ErrNotFound) {
				e = media.InsertSessionResource(ctx, record)
			} else if lookupErr != nil {
				return lookupErr
			} else {
				return archiveConflict()
			}
			if e != nil {
				return e
			}
			if e = media.AddSessionResourceReference(ctx, store.SessionResourceReference{SessionID: op.id, ResourceID: record.Resource.ResourceID, Kind: "archive", ReferenceID: migrationID.String()}); e != nil {
				return e
			}
		}
		ledger, e := makeArchiveLedger(sp.ArchiveHistoryContent{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: decimal(r.SourceSeq), Entries: plan.Original.Entries, Resources: resourceDescriptors(plan.Manifest.Resources)}, r.Snapshot.HistoryEpoch, r.SourceSeq)
		if e != nil {
			return e
		}
		identity := sp.ArchivePrepareRequest{Fence: plan.Original.Fence, ControllerID: plan.Original.ControllerID, ControllerInstanceID: plan.Original.ControllerInstanceID}
		bundle := store.ArchiveBundle{SessionID: op.id, PrepareID: plan.Original.ControllerInstanceID, Phase: "committed", Revision: 1, Identity: encode(identity), Resources: encode(plan.Manifest.Resources), Ledger: encode(ledger), TimelineID: file.FileID, ManifestPath: manifestPath, ManifestHash: manifestHash, ManifestLength: decimal(int64(len(plan.ManifestBytes)))}
		if e = dao.SaveSessionArchiveBundle(ctx, bundle); e != nil {
			return e
		}
		if e = dao.SaveSessionArchiveFile(ctx, file); e != nil {
			return e
		}
		if e = dao.SetUnifiedSessionArchiveReady(ctx, op.id, manifestHash, len(plan.ManifestBytes), manifestPath, plan.Manifest.Completeness); e != nil {
			return e
		}
		migration.Phase = "committed"
		return dao.SaveSessionArchiveMigration(ctx, migration)
	})
	if err != nil {
		return nil, err
	}
	object, err := s.files.Open(ctx, archiveBucket, manifestPath)
	if err != nil {
		return nil, err
	}
	actual, readErr := io.ReadAll(io.LimitReader(object.Body, sp.MaxArchiveManifestBytes+1))
	closeErr := object.Body.Close()
	if err = errors.Join(readErr, closeErr); err != nil {
		return nil, err
	}
	if !bytes.Equal(actual, plan.ManifestBytes) {
		return nil, errors.New("legacy archive manifest readback differs")
	}
	if _, err = sp.VerifyArchiveClosure(plan.Manifest, plan.TimelineBytes, func(ref sp.ArchiveResourceReference) (data []byte, result error) {
		var path string
		for _, r := range plan.Resources {
			if r.Resource.ResourceID == ref.Resource.ResourceID {
				path = r.BlobPath
				break
			}
		}
		object, e := s.files.Open(ctx, sessionresource.Bucket, path)
		if e != nil {
			return nil, e
		}
		defer func() { result = archiveCleanupFailure(result, object.Body.Close()) }()
		return io.ReadAll(io.LimitReader(object.Body, sp.MaxArchiveBlobBytes+1))
	}); err != nil {
		return nil, err
	}
	migration.Phase = "verified"
	if err = access(func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, _ store.SessionResourceDAO) error {
		return dao.SaveSessionArchiveMigration(ctx, migration)
	}); err != nil {
		return nil, err
	}
	// The immutable legacy source is retained even after verification. Cleanup of
	// the owning record namespace remains the deletion owner's responsibility.
	return plan.ManifestBytes, nil
}
func resourceDescriptors(refs []sp.ArchiveResourceReference) []sp.Resource {
	out := []sp.Resource{}
	for _, ref := range refs {
		out = append(out, ref.Resource)
	}
	return out
}
