package filestorage

import (
	"context"
	"fmt"
	"io"

	"github.com/google/uuid"
)

// TransferNamespace addresses the private files owned by one persisted transfer.
// Its zero value is invalid. The UUID is the same key used with PrivateGate.
type TransferNamespace struct{ id string }

func NewTransferNamespace(id string) (TransferNamespace, error) {
	n := TransferNamespace{id: id}
	return n, n.Validate()
}

func (n TransferNamespace) Validate() error { return validateTransferUUID(n.id) }

func (n TransferNamespace) ID() string { return n.id }

// Directory is empty for an invalid namespace.
func (n TransferNamespace) Directory() string {
	if n.Validate() != nil {
		return ""
	}
	return n.id[:2] + "/" + n.id
}

func (n TransferNamespace) ObjectPath(objectID string) (string, error) {
	if err := n.Validate(); err != nil {
		return "", err
	}
	if err := validateTransferUUID(objectID); err != nil {
		return "", err
	}
	return n.Directory() + "/" + objectID, nil
}

func validateTransferUUID(value string) error {
	id, err := uuid.Parse(value)
	if err != nil || id == uuid.Nil || id.String() != value {
		return fmt.Errorf("%w: transfer IDs must be nonzero canonical UUIDs", ErrInvalidAddress)
	}
	return nil
}

// TransferStorage provides private objects and restricted namespace cleanup.
// The lifecycle owner must first persist the transfer record and hold the
// PrivateGate permit for namespace.ID() across every operation, including the
// entire lifetime of an opened reader. Cleanup requires the same permit after
// durable admission closure and must not infer quiescence from a DB lease.
type TransferStorage interface {
	// AvailableTransferBytes is a point-in-time estimate, not a reservation.
	AvailableTransferBytes(context.Context) (int64, error)
	PutTransfer(context.Context, TransferNamespace, string, io.Reader) (FileInfo, error)
	OpenTransfer(context.Context, TransferNamespace, string) (Object, error)
	// OpenTransferRange returns up to length bytes from offset; Info.Size is the
	// whole object's size. An offset past EOF yields an empty reader.
	OpenTransferRange(context.Context, TransferNamespace, string, int64, int64) (Object, error)
	DeleteTransferNamespace(context.Context, TransferNamespace) error
}

// TransferAttachmentTarget identifies an attachment address without allowing a
// transfer publisher to select an arbitrary storage namespace.
type TransferAttachmentTarget struct{ path string }

func NewTransferAttachmentTarget(projectID, taskID, relativePath string) (TransferAttachmentTarget, error) {
	if err := validateTransferUUID(projectID); err != nil {
		return TransferAttachmentTarget{}, err
	}
	if err := validateTransferUUID(taskID); err != nil {
		return TransferAttachmentTarget{}, err
	}
	if err := ValidateAddress("task-attachments", relativePath); err != nil {
		return TransferAttachmentTarget{}, err
	}
	return TransferAttachmentTarget{path: projectID + "/" + taskID[:2] + "/" + taskID + "/" + relativePath}, nil
}

func (t TransferAttachmentTarget) Path() string { return t.path }

// TransferAttachmentPublisher atomically moves a staged transfer object into
// an attachment target. The caller holds the private and target gates for the
// entire operation. Any error can follow publication and is not a rollback.
type TransferAttachmentPublisher interface {
	PublishTransferAttachment(context.Context, TransferNamespace, string, TransferAttachmentTarget) error
}
