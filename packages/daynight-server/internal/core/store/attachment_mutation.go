package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// AttachmentMutationWriter keeps the Task lock and metadata operations in one
// transaction. Scope and DAO values are valid only during the callback.
type AttachmentMutationWriter interface {
	WriteAttachmentMutation(context.Context, func(AttachmentMutationScope) error) (Completion, error)
}

type AttachmentMutationScope interface {
	LockTaskPresence(context.Context, string, string) (TaskPresence, error)
	// ProjectAuthorization observes current access after the Task lock, without
	// retaining authorization source locks across the admitted file operation.
	ProjectAuthorization(context.Context, model.Principal, string) (model.ProjectAccess, error)
	AttachmentDAO() AttachmentMutationDAO
}

type AttachmentMutationDAO interface {
	AttachmentReader
	AttachmentWriter
}
