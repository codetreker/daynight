package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type attachmentStore interface {
	store.SnapshotReader
	store.AttachmentWriter
}

type Attachments struct {
	store attachmentStore
	files filestorage.Storage
}

func NewAttachments(database attachmentStore, files filestorage.Storage) *Attachments {
	return &Attachments{store: database, files: files}
}

func (s *Attachments) read(ctx context.Context, principal model.Principal, projectID, taskID string, operation func(store.AttachmentReader) error) error {
	var missing *model.Fault
	err := s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if _, err := projectcore.RequireProjectRead(ctx, snapshot.ProjectDAO(), principal, projectID); err != nil {
			if errors.As(err, &missing) {
				return nil
			}
			return err
		}
		if _, err := snapshot.TaskDAO().Task(ctx, projectID, taskID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				missing = taskcore.NotFound(err)
				return nil
			}
			return err
		}
		err := operation(snapshot.AttachmentDAO())
		if errors.As(err, &missing) {
			return nil
		}
		if errors.Is(err, model.ErrNotFound) {
			missing = attachmentcore.NotFound(err)
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

func (s *Attachments) Put(ctx context.Context, principal model.Principal, projectID, taskID, path, contentType string, content io.Reader) (model.Attachment, bool, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Attachment{}, false, err
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, path)
	if err != nil {
		return model.Attachment{}, false, err
	}
	if err := attachmentcore.ValidateContentType(contentType); err != nil {
		return model.Attachment{}, false, err
	}
	err = s.read(ctx, principal, address.ProjectID, address.TaskID, func(reader store.AttachmentReader) error {
		return attachmentcore.CheckPathConflict(ctx, reader, address)
	})
	if err != nil {
		return model.Attachment{}, false, err
	}
	info, err := s.files.Put(ctx, attachmentcore.Bucket, address.StoragePath, content)
	if err != nil {
		if errors.Is(err, filestorage.ErrPathConflict) {
			return model.Attachment{}, false, attachmentcore.StorageConflict(err)
		}
		return model.Attachment{}, false, fmt.Errorf("write attachment content: %w", err)
	}
	attachment, created, err := attachmentcore.PutMetadata(ctx, s.store, address, contentType, info.Size)
	if err != nil {
		return model.Attachment{}, false, fmt.Errorf("write attachment metadata: %w", err)
	}
	return attachment, created, nil
}

func (s *Attachments) Open(ctx context.Context, principal model.Principal, projectID, taskID, path string) (model.Attachment, filestorage.Object, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, path)
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	var attachment model.Attachment
	err = s.read(ctx, principal, address.ProjectID, address.TaskID, func(reader store.AttachmentReader) error {
		var err error
		attachment, err = attachmentcore.Metadata(ctx, reader, address)
		return err
	})
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	object, err := s.files.Open(ctx, attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, fmt.Errorf("open attachment content: %w", err)
	}
	return attachment, object, nil
}

func (s *Attachments) Delete(ctx context.Context, principal model.Principal, projectID, taskID, path string) error {
	if err := model.RequirePrincipal(principal); err != nil {
		return err
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, path)
	if err != nil {
		return err
	}
	err = s.read(ctx, principal, address.ProjectID, address.TaskID, func(reader store.AttachmentReader) error {
		_, err := attachmentcore.Metadata(ctx, reader, address)
		return err
	})
	if err != nil {
		return err
	}
	if err := s.files.Delete(ctx, attachmentcore.Bucket, address.StoragePath); err != nil {
		return fmt.Errorf("delete attachment content: %w", err)
	}
	if err := attachmentcore.DeleteMetadata(ctx, s.store, address); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return err
		}
		return fmt.Errorf("delete attachment metadata: %w", err)
	}
	return nil
}

func (s *Attachments) List(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return attachmentcore.Page{}, err
	}
	projectID, err := model.CanonicalID(projectID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	taskID, err = model.CanonicalID(taskID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	query, err := attachmentcore.ListQuery(request, projectID, taskID)
	if err != nil {
		return attachmentcore.Page{}, err
	}
	var result store.AttachmentPage
	err = s.read(ctx, principal, projectID, taskID, func(reader store.AttachmentReader) error {
		var err error
		result, err = reader.Attachments(ctx, projectID, taskID, query)
		return err
	})
	if err != nil {
		return attachmentcore.Page{}, err
	}
	return attachmentcore.MakePage(result, projectID, taskID)
}
