package session

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func ReleaseOfflineImageUpload(upload store.SessionUploadRecord) (store.SessionUploadRecord, error) {
	if upload.Receipt.State != "receiving" && upload.Receipt.State != "verifying" {
		return upload, errors.New("offline image upload is not unfinished")
	}
	upload.Receipt.State = "released"
	upload.Receipt.Resource, upload.Receipt.Error = nil, nil
	upload.StorageReleased = true
	return upload, nil
}

// Projection preserves the last completed ledger and revision independently of
// a revoked replacement's current pointer. Terminal receipts remain observable.
func ProjectOfflineStorageInventory(inventory store.StorageInventory, state store.OfflineStorageState) (store.StorageInventory, error) {
	revocations, err := PlanOfflineArchiveRevocations(state)
	if err != nil {
		return inventory, err
	}
	proofs := map[string][]byte{}
	for _, revocation := range revocations {
		if revocation.SessionID == inventory.SessionID {
			proofs[revocation.PredecessorFileID] = revocation.TerminalError
		}
	}
	removed := map[string]bool{}
	objects := map[string]bool{}
	for _, item := range state.ArchiveFiles {
		if item.File.SessionID != inventory.SessionID {
			continue
		}
		if item.File.State != "receiving" {
			return inventory, errors.New("offline archive revocation is not unfinished")
		}
		removed[item.File.FileID] = true
		for _, chunk := range item.Chunks {
			objects[chunk.Bucket+"\x00"+chunk.Path] = true
		}
	}
	for _, item := range state.Uploads {
		if item.Upload.SessionID == inventory.SessionID {
			for _, chunk := range item.Chunks {
				objects[chunk.Bucket+"\x00"+chunk.Path] = true
			}
		}
	}
	files := make([]store.StorageArchiveFileV2, 0, len(inventory.ArchiveFilesV2))
	for _, file := range inventory.ArchiveFilesV2 {
		if !removed[file.FileID] {
			if proof, exists := proofs[file.FileID]; exists {
				file.TerminalError = proof
			}
			files = append(files, file)
		}
	}
	inventory.ArchiveFilesV2 = files
	retained := make([]store.StorageObject, 0, len(inventory.Objects))
	for _, object := range inventory.Objects {
		if !objects[object.Bucket+"\x00"+object.Path] {
			retained = append(retained, object)
		}
	}
	inventory.Objects = retained
	if inventory.ArchiveBundle != nil {
		bundle := *inventory.ArchiveBundle
		if removed[bundle.HistoryID] {
			bundle.HistoryID = ""
		}
		if removed[bundle.TimelineID] {
			bundle.TimelineID = ""
			inventory.ArchiveTimeline = nil
		}
		inventory.ArchiveBundle = &bundle
	}
	return inventory, nil
}
