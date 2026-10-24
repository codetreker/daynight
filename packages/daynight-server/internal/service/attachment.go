package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
)

const attachmentBucket = "task-attachments"

type Attachments struct {
	store *store.Store
	files filestorage.Storage
}

type AttachmentPage struct {
	Items      []core.Attachment
	NextCursor *string
}

func NewAttachments(database *store.Store, files filestorage.Storage) *Attachments {
	return &Attachments{store: database, files: files}
}

func (s *Attachments) read(ctx context.Context, principal core.Principal, projectID, taskID string, operation func(*store.Snapshot) error) error {
	var missing *Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := RequireProjectRead(ctx, snapshot, principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		if _, err := snapshot.Task(ctx, projectID, taskID); err != nil {
			if errors.Is(err, core.ErrNotFound) {
				missing = taskNotFound(err)
				return nil
			}
			return err
		}
		err := operation(snapshot)
		if errors.As(err, &missing) {
			return nil
		}
		if errors.Is(err, core.ErrNotFound) {
			missing = attachmentNotFound(err)
			return nil
		}
		return err
	})
	if err != nil {
		return fmt.Errorf("read attachments: %w", err)
	}
	if missing != nil {
		return missing
	}
	return nil
}

func (s *Attachments) Put(ctx context.Context, principal core.Principal, projectID, taskID, path, contentType string, content io.Reader) (core.Attachment, bool, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Attachment{}, false, err
	}
	address, err := newAttachmentAddress(projectID, taskID, path)
	if err != nil {
		return core.Attachment{}, false, err
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || !strings.Contains(mediaType, "/") {
		return core.Attachment{}, false, invalidInput("Attachment content type is invalid.")
	}
	err = s.read(ctx, principal, address.projectID, address.taskID, func(snapshot *store.Snapshot) error {
		conflict, err := snapshot.AttachmentPathConflict(ctx, address.projectID, address.taskID, address.relativePath)
		if err != nil {
			return err
		}
		if conflict {
			return &Fault{Code: "path_conflict", Message: "Attachment path conflicts with a file or directory."}
		}
		return nil
	})
	if err != nil {
		return core.Attachment{}, false, err
	}
	info, err := s.files.Put(ctx, attachmentBucket, address.storagePath, content)
	if err != nil {
		if errors.Is(err, filestorage.ErrPathConflict) {
			return core.Attachment{}, false, &Fault{Code: "path_conflict", Message: "Attachment path conflicts with an existing filesystem name.", Cause: err}
		}
		return core.Attachment{}, false, fmt.Errorf("write attachment content: %w", err)
	}
	attachment, created, err := s.store.PutAttachment(ctx, core.Attachment{ProjectID: address.projectID, TaskID: address.taskID,
		Path: address.relativePath, ContentType: contentType, SizeBytes: info.Size})
	if err != nil {
		return core.Attachment{}, false, fmt.Errorf("write attachment metadata: %w", err)
	}
	return attachment, created, nil
}

func (s *Attachments) Open(ctx context.Context, principal core.Principal, projectID, taskID, path string) (core.Attachment, filestorage.Object, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Attachment{}, filestorage.Object{}, err
	}
	address, err := newAttachmentAddress(projectID, taskID, path)
	if err != nil {
		return core.Attachment{}, filestorage.Object{}, err
	}
	var attachment core.Attachment
	err = s.read(ctx, principal, address.projectID, address.taskID, func(snapshot *store.Snapshot) error {
		var err error
		attachment, err = snapshot.Attachment(ctx, address.projectID, address.taskID, address.relativePath)
		return err
	})
	if err != nil {
		return core.Attachment{}, filestorage.Object{}, err
	}
	object, err := s.files.Open(ctx, attachmentBucket, address.storagePath)
	if err != nil {
		return core.Attachment{}, filestorage.Object{}, fmt.Errorf("open attachment content: %w", err)
	}
	return attachment, object, nil
}

func (s *Attachments) Delete(ctx context.Context, principal core.Principal, projectID, taskID, path string) error {
	if err := requirePrincipal(principal); err != nil {
		return err
	}
	address, err := newAttachmentAddress(projectID, taskID, path)
	if err != nil {
		return err
	}
	err = s.read(ctx, principal, address.projectID, address.taskID, func(snapshot *store.Snapshot) error {
		_, err := snapshot.Attachment(ctx, address.projectID, address.taskID, address.relativePath)
		return err
	})
	if err != nil {
		return err
	}
	if err := s.files.Delete(ctx, attachmentBucket, address.storagePath); err != nil {
		return fmt.Errorf("delete attachment content: %w", err)
	}
	if err := s.store.DeleteAttachment(ctx, address.projectID, address.taskID, address.relativePath); err != nil {
		if errors.Is(err, core.ErrNotFound) {
			return attachmentNotFound(err)
		}
		return fmt.Errorf("delete attachment metadata: %w", err)
	}
	return nil
}

func attachmentNotFound(cause error) *Fault {
	return &Fault{Code: "not_found", Message: "Attachment was not found.", Cause: cause}
}
