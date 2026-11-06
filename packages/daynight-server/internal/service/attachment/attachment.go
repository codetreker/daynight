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

type Attachments struct {
	store     store.SnapshotReader
	mutations store.AttachmentMutationWriter
	files     filestorage.Storage
}

// fileEffectError records that a file mutation was entered. The underlying
// transaction result remains available, but cannot undo that external effect.
type fileEffectError struct{ cause error }

func (e *fileEffectError) Error() string { return e.cause.Error() }
func (e *fileEffectError) Unwrap() error { return e.cause }

// FileEffectPossible reports whether an unsuccessful operation entered file
// mutation; an error after this point cannot prove the file was unchanged.
func FileEffectPossible(err error) bool {
	var effect *fileEffectError
	return errors.As(err, &effect)
}

func NewAttachments(database store.SnapshotReader, mutations store.AttachmentMutationWriter, files filestorage.Storage) *Attachments {
	return &Attachments{store: database, mutations: mutations, files: files}
}

func (s *Attachments) mutate(ctx context.Context, principal model.Principal, address attachmentcore.Address, operation func(store.AttachmentMutationDAO) error) error {
	completion, err := s.mutations.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		presence, err := scope.LockTaskPresence(ctx, address.ProjectID, address.TaskID)
		if err != nil {
			return err
		}
		if _, err := scope.ProjectAuthorization(ctx, principal, address.ProjectID); err != nil {
			return projectcore.LookupError(err)
		}
		if !presence.Found {
			return taskcore.NotFound(model.ErrNotFound)
		}
		if presence.DeletedAt != nil {
			return taskcore.NotFound(model.ErrTaskDeleted)
		}
		return operation(scope.AttachmentDAO())
	})
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return &store.TransactionError{Phase: "completion", Outcome: completion.Outcome, Cause: errors.New("attachment mutation did not commit")}
	}
	return nil
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
	if err := attachmentcore.ValidateWritePath(address.RelativePath); err != nil {
		return model.Attachment{}, false, err
	}
	if err := attachmentcore.ValidateContentType(contentType); err != nil {
		return model.Attachment{}, false, err
	}
	permit, err := s.files.AcquireGate(ctx, filestorage.TargetGate, address.StoragePath)
	if err != nil {
		return model.Attachment{}, false, fmt.Errorf("acquire attachment gate: %w", err)
	}
	defer permit.Close()
	var attachment model.Attachment
	var created bool
	err = s.mutate(ctx, principal, address, func(dao store.AttachmentMutationDAO) error {
		if err := attachmentcore.CheckPathConflict(ctx, dao, address); err != nil {
			return err
		}
		info, err := s.files.Put(ctx, attachmentcore.Bucket, address.StoragePath, content)
		if err != nil {
			if errors.Is(err, filestorage.ErrPathConflict) {
				return attachmentcore.StorageConflict(err)
			}
			return fmt.Errorf("write attachment content: %w", err)
		}
		attachment, created, err = attachmentcore.PutMetadata(ctx, dao, address, contentType, info.Size)
		if err != nil {
			return fmt.Errorf("write attachment metadata: %w", err)
		}
		return nil
	})
	if err != nil {
		return model.Attachment{}, false, err
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
	permit, err := s.files.AcquireGate(ctx, filestorage.TargetGate, address.StoragePath)
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, fmt.Errorf("acquire attachment gate: %w", err)
	}
	defer permit.Close()
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
	permit, err := s.files.AcquireGate(ctx, filestorage.TargetGate, address.StoragePath)
	if err != nil {
		return fmt.Errorf("acquire attachment gate: %w", err)
	}
	defer permit.Close()
	fileStarted := false
	err = s.mutate(ctx, principal, address, func(dao store.AttachmentMutationDAO) error {
		if _, err := attachmentcore.Metadata(ctx, dao, address); err != nil {
			return err
		}
		fileStarted = true
		if err := s.files.Delete(ctx, attachmentcore.Bucket, address.StoragePath); err != nil {
			return fmt.Errorf("delete attachment content: %w", err)
		}
		if err := attachmentcore.DeleteMetadata(ctx, dao, address); err != nil {
			return fmt.Errorf("delete attachment metadata: %w", err)
		}
		return nil
	})
	if err != nil && fileStarted {
		return &fileEffectError{cause: err}
	}
	return err
}

func (s *Attachments) List(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	return s.list(ctx, principal, projectID, taskID, request, 0)
}

// ListBounded omits oversized path or content type fields and marks those rows.
// It avoids materializing unbounded metadata before an adapter's output limit.
func (s *Attachments) ListBounded(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest, maxFieldBytes int) (attachmentcore.Page, error) {
	if maxFieldBytes < 1 {
		return attachmentcore.Page{}, &model.Fault{Code: "invalid_input", Message: "Field limit must be positive."}
	}
	return s.list(ctx, principal, projectID, taskID, request, maxFieldBytes)
}

func (s *Attachments) list(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest, maxFieldBytes int) (attachmentcore.Page, error) {
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
	query.MaxFieldBytes = maxFieldBytes
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
