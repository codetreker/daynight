package service

import "github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"

type attachmentAddress struct {
	projectID    string
	taskID       string
	relativePath string
	storagePath  string
}

func newAttachmentAddress(projectID, taskID, relativePath string) (attachmentAddress, error) {
	projectID, err := CanonicalID(projectID)
	if err != nil {
		return attachmentAddress{}, err
	}
	taskID, err = CanonicalID(taskID)
	if err != nil {
		return attachmentAddress{}, err
	}
	if err := filestorage.ValidateAddress(attachmentBucket, relativePath); err != nil {
		return attachmentAddress{}, &Fault{Code: "invalid_input", Message: "Attachment path is invalid.", Cause: err}
	}
	return attachmentAddress{
		projectID:    projectID,
		taskID:       taskID,
		relativePath: relativePath,
		storagePath:  attachmentTaskStoragePath(projectID, taskID) + "/" + relativePath,
	}, nil
}

// Canonical UUIDs are required before deriving a task's physical directory.
func attachmentTaskStoragePath(projectID, taskID string) string {
	return projectID + "/" + taskID[:2] + "/" + taskID
}
