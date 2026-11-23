package store

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// OfflineStorageState identifies the temporary work revoked only after target
// cleanup and verification. The untouched source backup remains the restore cut.
type OfflineStorageState struct {
	ArchiveFiles []OfflineArchiveFile
	Uploads      []OfflineImageUpload
	Transfers    []model.PrivateTransfer
}

type OfflineArchiveFile struct {
	ProjectID, OwnerID string
	File               ArchiveBundleFile
	Bundle             *ArchiveBundle
	Chunks             []StorageObject
	Predecessors       []ArchiveBundleFile
}

type OfflineArchiveRevocation struct {
	SessionID, PredecessorFileID, SuccessorFileID string
	TerminalError                                 json.RawMessage
}

type OfflineImageUpload struct {
	ProjectID, OwnerID string
	Upload             SessionUploadRecord
	Chunks             []StorageObject
}
