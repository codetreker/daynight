package session

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func ValidateOfflineStorageState(state store.OfflineStorageState) error {
	for _, item := range state.ArchiveFiles {
		file := item.File
		n, err := archiveNamespace(item.ProjectID, item.OwnerID, file.SessionID)
		if err != nil {
			return err
		}
		if _, err = filestorage.ArchiveStagingPath(n, file.FileID); err != nil {
			return err
		}
		if file.State != "receiving" || file.UploadVersion != 1 && file.UploadVersion != 2 || file.StagingReleased || file.SuccessorFileID != "" || file.ByteLength < 0 || file.AcceptedOffset < 0 || file.AcceptedOffset > file.ByteLength || !offlineDigestValid(file.SHA256) || file.TimelineRevision < 1 {
			return errors.New("invalid offline archive registration")
		}
		path := n.Directory() + "/files/" + file.FileID
		switch file.Purpose {
		case "history":
			if file.ByteLength < 1 || file.ByteLength > sp.MaxArchiveHistoryBytes {
				return errors.New("invalid offline history length")
			}
		case "timeline":
			if file.ByteLength < 1 || file.ByteLength > sp.MaxArchiveTimelineBytes {
				return errors.New("invalid offline timeline length")
			}
		case "resource":
			path, err = BlobAddress(item.ProjectID, item.OwnerID, file.SessionID, file.FileID)
			if err != nil {
				return err
			}
			resource, err := sp.DecodeResource(file.Resource)
			if err != nil || resource.Status != "available" || resource.ByteLength == nil || *resource.ByteLength != decimal(file.ByteLength) || resource.SHA256 == nil || *resource.SHA256 != file.SHA256 || file.ByteLength > sp.MaxArchiveBlobBytes {
				return errors.New("invalid offline archive resource identity")
			}
		default:
			return errors.New("invalid offline archive purpose")
		}
		if file.Path != path || item.Bundle == nil || file.TimelineRevision > item.Bundle.Revision {
			return errors.New("offline archive ownership mismatch")
		}
		bundle := item.Bundle
		historyPhase := bundle.Phase == "settling" || file.UploadVersion == 1 && bundle.Phase == "active"
		if bundle.SessionID != file.SessionID || file.Purpose == "history" && (bundle.HistoryID != file.FileID || !historyPhase || bundle.Revision != file.TimelineRevision) || file.Purpose == "timeline" && (bundle.TimelineID != file.FileID || bundle.Phase != "sealed" || bundle.Revision != file.TimelineRevision) {
			return errors.New("offline archive current registration mismatch")
		}
		for _, chunk := range item.Chunks {
			if err = validateOfflineChunk(chunk, sessionarchive.Bucket, n.Directory()+"/files/"+file.FileID+"/chunks/", file.ByteLength); err != nil {
				return err
			}
		}
	}
	for _, item := range state.Uploads {
		upload := item.Upload
		n, err := sessionresource.NewNamespace(item.ProjectID, item.OwnerID, upload.SessionID)
		if err != nil {
			return err
		}
		spec, err := sp.DecodeImageUploadSpec(encode(upload.Spec))
		if err != nil || spec.Target.ActorUserID != upload.ActorID || spec.Target.Fence.SessionID != upload.SessionID || upload.Receipt.UploadID != spec.UploadID || upload.Receipt.ImageID != spec.ImageID || !jsonEqual(encode(upload.Receipt.Target), encode(spec.Target)) || upload.Receipt.State != "receiving" && upload.Receipt.State != "verifying" {
			return errors.New("offline image identity mismatch")
		}
		offset, err := strconv.ParseInt(upload.Receipt.AcceptedOffset, 10, 64)
		if err != nil || decimal(offset) != upload.Receipt.AcceptedOffset || offset < 0 || offset > number(spec.ByteLength) || upload.Receipt.Spec != (sp.ImageUploadMetadata{Name: spec.Name, MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256}) {
			return errors.New("offline image receipt mismatch")
		}
		path, err := n.UploadPath(spec.UploadID)
		if err != nil {
			return err
		}
		if _, err = n.BlobPath(upload.BlobID); err != nil {
			return err
		}
		for _, chunk := range item.Chunks {
			if err = validateOfflineChunk(chunk, sessionresource.Bucket, path+"/", number(spec.ByteLength)); err != nil {
				return err
			}
		}
	}
	return nil
}

func offlineDigestValid(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && hex.EncodeToString(decoded) == value
}

func validateOfflineChunk(chunk store.StorageObject, bucket, prefix string, total int64) error {
	suffix, ok := strings.CutPrefix(chunk.Path, prefix)
	offset, err := strconv.ParseInt(suffix, 10, 64)
	if !ok || err != nil || decimal(offset) != suffix || offset < 0 || chunk.Bucket != bucket || chunk.ByteLength < 1 || chunk.ByteLength > total-offset || !offlineDigestValid(chunk.SHA256) {
		return errors.New("offline chunk ownership or identity mismatch")
	}
	return nil
}
