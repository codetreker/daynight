package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// AttachmentWriter writes ordinary attachment metadata independently of file storage.
type AttachmentWriter interface {
	PutAttachment(context.Context, model.Attachment) (model.Attachment, bool, error)
	DeleteAttachment(context.Context, string, string, string) error
}
