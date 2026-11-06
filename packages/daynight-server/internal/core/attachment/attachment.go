package attachment

import (
	"context"
	"errors"
	"mime"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const Bucket = "task-attachments"

// MaxPathCharacters counts Unicode code points, including path separators.
const MaxPathCharacters = 1024

// MaxContentTypeBytes limits the original MIME value on new writes.
const MaxContentTypeBytes = 2048

// ValidateWritePath rejects new writes beyond the path length limit. Existing
// metadata may still refer to longer paths, which remain readable and removable.
func ValidateWritePath(path string) error {
	if utf8.RuneCountInString(path) > MaxPathCharacters {
		return &model.Fault{Code: "invalid_input", Message: "Attachment path must not exceed 1024 characters."}
	}
	return nil
}

type Address struct {
	ProjectID    string
	TaskID       string
	RelativePath string
	StoragePath  string
}

func NewAddress(projectID, taskID, relativePath string) (Address, error) {
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return Address{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return Address{}, err
	}
	if err := filestorage.ValidateAddress(Bucket, relativePath); err != nil {
		return Address{}, &model.Fault{Code: "invalid_input", Message: "Attachment path is invalid.", Cause: err}
	}
	return Address{ProjectID: projectID, TaskID: taskID, RelativePath: relativePath,
		StoragePath: TaskStoragePath(projectID, taskID) + "/" + relativePath}, nil
}

// TaskStoragePath requires canonical UUIDs before deriving the physical directory.
func TaskStoragePath(projectID, taskID string) string {
	return projectID + "/" + taskID[:2] + "/" + taskID
}

func ValidateContentType(contentType string) error {
	if len(contentType) > MaxContentTypeBytes {
		return &model.Fault{Code: "invalid_input", Message: "Attachment content type must not exceed 2048 bytes."}
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.Contains(mediaType, "/") {
		return &model.Fault{Code: "invalid_input", Message: "Attachment content type is invalid."}
	}
	return nil
}

func CheckPathConflict(ctx context.Context, reader store.AttachmentReader, address Address) error {
	query := store.AttachmentConflictQuery{Ancestors: make([]string, 0), DescendantPrefix: address.RelativePath + "/"}
	for index, char := range address.RelativePath {
		if char == '/' {
			query.Ancestors = append(query.Ancestors, address.RelativePath[:index])
		}
	}
	conflict, err := reader.AttachmentPathConflict(ctx, address.ProjectID, address.TaskID, query)
	if err != nil {
		return err
	}
	if conflict {
		return &model.Fault{Code: "path_conflict", Message: "Attachment path conflicts with a file or directory."}
	}
	return nil
}

func NotFound(cause error) *model.Fault {
	return &model.Fault{Code: "not_found", Message: "Attachment was not found.", Cause: cause}
}

func StorageConflict(cause error) *model.Fault {
	return &model.Fault{Code: "path_conflict", Message: "Attachment path conflicts with an existing filesystem name.", Cause: cause}
}

func Metadata(ctx context.Context, reader store.AttachmentReader, address Address) (model.Attachment, error) {
	result, err := reader.Attachment(ctx, address.ProjectID, address.TaskID, address.RelativePath)
	if errors.Is(err, model.ErrNotFound) {
		return model.Attachment{}, NotFound(err)
	}
	return result, err
}

func MetadataBounded(ctx context.Context, reader store.AttachmentReader, address Address, maxBytes int) (model.Attachment, error) {
	if maxBytes < 1 {
		return model.Attachment{}, &model.Fault{Code: "invalid_input", Message: "Metadata limit must be positive."}
	}
	result, oversized, err := reader.AttachmentBounded(ctx, address.ProjectID, address.TaskID, address.RelativePath, maxBytes)
	if errors.Is(err, model.ErrNotFound) {
		return model.Attachment{}, NotFound(err)
	}
	if err != nil {
		return model.Attachment{}, err
	}
	if oversized {
		return model.Attachment{}, &model.Fault{Code: "resource_conflict", Message: "Attachment content type exceeds the supported metadata limit."}
	}
	return result, nil
}

func PutMetadata(ctx context.Context, writer store.AttachmentWriter, address Address, contentType string, size int64) (model.Attachment, bool, error) {
	return writer.PutAttachment(ctx, model.Attachment{ProjectID: address.ProjectID, TaskID: address.TaskID,
		Path: address.RelativePath, ContentType: contentType, SizeBytes: size})
}

func DeleteMetadata(ctx context.Context, writer store.AttachmentWriter, address Address) error {
	err := writer.DeleteAttachment(ctx, address.ProjectID, address.TaskID, address.RelativePath)
	if errors.Is(err, model.ErrNotFound) {
		return NotFound(err)
	}
	return err
}
