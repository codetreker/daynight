package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// verifyArchiveV2Prefix reads only acknowledged block addresses. A first
// unconfirmed object may exist after an interrupted write and is not required.
func verifyArchiveV2Prefix(ctx context.Context, files backupStorageReader, namespace sessionarchive.Namespace, file store.StorageArchiveFileV2) error {
	if file.AcceptedOffset < 0 || file.AcceptedOffset > file.ByteLength || (file.AcceptedOffset != file.ByteLength && file.AcceptedOffset%sessionarchive.BlockSize != 0) || len(file.PrefixProof) != sha256.Size {
		return errors.New("invalid archive confirmed prefix")
	}
	proof := sessionarchive.InitialPrefixProof()
	for offset := int64(0); offset < file.AcceptedOffset; offset += sessionarchive.BlockSize {
		length := min(sessionarchive.BlockSize, file.ByteLength-offset)
		if offset+length > file.AcceptedOffset {
			return errors.New("partial confirmed archive block")
		}
		path, err := namespace.BlockPath(file.FileID, offset)
		if err != nil {
			return err
		}
		object, err := files.Open(ctx, archiveBucket, path)
		if err != nil {
			return err
		}
		h := sha256.New()
		size, readErr := io.Copy(h, io.LimitReader(object.Body, length+1))
		closeErr := object.Body.Close()
		if err = archiveCleanupFailure(readErr, closeErr); err != nil {
			return err
		}
		if size != length {
			return errors.New("archive block length mismatch")
		}
		var digest [sha256.Size]byte
		copy(digest[:], h.Sum(nil))
		proof = sessionarchive.AdvancePrefixProof(proof, uint64(offset), uint32(length), digest)
	}
	if !bytes.Equal(proof[:], file.PrefixProof) {
		return errors.New("archive prefix proof mismatch")
	}
	return nil
}

func verifyArchiveV2Files(ctx context.Context, files backupStorageReader, inventory store.StorageInventory, namespace sessionarchive.Namespace) error {
	byFile := make(map[string]store.StorageArchiveFileV2, len(inventory.ArchiveFilesV2))
	for _, file := range inventory.ArchiveFilesV2 {
		byFile[file.FileID] = file
	}
	if bundle := inventory.ArchiveBundle; bundle != nil && len(byFile) > 0 && (bundle.Phase == "committed" || bundle.Phase == "verified") {
		if inventory.Archive == nil || inventory.Archive.SchemaVersion != 3 || inventory.Archive.Path != bundle.ManifestPath || inventory.Archive.SHA256 != bundle.ManifestHash || decimal(inventory.Archive.ByteLength) != bundle.ManifestLength {
			return errors.New("committed archive manifest mismatch")
		}
	}
	if bundle := inventory.ArchiveBundle; bundle != nil && len(byFile) > 0 && (bundle.Phase == "sealed" || bundle.Phase == "committed" || bundle.Phase == "verified") {
		if err := verifyBackupSealedBundle(ctx, files, inventory, namespace, *bundle); err != nil {
			return err
		}
	}
	for _, file := range inventory.ArchiveFilesV2 {
		if file.UploadVersion != 2 {
			return errors.New("unsupported archive upload version")
		}
		if _, err := namespace.BlockPath(file.FileID, 0); err != nil {
			return err
		}
		digest, err := hex.DecodeString(file.SHA256)
		if err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != file.SHA256 || file.ByteLength < 0 {
			return errors.New("invalid archive file identity")
		}
		expected := namespace.Directory() + "/files/" + file.FileID
		if file.Purpose == "resource" {
			expected, err = BlobAddress(inventory.ProjectID, inventory.OwnerID, inventory.SessionID, file.FileID)
			if err != nil {
				return err
			}
		} else if file.Purpose != "history" && file.Purpose != "timeline" {
			return errors.New("invalid archive file purpose")
		}
		limit := int64(sp.MaxArchiveTimelineBytes)
		if file.Purpose == "history" {
			limit = sp.MaxArchiveHistoryBytes
		} else if file.Purpose == "resource" {
			limit = sp.MaxArchiveBlobBytes
		}
		if file.ByteLength > limit || (file.ByteLength == 0 && (file.Purpose != "resource" || file.SHA256 != archiveDigest(nil))) || file.AcceptedOffset < 0 || file.AcceptedOffset > file.ByteLength || len(file.PrefixProof) != sha256.Size {
			return errors.New("invalid archive file bounds or proof")
		}
		if file.Path != expected {
			return errors.New("archive file namespace mismatch")
		}
		if file.Purpose == "resource" && file.State != "failed" {
			descriptor, err := sp.DecodeResource(file.Resource)
			if err != nil || descriptor.Status != "available" || descriptor.Revision != "" || descriptor.ByteLength == nil || *descriptor.ByteLength != decimal(file.ByteLength) || descriptor.SHA256 == nil || *descriptor.SHA256 != file.SHA256 {
				return errors.New("archive resource identity mismatch")
			}
		}
		if file.State == "failed" {
			var terminal struct {
				Code string `json:"code"`
			}
			if json.Unmarshal(file.TerminalError, &terminal) != nil || terminal.Code == "" {
				return errors.New("invalid archive terminal error")
			}
			if file.SuccessorFileID != "" {
				next, ok := byFile[file.SuccessorFileID]
				if !ok || file.SuccessorFileID == file.FileID || terminal.Code != "staging_corrupt" || next.UploadVersion != 2 || next.Purpose != file.Purpose || next.ByteLength != file.ByteLength || next.SHA256 != file.SHA256 || next.TimelineRevision != file.TimelineRevision || !jsonEqual(next.Resource, file.Resource) {
					return errors.New("archive successor identity mismatch")
				}
				seen := map[string]bool{file.FileID: true}
				for next.FileID != "" {
					if seen[next.FileID] {
						return errors.New("archive successor cycle")
					}
					seen[next.FileID] = true
					if next.SuccessorFileID == "" {
						break
					}
					var exists bool
					next, exists = byFile[next.SuccessorFileID]
					if !exists {
						return errors.New("archive successor missing")
					}
				}
			}
			continue
		}
		bundle := inventory.ArchiveBundle
		if bundle == nil {
			return errors.New("archive upload has no bundle")
		}
		current := file.Purpose == "resource" || file.Purpose == "history" && bundle.HistoryID == file.FileID || file.Purpose == "timeline" && bundle.TimelineID == file.FileID
		if !current && file.State == "complete" {
			if file.AcceptedOffset != file.ByteLength || file.SuccessorFileID != "" {
				return errors.New("invalid retired archive receipt")
			}
			continue
		}
		if !current || file.SuccessorFileID != "" {
			return errors.New("archive upload is not current")
		}
		if file.State == "receiving" {
			if file.StagingReleased || file.TimelineRevision < 1 || file.TimelineRevision > bundle.Revision || (file.Purpose != "resource" && file.TimelineRevision != bundle.Revision) || (file.Purpose == "timeline" && bundle.Phase != "sealed") || (file.Purpose == "history" && bundle.Phase != "settling") || (file.Purpose == "resource" && bundle.Phase != "settling" && bundle.Phase != "sealed" && bundle.Phase != "failed" && bundle.Phase != "committed" && bundle.Phase != "verified") {
				return errors.New("invalid receiving archive phase")
			}
			if err := verifyArchiveV2Prefix(ctx, files, namespace, file); err != nil {
				return fmt.Errorf("archive file %s: %w", file.FileID, err)
			}
			continue
		}
		if file.State != "complete" || file.AcceptedOffset != file.ByteLength {
			return errors.New("invalid archive terminal state")
		}
		switch file.Purpose {
		case "history":
			if bundle.Phase == "settling" || bundle.Phase == "failed" {
				if file.TimelineRevision < 1 || file.TimelineRevision > bundle.Revision || validateBackupLedger(bundle.Ledger, file.FileID) != nil {
					return errors.New("completed history ledger mismatch")
				}
			} else if bundle.Phase != "sealed" && bundle.Phase != "committed" && bundle.Phase != "verified" {
				return errors.New("completed history phase mismatch")
			}
		case "timeline":
			if file.TimelineRevision != bundle.Revision || (bundle.Phase != "sealed" && bundle.Phase != "committed" && bundle.Phase != "verified") {
				return errors.New("completed timeline phase mismatch")
			}
			if bundle.Phase == "committed" || bundle.Phase == "verified" {
				if inventory.Archive == nil || inventory.Archive.SchemaVersion != 3 || inventory.Archive.Path != bundle.ManifestPath || inventory.Archive.SHA256 != bundle.ManifestHash || decimal(inventory.Archive.ByteLength) != bundle.ManifestLength {
					return errors.New("committed archive manifest mismatch")
				}
			}

		case "resource":
			descriptor, err := sp.DecodeResource(file.Resource)
			if err != nil {
				return err
			}
			if descriptor.Status != "available" || descriptor.ByteLength == nil || *descriptor.ByteLength != decimal(file.ByteLength) || descriptor.SHA256 == nil || *descriptor.SHA256 != file.SHA256 {
				return errors.New("completed archive resource identity mismatch")
			}
			matched := false
			for _, resource := range inventory.Resources {
				if resource.Resource.ResourceID == descriptor.ResourceID && resource.BlobID == file.FileID && resource.BlobPath == file.Path && jsonEqual(encode(resource.Resource), encode(descriptor)) {
					matched = true
					break
				}
			}
			if !matched {
				return errors.New("completed archive resource mismatch")
			}
		}
	}
	return nil
}

// validateBackupLedger checks the durable structure required for a later seal.
// History bytes may already have been reclaimed, so their digest cannot be
// reconstructed from this compact ledger.
func validateBackupLedger(raw json.RawMessage, historyID string) error {
	var ledger archiveLedger
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return errors.New("invalid completed history ledger")
	}
	for _, key := range []string{"HistoryID", "HistoryEpoch", "SourceThrough", "Sealable", "Entries", "Resources", "Occurrences"} {
		if len(fields[key]) == 0 || bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
			return errors.New("incomplete completed history ledger")
		}
	}
	if json.Unmarshal(raw, &ledger) != nil || ledger.HistoryID != historyID || ledger.HistoryEpoch == "" || len(ledger.HistoryEpoch) > 256 || ledger.Entries == nil || ledger.Resources == nil || ledger.Occurrences == nil || len(ledger.Entries) > 100000 || len(ledger.Resources) > 1000 || len(ledger.Occurrences) > maxArchiveHistoryOccurrences {
		return errors.New("invalid completed history ledger")
	}
	validNumber := func(value string, zero bool) bool {
		n, err := strconv.ParseInt(value, 10, 64)
		return err == nil && decimal(n) == value && (n > 0 || zero && n == 0)
	}
	validDigest := func(value string) bool {
		b, err := hex.DecodeString(value)
		return err == nil && len(b) == sha256.Size && hex.EncodeToString(b) == value
	}
	validID := func(value string) bool {
		id, err := uuid.Parse(value)
		return err == nil && id.String() == value
	}
	if !validNumber(ledger.SourceThrough, true) || (ledger.ContentPolicy != "" && ledger.ContentPolicy != "task_body") {
		return errors.New("invalid history ledger source")
	}
	seen := map[string]bool{}
	var last int64
	for _, entry := range ledger.Entries {
		seq, _ := strconv.ParseInt(entry.Sequence, 10, 64)
		if !validID(entry.ID) || seen[entry.ID] || !validNumber(entry.Sequence, false) || seq <= last || !validNumber(entry.Revision, false) || entry.ByteLength < 1 || !validDigest(entry.SHA256) || !validDigest(entry.SourceSHA256) {
			return errors.New("invalid history ledger entry")
		}
		seen[entry.ID] = true
		last = seq
	}
	resourceIDs := map[string]bool{}
	for _, resource := range ledger.Resources {
		if _, err := sp.DecodeResource(encode(resource)); err != nil || resourceIDs[resource.ResourceID] {
			return errors.New("invalid history ledger resource")
		}
		resourceIDs[resource.ResourceID] = true
	}
	for _, occurrence := range ledger.Occurrences {
		if !seen[occurrence.EntryID] || !validID(occurrence.ImageID) || !strings.Contains("|content|tool_output|reasoning|", "|"+occurrence.Container+"|") {
			return errors.New("invalid history ledger occurrence")
		}
	}
	return nil
}

// A sealed bundle owns its resource closure even before a timeline is complete.
// A complete current timeline is checked against that closure for both uploads.
func verifyBackupSealedBundle(ctx context.Context, files backupStorageReader, inventory store.StorageInventory, namespace sessionarchive.Namespace, bundle store.ArchiveBundle) error {
	var ledger archiveLedger
	if bundle.HistoryID == "" || validateBackupLedger(bundle.Ledger, bundle.HistoryID) != nil || json.Unmarshal(bundle.Ledger, &ledger) != nil || !ledger.Sealable {
		return errors.New("invalid sealed history ledger")
	}
	var refs []sp.ArchiveResourceReference
	if json.Unmarshal(bundle.Resources, &refs) != nil || refs == nil || len(refs) != len(ledger.Resources) {
		return errors.New("invalid sealed resource list")
	}
	seen := map[string]bool{}
	byID := make(map[string]store.SessionResourceRecord, len(inventory.Resources))
	for _, resource := range inventory.Resources {
		byID[resource.Resource.ResourceID] = resource
	}
	missing := false
	for i, ref := range refs {
		id := ref.Resource.ResourceID
		if ref.Resource.Status == "pending" || seen[id] || !jsonEqual(encode(ref.Resource), encode(ledger.Resources[i])) {
			return errors.New("sealed resource ledger mismatch")
		}
		seen[id] = true
		if _, err := sp.DecodeResource(encode(ref.Resource)); err != nil {
			return err
		}
		saved, ok := byID[id]
		if !ok || !jsonEqual(encode(saved.Resource), encode(ref.Resource)) {
			return errors.New("sealed resource missing from inventory")
		}
		if ref.Resource.Status == "available" {
			if ref.BlobID == nil || *ref.BlobID != saved.BlobID {
				return errors.New("sealed resource blob mismatch")
			}
		} else {
			if ref.BlobID != nil || saved.BlobID != "" {
				return errors.New("invalid sealed resource blob")
			}
			missing = true
		}
	}
	file := inventory.ArchiveTimeline
	if bundle.TimelineID == "" {
		if file != nil || bundle.Phase != "sealed" {
			return errors.New("sealed timeline identity mismatch")
		}
		return nil
	}
	if file == nil || file.FileID != bundle.TimelineID || file.Path != namespace.Directory()+"/files/"+file.FileID || file.TimelineRevision != bundle.Revision || (file.UploadVersion != 1 && file.UploadVersion != 2) {
		return errors.New("sealed timeline identity mismatch")
	}
	if file.State != "complete" {
		if bundle.Phase != "sealed" || file.State != "receiving" {
			return errors.New("invalid sealed timeline state")
		}
		return nil
	}
	if file.AcceptedOffset != file.ByteLength {
		return errors.New("incomplete sealed timeline receipt")
	}
	data, err := readStorageObject(ctx, files, store.StorageObject{Bucket: archiveBucket, Path: file.Path + "/content", ByteLength: file.ByteLength, SHA256: file.SHA256})
	if err != nil {
		return err
	}
	timeline, err := sp.DecodeArchiveTimeline(data)
	if err != nil {
		return err
	}
	if err = verifyArchiveLedger(ledger, timeline); err != nil {
		return err
	}
	_, missingTimeline, err := sp.ArchiveReferences(timeline.Entries)
	if err != nil {
		return err
	}
	missing = missing || missingTimeline
	completeness := "complete"
	if missing {
		completeness = "partial"
	}
	manifest := sp.ArchiveManifest{ContentPolicy: ledger.ContentPolicy, Timeline: sp.ArchiveFileReference{FileID: file.FileID, SHA256: file.SHA256, ByteLength: decimal(file.ByteLength)}, Resources: refs, Completeness: completeness}
	_, err = sp.VerifyArchiveClosure(manifest, data, func(ref sp.ArchiveResourceReference) ([]byte, error) {
		saved := byID[ref.Resource.ResourceID]
		return readStorageObject(ctx, files, store.StorageObject{Bucket: "session-resources", Path: saved.BlobPath, ByteLength: number(*ref.Resource.ByteLength), SHA256: *ref.Resource.SHA256})
	})
	return err
}
