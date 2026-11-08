package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AttachmentReader interface {
	Attachment(context.Context, string, string, string) (model.Attachment, error)
	AttachmentBounded(context.Context, string, string, string, int) (model.Attachment, bool, error)
	Attachments(context.Context, string, string, AttachmentQuery) (AttachmentPage, error)
	AttachmentPathConflict(context.Context, string, string, AttachmentConflictQuery) (bool, error)
}

type AttachmentConflictQuery struct {
	Ancestors        []string
	DescendantPrefix string
}
