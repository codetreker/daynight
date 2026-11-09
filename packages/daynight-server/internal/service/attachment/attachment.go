package attachment

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type Attachments struct {
	store       store.SnapshotReader
	mutations   store.AttachmentMutationWriter
	files       filestorage.Storage
	uploadSlots chan struct{}
}

// FileEffectError records that a file mutation was entered. The underlying
// transaction result remains available, but cannot undo that external effect.
type FileEffectError struct{ Cause error }

func (e *FileEffectError) Error() string { return e.Cause.Error() }
func (e *FileEffectError) Unwrap() error { return e.Cause }

// FileEffectPossible reports whether an unsuccessful operation entered file
// mutation; an error after this point cannot prove the file was unchanged.
func FileEffectPossible(err error) bool {
	var effect *FileEffectError
	return errors.As(err, &effect)
}

func NewAttachments(database store.SnapshotReader, mutations store.AttachmentMutationWriter, files filestorage.Storage) *Attachments {
	maxConnections := 8
	if pool, ok := database.(interface{ MaxConnections() int }); ok {
		maxConnections = pool.MaxConnections()
	}
	capacity := maxConnections / 2
	if capacity < 1 {
		capacity = 1
	}
	if capacity > 4 {
		capacity = 4
	}
	return &Attachments{store: database, mutations: mutations, files: files, uploadSlots: make(chan struct{}, capacity)}
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
		presence, err := snapshot.TaskDAO().TaskPresence(ctx, projectID, taskID)
		if err != nil {
			if errors.Is(err, model.ErrNotFound) {
				missing = taskcore.NotFound(err)
				return nil
			}
			return err
		}
		if !presence.Found {
			missing = taskcore.NotFound(model.ErrNotFound)
			return nil
		}
		if presence.DeletedAt != nil {
			missing = taskcore.NotFound(model.ErrTaskDeleted)
			return nil
		}
		err = operation(snapshot.AttachmentDAO())
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

// Put releases its upload lease after the call unless a protocol retains it
// until delivery of the response.
func (s *Attachments) Put(ctx context.Context, principal model.Principal, projectID, taskID, path, contentType string, content io.Reader) (model.Attachment, bool, error) {
	item, created, lease, err := s.PutRetained(ctx, principal, projectID, taskID, path, contentType, content)
	if lease != nil && !RetainUploadLease(ctx, lease) {
		if closeErr := lease.Close(); closeErr != nil {
			if err == nil {
				err = &FileEffectError{Cause: &filestorage.PublicationError{Outcome: filestorage.Published, Cause: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: closeErr}}}
			} else {
				err = errors.Join(err, closeErr)
			}
		}
	}
	return item, created, err
}

func (s *Attachments) PutRetained(ctx context.Context, principal model.Principal, projectID, taskID, path, contentType string, content io.Reader) (result model.Attachment, isCreated bool, held io.Closer, resultErr error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.Attachment{}, false, nil, err
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, path)
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	if err := attachmentcore.ValidateWritePath(address.RelativePath); err != nil {
		return model.Attachment{}, false, nil, err
	}
	if err := attachmentcore.ValidateContentType(contentType); err != nil {
		return model.Attachment{}, false, nil, err
	}
	if err := s.read(ctx, principal, address.ProjectID, address.TaskID, func(store.AttachmentReader) error { return nil }); err != nil {
		// Recheck refusals under the normal Task lifecycle lock so a concurrent
		// Project deletion retains its established error ordering.
		var fault *model.Fault
		if errors.As(err, &fault) && (fault.Code == "task_deleted" || fault.Code == "not_found") {
			err = s.mutate(ctx, principal, address, func(store.AttachmentMutationDAO) error { return nil })
			if err == nil {
				return model.Attachment{}, false, nil, errors.New("attachment admission changed; retry the operation")
			}
		}
		return model.Attachment{}, false, nil, err
	}
	lease, err := s.AcquireUploadLease(ctx, principal, address.ProjectID, address.TaskID)
	if err != nil {
		return model.Attachment{}, false, nil, err
	}
	permit, err := s.files.AcquireGate(ctx, filestorage.TargetGate, address.StoragePath)
	if err != nil {
		return model.Attachment{}, false, lease, fmt.Errorf("acquire attachment gate: %w", err)
	}
	defer func() {
		if closeErr := permit.Close(); closeErr != nil {
			if resultErr == nil {
				resultErr = &FileEffectError{Cause: &filestorage.PublicationError{Outcome: filestorage.Published, Cause: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: closeErr}}}
			} else {
				resultErr = errors.Join(resultErr, closeErr)
			}
		}
	}()
	var attachment model.Attachment
	var created bool
	publication := filestorage.NotPublished
	completion, err := s.mutations.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		presence, err := scope.LockTaskPresence(ctx, address.ProjectID, address.TaskID)
		if err != nil {
			return err
		}
		if err := scope.ProjectLive(ctx, address.ProjectID); err != nil {
			return projectcore.LookupError(err)
		}
		if !presence.Found {
			return taskcore.NotFound(model.ErrNotFound)
		}
		if presence.DeletedAt != nil {
			return taskcore.NotFound(model.ErrTaskDeleted)
		}
		dao := scope.AttachmentDAO()
		if err := attachmentcore.CheckPathConflict(ctx, dao, address); err != nil {
			return err
		}
		info, err := s.files.Put(ctx, attachmentcore.Bucket, address.StoragePath, attachmentcore.BoundedContent(content))
		publication = filestorage.PublicationOutcome(err)
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
	if err == nil && completion.Outcome != store.TransactionCommitted {
		err = &store.TransactionError{Phase: "completion", Outcome: completion.Outcome, Cause: errors.New("attachment mutation did not commit")}
	}
	if err != nil {
		err = &filestorage.PublicationError{Outcome: publication, Cause: err}
		if publication != filestorage.NotPublished {
			if operation.CompletionFacts(err).Outcome == store.TransactionCommitted {
				return attachment, created, lease, &FileEffectError{Cause: err}
			}
			return model.Attachment{}, false, lease, &FileEffectError{Cause: err}
		}
		return model.Attachment{}, false, lease, err
	}
	return attachment, created, lease, nil
}

// TransferAdmission holds the target gate for one admitted transfer operation.
type TransferAdmission struct {
	service      *Attachments
	principal    model.Principal
	address      attachmentcore.Address
	contentType  string
	namespace    filestorage.TransferNamespace
	target       filestorage.TransferAttachmentTarget
	private      filestorage.TransferStorage
	publisher    filestorage.TransferAttachmentPublisher
	permit       io.Closer
	mu           sync.Mutex
	used, closed bool
	closeErr     error
}

// AdmitTransfer validates the current Task and authority once. The caller must
// hold the private permit until Close and reserve staged bytes before Put.
// Revocation after admission does not cancel the admitted identity. Publication
// still serializes with Task and Project deletion.
func (s *Attachments) AdmitTransfer(ctx context.Context, principal model.Principal, projectID, taskID, path, contentType string, namespace filestorage.TransferNamespace) (*TransferAdmission, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return nil, err
	}
	address, err := attachmentcore.NewAddress(projectID, taskID, path)
	if err != nil {
		return nil, err
	}
	if err := attachmentcore.ValidateWritePath(address.RelativePath); err != nil {
		return nil, err
	}
	if err := attachmentcore.ValidateContentType(contentType); err != nil {
		return nil, err
	}
	if err := namespace.Validate(); err != nil {
		return nil, err
	}
	private, ok := s.files.(filestorage.TransferStorage)
	if !ok {
		return nil, errors.New("private transfer storage is unavailable")
	}
	publisher, ok := s.files.(filestorage.TransferAttachmentPublisher)
	if !ok {
		return nil, errors.New("transfer attachment publication is unavailable")
	}
	target, err := filestorage.NewTransferAttachmentTarget(address.ProjectID, address.TaskID, address.RelativePath)
	if err != nil {
		return nil, err
	}
	permit, err := s.files.AcquireGate(ctx, filestorage.TargetGate, address.StoragePath)
	if err != nil {
		return nil, fmt.Errorf("acquire attachment gate: %w", err)
	}
	if err := s.mutate(ctx, principal, address, func(dao store.AttachmentMutationDAO) error {
		return attachmentcore.CheckPathConflict(ctx, dao, address)
	}); err != nil {
		return nil, errors.Join(err, permit.Close())
	}
	return &TransferAdmission{service: s, principal: principal, address: address, contentType: contentType, namespace: namespace, target: target, private: private, publisher: publisher, permit: permit}, nil
}

// Put consumes an admission at most once and leaves cleanup of staged objects
// to the owning transfer namespace.
func (a *TransferAdmission) Put(ctx context.Context, content io.Reader) (model.Attachment, bool, error) {
	return a.PutFrom(ctx, func(store.AttachmentMutationScope) (io.ReadCloser, error) { return io.NopCloser(content), nil })
}

// PutFrom constructs and closes its reader within the Task lifecycle scope. A
// transfer reader must hold its private permit and use only scope-bound receipt
// reads, avoiding a Task-to-transfer lock inversion during Project deletion.
func (a *TransferAdmission) PutFrom(ctx context.Context, source func(store.AttachmentMutationScope) (io.ReadCloser, error)) (item model.Attachment, created bool, resultErr error) {
	lease, err := a.service.AcquireUploadLease(ctx, a.principal, a.address.ProjectID, a.address.TaskID)
	if err != nil {
		return model.Attachment{}, false, err
	}
	if !RetainUploadLease(ctx, lease) {
		defer func() {
			if closeErr := lease.Close(); closeErr != nil {
				if resultErr == nil {
					resultErr = &FileEffectError{Cause: &filestorage.PublicationError{Outcome: filestorage.Published, Cause: &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionCommitted, CleanupFailed: true, Cause: closeErr}}}
				} else {
					resultErr = errors.Join(resultErr, closeErr)
				}
			}
		}()
	}
	return a.PutFromWithLease(ctx, lease, source)
}

// PutFromWithLease uses the lease already held by a multi-stage upload.
func (a *TransferAdmission) PutFromWithLease(ctx context.Context, held io.Closer, source func(store.AttachmentMutationScope) (io.ReadCloser, error)) (model.Attachment, bool, error) {
	lease, ok := held.(*uploadLease)
	user, err := model.CanonicalID(a.principal.UserID)
	if !ok || lease == nil || err != nil || lease.user != user || lease.project != a.address.ProjectID || lease.task != a.address.TaskID || lease.instance != a.service.uploadSlots {
		return model.Attachment{}, false, errors.New("invalid attachment upload lease")
	}
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.closed {
		return model.Attachment{}, false, errors.New("attachment upload lease is closed")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed || a.used {
		return model.Attachment{}, false, errors.New("transfer admission is closed or already used")
	}
	a.used = true
	object, err := uuid.NewRandom()
	if err != nil {
		return model.Attachment{}, false, fmt.Errorf("generate staged attachment ID: %w", err)
	}
	var attachment model.Attachment
	var created bool
	publication := filestorage.NotPublished
	completion, err := a.service.mutations.WriteAttachmentMutation(ctx, func(scope store.AttachmentMutationScope) error {
		presence, err := scope.LockTaskPresence(ctx, a.address.ProjectID, a.address.TaskID)
		if err != nil {
			return err
		}
		if err := scope.ProjectLive(ctx, a.address.ProjectID); err != nil {
			return projectcore.LookupError(err)
		}
		if !presence.Found {
			return taskcore.NotFound(model.ErrNotFound)
		}
		if presence.DeletedAt != nil {
			return taskcore.NotFound(model.ErrTaskDeleted)
		}
		dao := scope.AttachmentDAO()
		if err := attachmentcore.CheckPathConflict(ctx, dao, a.address); err != nil {
			return err
		}
		content, err := source(scope)
		if err != nil {
			return err
		}
		info, stageErr := a.private.PutTransfer(ctx, a.namespace, object.String(), attachmentcore.BoundedContent(content))
		closeErr := content.Close()
		if stageErr != nil || closeErr != nil {
			return fmt.Errorf("stage attachment content: %w", errors.Join(stageErr, closeErr))
		}
		if err := a.publisher.PublishTransferAttachment(ctx, a.namespace, object.String(), a.target); err != nil {
			publication = filestorage.PublicationOutcome(err)
			if errors.Is(err, filestorage.ErrPathConflict) {
				return attachmentcore.StorageConflict(err)
			}
			return fmt.Errorf("publish attachment content: %w", err)
		}
		publication = filestorage.Published
		attachment, created, err = attachmentcore.PutMetadata(ctx, dao, a.address, a.contentType, info.Size)
		if err != nil {
			return fmt.Errorf("write attachment metadata: %w", err)
		}
		return nil
	})
	if err == nil && completion.Outcome != store.TransactionCommitted {
		err = &store.TransactionError{Phase: "completion", Outcome: completion.Outcome, Cause: errors.New("attachment mutation did not commit")}
	}
	if err != nil {
		err = &filestorage.PublicationError{Outcome: publication, Cause: err}
		if publication != filestorage.NotPublished {
			err = &FileEffectError{Cause: err}
			if operation.CompletionFacts(err).Outcome == store.TransactionCommitted {
				return attachment, created, err
			}
		}
		return model.Attachment{}, false, err
	}
	return attachment, created, nil
}

func (a *TransferAdmission) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.closed {
		a.closed = true
		a.closeErr = a.permit.Close()
	}
	return a.closeErr
}

func (s *Attachments) Open(ctx context.Context, principal model.Principal, projectID, taskID, path string) (model.Attachment, filestorage.Object, error) {
	return s.open(ctx, principal, projectID, taskID, path, 0)
}

// OpenBounded checks the metadata limit in the same target gate as the stable file open.
func (s *Attachments) OpenBounded(ctx context.Context, principal model.Principal, projectID, taskID, path string, maxContentTypeBytes int) (model.Attachment, filestorage.Object, error) {
	if maxContentTypeBytes < 1 {
		return model.Attachment{}, filestorage.Object{}, &model.Fault{Code: "invalid_input", Message: "Metadata limit must be positive."}
	}
	return s.open(ctx, principal, projectID, taskID, path, maxContentTypeBytes)
}

func (s *Attachments) open(ctx context.Context, principal model.Principal, projectID, taskID, path string, maxContentTypeBytes int) (model.Attachment, filestorage.Object, error) {
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
		if maxContentTypeBytes > 0 {
			attachment, err = attachmentcore.MetadataBounded(ctx, reader, address, maxContentTypeBytes)
		} else {
			attachment, err = attachmentcore.Metadata(ctx, reader, address)
		}
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
		return &FileEffectError{Cause: err}
	}
	return err
}

func (s *Attachments) List(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest) (attachmentcore.Page, error) {
	return s.list(ctx, principal, projectID, taskID, request, 0, 0)
}

// ListBounded omits oversized path or content type fields and marks those rows.
// It avoids materializing unbounded metadata before an adapter's output limit.
func (s *Attachments) ListBounded(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest, maxPathBytes, maxFieldBytes int) (attachmentcore.Page, error) {
	if maxPathBytes < 1 || maxFieldBytes < 1 {
		return attachmentcore.Page{}, &model.Fault{Code: "invalid_input", Message: "Field limit must be positive."}
	}
	return s.list(ctx, principal, projectID, taskID, request, maxPathBytes, maxFieldBytes)
}

func (s *Attachments) list(ctx context.Context, principal model.Principal, projectID, taskID string, request model.PageRequest, maxPathBytes, maxFieldBytes int) (attachmentcore.Page, error) {
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
	query.MaxPathBytes = maxPathBytes
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
