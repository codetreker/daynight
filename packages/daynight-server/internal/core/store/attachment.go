package store

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type AttachmentQuery struct {
	After *string
	Limit int
}

type AttachmentPage struct {
	Items   []model.Attachment
	HasMore bool
}
