package session

import (
	"bytes"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

const offlineSuccessorRevocationKey = "offlineSuccessorRevocation"

type offlineSuccessorRevocation struct {
	Version           int             `json:"version"`
	SessionID         string          `json:"sessionId"`
	PredecessorFileID string          `json:"predecessorFileId"`
	SuccessorFileID   string          `json:"successorFileId"`
	Purpose           string          `json:"purpose"`
	SHA256            string          `json:"sha256"`
	ByteLength        int64           `json:"byteLength"`
	TimelineRevision  int64           `json:"timelineRevision"`
	Resource          json.RawMessage `json:"resource"`
}

func PlanOfflineArchiveRevocations(state store.OfflineStorageState) ([]store.OfflineArchiveRevocation, error) {
	var out []store.OfflineArchiveRevocation
	for _, item := range state.ArchiveFiles {
		for _, predecessor := range item.Predecessors {
			next := item.File
			if predecessor.SessionID != next.SessionID || predecessor.FileID == next.FileID || predecessor.State != "failed" || predecessor.UploadVersion != 2 || next.UploadVersion != 2 || next.State != "receiving" || predecessor.SuccessorFileID != next.FileID || predecessor.Purpose != next.Purpose || predecessor.SHA256 != next.SHA256 || predecessor.ByteLength != next.ByteLength || predecessor.TimelineRevision != next.TimelineRevision || !jsonEqual(predecessor.Resource, next.Resource) {
				return nil, errors.New("offline archive predecessor identity mismatch")
			}
			var fields map[string]json.RawMessage
			var code string
			if json.Unmarshal(predecessor.TerminalError, &fields) != nil || json.Unmarshal(fields["code"], &code) != nil || code != "staging_corrupt" {
				return nil, errors.New("offline archive predecessor is not staging corruption")
			}
			if err := verifyArchiveSuccessors(next.SessionID, archiveRevocationFile(predecessor), map[string]store.StorageArchiveFileV2{next.FileID: archiveRevocationFile(next)}); err != nil {
				return nil, err
			}
			proof := offlineSuccessorRevocation{Version: 1, SessionID: next.SessionID, PredecessorFileID: predecessor.FileID, SuccessorFileID: next.FileID, Purpose: next.Purpose, SHA256: next.SHA256, ByteLength: next.ByteLength, TimelineRevision: next.TimelineRevision, Resource: next.Resource}
			fields[offlineSuccessorRevocationKey] = encode(proof)
			out = append(out, store.OfflineArchiveRevocation{SessionID: next.SessionID, PredecessorFileID: predecessor.FileID, SuccessorFileID: next.FileID, TerminalError: encode(fields)})
		}
	}
	return out, nil
}

func archiveRevocationFile(file store.ArchiveBundleFile) store.StorageArchiveFileV2 {
	return store.StorageArchiveFileV2{UploadVersion: file.UploadVersion, FileID: file.FileID, Purpose: file.Purpose, SHA256: file.SHA256, State: file.State, Path: file.Path, SuccessorFileID: file.SuccessorFileID, ByteLength: file.ByteLength, AcceptedOffset: file.AcceptedOffset, TimelineRevision: file.TimelineRevision, Resource: file.Resource, TerminalError: file.TerminalError, StagingReleased: file.StagingReleased}
}

func restoreOfflineSuccessorRegistration(rows []store.ArchiveStagingRecord, next store.ArchiveStagingRecord) (store.ArchiveStagingRecord, error) {
	var originalRevision int64
	for _, previous := range rows {
		if previous.SuccessorFileID != next.FileID {
			continue
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(previous.TerminalError, &fields) != nil {
			return next, archiveConflict()
		}
		if _, present := fields[offlineSuccessorRevocationKey]; !present {
			continue
		}
		if next.Purpose == "resource" {
			// Resources can outlive a completed history replacement. Their original
			// revision remains part of the immutable successor receipt.
			if previous.TimelineRevision < 1 || previous.TimelineRevision > next.TimelineRevision || originalRevision != 0 && originalRevision != previous.TimelineRevision {
				return next, archiveConflict()
			}
			originalRevision = previous.TimelineRevision
			next.TimelineRevision = originalRevision
		}
		if err := verifyArchiveSuccessors(next.SessionID, archiveRevocationFile(stagingBundleFile(previous)), map[string]store.StorageArchiveFileV2{next.FileID: archiveRevocationFile(stagingBundleFile(next))}); err != nil {
			return next, errors.Join(archiveConflict(), err)
		}
	}
	return next, nil
}

// The internal proof retains the public failed receipt's successor while
// recording why its registration is absent after an offline backend cut.
func verifyArchiveSuccessors(sessionID string, file store.StorageArchiveFileV2, files map[string]store.StorageArchiveFileV2) error {
	seen := map[string]bool{}
	for {
		if file.State != "failed" || file.UploadVersion != 2 {
			return errors.New("archive successor predecessor is not a failed v2 file")
		}
		if seen[file.FileID] {
			return errors.New("archive successor cycle")
		}
		seen[file.FileID] = true
		var fields map[string]json.RawMessage
		var code string
		if json.Unmarshal(file.TerminalError, &fields) != nil || json.Unmarshal(fields["code"], &code) != nil || code == "" {
			return errors.New("invalid archive terminal error")
		}
		var proof *offlineSuccessorRevocation
		if raw, present := fields[offlineSuccessorRevocationKey]; present {
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&proof) != nil || proof == nil || proof.Version != 1 || proof.SessionID != sessionID || proof.PredecessorFileID != file.FileID || proof.SuccessorFileID != file.SuccessorFileID || proof.Purpose != file.Purpose || proof.SHA256 != file.SHA256 || proof.ByteLength != file.ByteLength || proof.TimelineRevision != file.TimelineRevision || !jsonEqual(proof.Resource, file.Resource) || file.SuccessorFileID == "" || code != "staging_corrupt" {
				return errors.New("invalid offline archive successor revocation proof")
			}
		}
		if file.SuccessorFileID == "" {
			return nil
		}
		successorID, err := uuid.Parse(file.SuccessorFileID)
		if err != nil || successorID == uuid.Nil || successorID.String() != file.SuccessorFileID || code != "staging_corrupt" || file.SuccessorFileID == file.FileID {
			return errors.New("archive successor identity mismatch")
		}
		next, present := files[file.SuccessorFileID]
		if !present {
			if proof != nil {
				return nil
			}
			return errors.New("archive successor missing")
		}
		if next.UploadVersion != 2 || next.Purpose != file.Purpose || next.ByteLength != file.ByteLength || next.SHA256 != file.SHA256 || next.TimelineRevision != file.TimelineRevision || !jsonEqual(next.Resource, file.Resource) {
			return errors.New("archive successor identity mismatch")
		}
		if next.State != "failed" {
			if next.SuccessorFileID != "" {
				return errors.New("nonfailed archive file has a successor")
			}
			return nil
		}
		file = next
	}
}
